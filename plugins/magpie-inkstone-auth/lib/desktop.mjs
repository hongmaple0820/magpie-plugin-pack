/**
 * 从本机「书生·端砚」桌面客户端读已登录的 uaa JWT（Windows）。
 *
 * Chromium os_crypt v10：Local State 里 DPAPI 包裹的 AES-256 key +
 * credential_*.bin（"v10" + 12B nonce + AES-GCM 密文 + 16B tag）。
 * 分两步：系统自带 powershell.exe (5.1) 用 -EncodedCommand 只解 DPAPI；
 * Bun/Node 用 node:crypto 做 AES-256-GCM —— 不依赖 pwsh (PowerShell 7)、
 * AesGcm、.ps1 文件与执行策略，也不需要联网 / 扫码。
 * magpie 宿主是 Bun，支持 node: 模块（文档也允许插件用 child_process）。
 */
import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CRED_NAME = /^credential_[0-9a-f-]{36}\.bin$/;

export function defaultDataDir() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "inkstone-desktop",
  );
}

/** 取最新的 credential_<uuid>.bin；没有返回 null。 */
export function findCredentialFile(dataDir = defaultDataDir()) {
  const dir = path.join(dataDir, "credentials");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const rows = names
    .filter((name) => CRED_NAME.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((row) => row && Number.isFinite(row.mtimeMs));
  if (!rows.length) return null;
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return rows.at(-1).file;
}

/** 纯函数：解 v10 记录，返回明文 JSON。测试可直接喂造出来的记录。 */
export function decryptCredential(buffer, key) {
  const rec = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (rec.length < 35 || rec[0] !== 0x76 || rec[1] !== 0x31 || rec[2] !== 0x30) {
    throw new Error("端砚客户端凭据不是 v10 记录");
  }
  if (!key || key.length !== 32) throw new Error("os_crypt AES key 长度不对");
  const nonce = rec.subarray(3, 15);
  const tag = rec.subarray(rec.length - 16);
  const ct = rec.subarray(15, rec.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/** 纯函数：解密后的 JSON → 登录信息。 */
export function parseDesktopCredential(value) {
  const json = typeof value === "string" ? JSON.parse(value) : value;
  const cred = json?.credential;
  const jwt = String(cred?.token ?? "").trim();
  const uid = String(cred?.user?.ssoUid ?? cred?.user?.uid ?? "").trim();
  if (!jwt || !uid) throw new Error("端砚客户端凭据格式无法识别");
  return {
    jwt,
    uid,
    username: String(cred?.user?.username ?? "").trim() || uid,
    expiresAtMs: Number(cred?.expiresAtMs) || 0,
  };
}

function dpapiKey(localState, { signal } = {}) {
  // 用 -EncodedCommand 把脚本直接交给 PowerShell：不受执行策略限制，
  // 路径含空格也不用引号转义，无需随包携带 .ps1 文件。
  const p = String(localState).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    `$LocalState = '${p}'`,
    "if (-not (Test-Path -LiteralPath $LocalState)) { throw 'missing Local State' }",
    "$ls = Get-Content -LiteralPath $LocalState -Raw | ConvertFrom-Json",
    "$keyWrap = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)",
    "if ($keyWrap.Length -lt 8 -or $keyWrap[0] -ne 0x44 -or $keyWrap[1] -ne 0x50 -or $keyWrap[2] -ne 0x41) { throw 'os_crypt key is not DPAPI-wrapped' }",
    "$plainKey = [System.Security.Cryptography.ProtectedData]::Unprotect([array]$keyWrap[5..($keyWrap.Length - 1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "if ($plainKey.Length -ne 32) { throw 'os_crypt key length is not 32' }",
    "[Convert]::ToBase64String($plainKey)",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    });
    const outChunks = [];
    const errChunks = [];
    const decode = (chunks) => {
      const buf = Buffer.concat(chunks);
      try {
        return new TextDecoder("gbk").decode(buf); // Windows 中文控制台是 GBK
      } catch {
        return buf.toString("utf8");
      }
    };
    child.stdout.on("data", (chunk) => outChunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.on("error", (error) => reject(new Error(`无法运行 powershell.exe：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`DPAPI 解包失败 (exit ${code}): ${decode(errChunks).slice(0, 1000)}`));
      else resolve(Buffer.from(decode(outChunks).trim(), "base64"));
    });
    if (signal) signal.addEventListener("abort", () => child.kill(), { once: true });
  });
}

/**
 * 读本机端砚客户端登录态。
 * keyRunner 可注入（测试用），默认跑 powershell.exe 解 DPAPI。
 */
export async function readDesktopCredential({ signal, dataDir = defaultDataDir(), keyRunner } = {}) {
  if (process.platform !== "win32") throw new Error("本机凭据导入只支持 Windows");
  const file = findCredentialFile(dataDir);
  if (!file) throw new Error("未找到端砚客户端的登录凭据，请先在端砚桌面客户端登录一次");
  const localState = path.join(dataDir, "Local State");
  if (!fs.existsSync(localState)) throw new Error("端砚客户端缺少 Local State，请在客户端里重新登录");
  const key = keyRunner ? await keyRunner(localState) : await dpapiKey(localState, { signal });
  return parseDesktopCredential(decryptCredential(fs.readFileSync(file), key));
}
