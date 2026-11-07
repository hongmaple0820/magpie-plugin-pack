/**
 * 本机端砚客户端凭据解密的单元测试。
 * 用 node:crypto 造一个假的 v10 记录，验证 AES-256-GCM 解密与字段解析；
 * 不依赖 PowerShell、不读真实凭据。node / bun 均可运行。
 */
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decryptCredential,
  parseDesktopCredential,
  findCredentialFile,
  readDesktopCredential,
} from "../lib/desktop.mjs";

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`✓ ${name}`);
};

const KEY = randomBytes(32);
const NONCE = randomBytes(12);
const PLAIN = JSON.stringify({
  credential: {
    token: "jwt-local-test",
    user: { ssoUid: "u-1", username: "ada" },
    expiresAtMs: 1893456000000,
  },
});

function v10Record(plain, key, nonce) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, ct, cipher.getAuthTag()]);
}

{
  const rec = v10Record(PLAIN, KEY, NONCE);
  const parsed = parseDesktopCredential(decryptCredential(rec, KEY));
  assert.equal(parsed.jwt, "jwt-local-test");
  assert.equal(parsed.uid, "u-1");
  assert.equal(parsed.username, "ada");
  assert.equal(parsed.expiresAtMs, 1893456000000);
  assert.throws(() => decryptCredential(rec, randomBytes(32)), "错的 AES key 必须被 GCM tag 拒绝");
  assert.throws(() => decryptCredential(Buffer.from("not a v10 record"), KEY));
  ok("v10 记录：AES-256-GCM 解密 + 字段解析 + 错 key / 坏记录拒绝");
}

if (process.platform === "win32") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkstone-desktop-test-"));
  try {
    fs.mkdirSync(path.join(tmp, "credentials"));
    fs.writeFileSync(path.join(tmp, "Local State"), "{}");
    fs.writeFileSync(
      path.join(tmp, "credentials", "credential_42a0e390-546c-44aa-99f0-6a69e9216e3c.bin"),
      v10Record(PLAIN, KEY, NONCE),
    );
    assert.ok(findCredentialFile(tmp));
    assert.equal(findCredentialFile(path.join(tmp, "missing")), null);
    // 注入 keyRunner，跳过真的 powershell.exe 调用
    const cred = await readDesktopCredential({ dataDir: tmp, keyRunner: async () => KEY });
    assert.equal(cred.uid, "u-1");
    assert.equal(cred.jwt, "jwt-local-test");
    ok("临时凭据目录：找到最新 .bin + 注入 key 完成导入");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  ok("非 Windows：跳过本机凭据目录用例（纯解密已验证）");
}

console.log(`\ndesktop.test: ${passed} 组通过`);
