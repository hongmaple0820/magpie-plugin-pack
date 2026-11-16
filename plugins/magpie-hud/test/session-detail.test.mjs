import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hud-detail-"));
process.env.MAGPIE_AGENTS_HOME = home;
process.env.XDG_CONFIG_HOME = "";

// 造一个 claude 会话转录 + 一个 journal（含与它的来回）
const proj = join(home, ".claude", "projects", "F--demo");
mkdirSync(proj, { recursive: true });
const transcript = join(proj, "sess-1.jsonl");
writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n");

const agentsDir = join(home, ".magpie-agents");
mkdirSync(agentsDir, { recursive: true });
const now = Date.now();
writeFileSync(join(agentsDir, "journal.json"), JSON.stringify({ messages: [
  { id: "m1", kind: "send", chain: "m1", count: 1, from: { client: "human", sessionId: "", title: "你" }, to: { client: "claude", sessionId: "sess-1", title: "hello" }, form: "labelled", sentAtMs: now - 60_000, fingerprint: "aa", state: "done", reason: null, answered: false, repliedBy: null },
  { id: "m2", kind: "send", chain: "m1", count: 2, from: { client: "claude", sessionId: "sess-1", title: "hello" }, to: { client: "human", sessionId: "", title: "你" }, form: "labelled", sentAtMs: now - 30_000, fingerprint: "bb", state: "queued", reason: null, answered: false, repliedBy: null },
  { id: "m3", kind: "send", chain: "m3", count: 1, from: { client: "human", sessionId: "", title: "你" }, to: { client: "claude", sessionId: "other", title: "x" }, form: "labelled", sentAtMs: now - 10_000, fingerprint: "cc", state: "done", reason: null, answered: false, repliedBy: null },
] }));
// token 缓存：文件名对应转录
const hour = Math.floor((now - 3_600_000) / 3_600_000) * 3_600_000;
writeFileSync(join(agentsDir, "tokens-cache.json"), JSON.stringify({ version: 1, files: {
  [transcript]: { mtimeMs: now, size: 1, hours: { [String(hour)]: [1000, 200, 50, {}] } },
} }));

const { sessionDetail } = await import("../lib/session-detail.mjs");

test("returns the session with its message thread in order", async () => {
  const d = await sessionDetail("sess-1");
  assert.ok(d, "会话应存在");
  assert.equal(d.session.client, "claude");
  assert.equal(d.messages.length, 2, "只算与 sess-1 相关的两条");
  assert.equal(d.messages[0].id, "m1");
  assert.equal(d.messages[0].direction, "out", "发给它的算 out");
  assert.equal(d.messages[1].direction, "in", "它发出的算 in");
  assert.ok(d.messages[0].at <= d.messages[1].at, "按时间正序");
});

test("includes this session's token buckets from the cache", async () => {
  const d = await sessionDetail("sess-1", 24);
  assert.ok(d.tokens, "应取到 token 时序");
  assert.equal(d.tokens.buckets.length, 1);
  assert.equal(d.tokens.totals.in, 1000);
  assert.equal(d.tokens.totals.out, 200);
});

test("an unknown session is null, not a throw", async () => {
  assert.equal(await sessionDetail("nope"), null);
});

test("a session without cache entry still returns, tokens null", async () => {
  const p2 = join(home, ".claude", "projects", "F--demo2");
  mkdirSync(p2, { recursive: true });
  writeFileSync(join(p2, "sess-2.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "no tokens" } }) + "\n");
  const d = await sessionDetail("sess-2");
  assert.ok(d);
  assert.equal(d.tokens, null, "没缓存就不编造");
  assert.equal(d.messages.length, 0);
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
