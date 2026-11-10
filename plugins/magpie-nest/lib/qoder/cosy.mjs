// COSY 信封签名 + 请求体编解码。
//
// 逐行移植自社区实现 index.mjs:76-218（cosyHeaders / userBlob / machineOS /
// machineHostname / chatHeaders / segmentEncode / swapThirds / decodeBody）。
// 协议要点：
//   - Authorization = "Bearer COSY.<payload>.<md5sig>"；
//   - 账号 blob AES-128-CBC（key 即 IV），key 用 Qoder 内嵌 RSA 公钥包装；
//   - 请求体先 segmentEncode（自定义 base64 字母表 + '$' 补齐）再 swapThirds；
//   - 响应体是普通 JSON/SSE，不需要反向解码。

import { createCipheriv, createHash, publicEncrypt, randomUUID, constants } from "node:crypto";
import { hostname } from "node:os";
import { domainToASCII } from "node:url";
import { COSY_VERSION, RSA_KEY } from "./constants.mjs";

const hexID = () => randomUUID().replaceAll("-", "");

export function machineOS(arch = process.arch, platform = process.platform) {
  return ({ x64: "x86_64", arm64: "aarch64" }[arch] ?? arch) + "_" + platform;
}

const HOST_SAFE = /^[!-~](?:[ -~]*[!-~])?$/u;

export function machineHostname(name = hostname()) {
  const hash = (v) => createHash("sha256").update(v, "utf8").digest("hex").slice(0, 8);
  const cap = (v) => {
    if (v.length <= 96) return v;
    const head = v.slice(0, 96 - 8 - 1).replace(/[-s]+$/u, "");
    return head ? `${head}-${hash(v)}` : `unknown-${hash(v)}`;
  };
  const v = String(name ?? "").trim();
  if (!v) return "";
  if (HOST_SAFE.test(v)) return cap(v);
  const ascii = domainToASCII(v);
  if (ascii && HOST_SAFE.test(ascii)) return cap(ascii);
  const safe = v.replace(/[^!-~]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return cap(safe ? `${safe}-${hash(v)}` : `unknown-${hash(v)}`);
}

function userBlob(u, rsaKey = RSA_KEY) {
  const raw = JSON.stringify({ uid: u.uid, aid: "", name: u.name ?? "", email: u.email ?? "", security_oauth_token: u.access });
  const key = Buffer.from(hexID().slice(0, 16));
  const c = createCipheriv("aes-128-cbc", key, key);
  const info = Buffer.concat([c.update(raw, "utf8"), c.final()]).toString("base64");
  const wrapped = publicEncrypt({ key: rsaKey, padding: constants.RSA_PKCS1_PADDING }, key).toString("base64");
  return { info, key: wrapped };
}

export function cosyHeaders(url, u, body, site, ts = Math.floor(Date.now() / 1000)) {
  if (!u?.machineId) throw new Error(`${site?.name ?? "Qoder"}: the account has no machine id; sign in again`);
  const cosyVersion = COSY_VERSION;
  const blob = userBlob(u, site?.rsaKey);
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: randomUUID(), info: blob.info, cosyVersion, ideVersion: "" }),
  ).toString("base64");
  let path = new URL(url).pathname;
  if (path.startsWith("/algo")) path = path.slice(5);
  const sig = createHash("md5").update(`${payload}
${blob.key}
${ts}
${body}
${path}`).digest("hex");
  const m = u.machineId;
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": site?.businessProduct ?? "app",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientIp": m,
    "Cosy-ClientType": site?.clientType ?? "10",
    "Cosy-Data-Policy": "disagree",
    "Cosy-Date": String(ts),
    "Cosy-Key": blob.key,
    "Cosy-MachineId": m,
    "Cosy-MachineToken": m,
    "Cosy-MachineType": "5",
    "Cosy-MachineOS": machineOS(),
    "Cosy-Scene": site?.modelScene ?? "app",
    "Cosy-User": u.uid,
    "Cosy-Version": cosyVersion,
    "Login-Version": "v2",
  };
}

// chat 端点头部与普通 cosy 调用的差异（社区 index.mjs:165-174）：
// 无 Cosy-ClientIp / Cosy-MachineToken / Cosy-MachineType，带上主机名与
// X-Model-Key / X-Model-Source，Accept 换成 text/event-stream。
export function chatHeaders(url, u, body, site, model, identity = {}) {
  const h = cosyHeaders(url, u, body, site);
  delete h["Cosy-ClientIp"];
  delete h["Cosy-MachineToken"];
  delete h["Cosy-MachineType"];
  for (const key of ["Cosy-MachineToken", "Cosy-MachineType"]) if (identity[key]) h[key] = identity[key];
  const host = machineHostname();
  if (host) h["Cosy-MachineHostname"] = host;
  return { ...h, Accept: "text/event-stream", "Cache-Control": "no-cache", "X-Model-Key": model.key, "X-Model-Source": model.source };
}

const ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

function segmentEncode(bytes) {
  let s = "";
  let acc = 0;
  let nb = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff;
    nb += 8;
    while (nb >= 6) {
      nb -= 6;
      s += ALPHABET[(acc >> nb) & 63];
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63];
  while (s.length % 4) s += "$";
  return s;
}

function swapThirds(s) {
  const t = Math.floor(s.length / 3);
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s;
}

export const encodeBody = (text) => swapThirds(segmentEncode(Buffer.from(text, "utf8")));

export function decodeBody(wire) {
  const s = swapThirds(wire);
  const out = [];
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== "$").map((c) => ALPHABET.indexOf(c));
    let x = 0;
    for (const v of vals) x = x * 64 + v;
    const n = Math.floor((6 * vals.length) / 8);
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255);
  }
  return Buffer.from(out).toString("utf8");
}
