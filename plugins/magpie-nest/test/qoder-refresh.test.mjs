import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshDevice } from "../lib/qoder/login.mjs";
import { REGIONS } from "../lib/qoder/constants.mjs";

// 设备 token 续期必须带 machine_id（对齐 ChatLink oauth/adapters/qoder.ts:406：
// body 是 {refresh_token, machine_id}，且 machine_id 缺失时 ChatLink 直接判不可续期）。
// 登录 authorize 用 machine_id 绑定设备身份（login.mjs:139），续期不回传会被
// 网关当成另一台设备 —— 与 GLM 刷新缺签名头同一类问题。

function captureFetch(captured) {
  return async (url, init) => {
    captured.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(
      JSON.stringify({ token: "t2", refresh_token: "r2", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

test("device refresh carries machine_id when the account has one", async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = captureFetch(captured);
  try {
    const out = await refreshDevice(REGIONS["qoder-cn"], "r1", true, "machine-abc");
    assert.equal(out.token, "t2");
    assert.equal(out.refresh, "r2");
    assert.equal(captured.length, 1);
    assert.ok(captured[0].url.includes("/api/v1/deviceToken/refresh"), "hits the device refresh path");
    assert.equal(captured[0].body.refresh_token, "r1");
    assert.equal(captured[0].body.machine_id, "machine-abc");
  } finally {
    globalThis.fetch = original;
  }
});

test("device refresh omits machine_id for legacy accounts without one", async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = captureFetch(captured);
  try {
    await refreshDevice(REGIONS["qoder-cn"], "r1", true);
    assert.equal(captured[0].body.refresh_token, "r1");
    assert.equal(captured[0].body.machine_id, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("device refresh without a refresh token raises a sign-in-gone", async () => {
  await assert.rejects(
    () => refreshDevice(REGIONS["qoder-cn"], "", true),
    /sign-in lapsed|sign in again/i,
  );
});
