// 客户端描述符（v7 §5 P1）：状态来源、能不能被证伪、在线证据——三件事只在 lib/clients.mjs 声明一次。
// 这里钉的是表本身与 presence 的语义，不碰各家扫描器（那些在 tools.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENTS, clientOf, presenceOf, PRESENCE_FRESH_MS } from "../lib/clients.mjs";

test("每个客户端都说清状态从哪来、能不能被证伪", () => {
  for (const [id, c] of Object.entries(CLIENTS)) {
    assert.equal(c.id, id);
    assert.ok(["events", "registry", "mtime", "none"].includes(c.stateSource), id + " 的 stateSource 不合法");
    assert.equal(typeof c.verified, "boolean", id + " 的 verified 必须是布尔");
    // 只有事件源能对 phase 负责。registry（签到）证明进程活着，mtime 证明最近写过——
    // 两者都不配说 running/idle，所以 verified 必须是 false。这条是「不静默降级」的根。
    assert.equal(c.verified, c.stateSource === "events", id + " 的 verified 与 stateSource 矛盾");
    assert.ok(["evidence", "online", "approx"].includes(c.badge), id + " 的 badge 不在三档里");
  }
  assert.equal(clientOf("claude").name, "Claude Code");
  assert.equal(clientOf("nope"), null);
});

test("presence 只回答在不在线，不回答在不在跑", () => {
  const now = Date.now();
  const fresh = presenceOf("claude", now - 1000, now);
  assert.equal(fresh.presence, "online");
  assert.match(fresh.reason, /签到/);

  const stale = presenceOf("claude", now - PRESENCE_FRESH_MS - 1, now);
  assert.equal(stale.presence, "offline");
  assert.match(stale.reason, /过期/);

  assert.equal(presenceOf("claude", null, now).presence, "offline", "从没签过到就是离线");

  // 没有签到通道的客户端一律 null：不拿 mtime 冒充在线。
  for (const id of ["dsh", "codex", "antigravity", "nope"]) {
    assert.equal(presenceOf(id, now, now).presence, null, id + " 不该有 presence");
  }
});
