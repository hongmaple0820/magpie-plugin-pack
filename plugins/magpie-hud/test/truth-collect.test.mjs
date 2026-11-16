import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { resetTruthCache, sessionTruth } from "../lib/truth/collect.mjs";

const dir = mkdtempSync(join(tmpdir(), "hud-collect-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const line = (ev) => Buffer.from(JSON.stringify(ev) + "\n");
const frame = (events) => zstdCompressSync(Buffer.concat(events.map(line)));
let n = 0;
const file = () => join(dir, `s-${++n}.v4.jsonl.zstd`);

const session = { type: "session", version: 4, id: "s-1", cwd: "/p" };

test("reads a window, reports evidence, and maps phases to HUD states", () => {
  resetTruthCache();
  const f = file();
  // time 用「现在」：working 的时效判定（stale-working）要求 lastEventAt 距
  // now 在 10 分钟内，否则降级 idle。测试事件的时间戳必须落在窗口内。
  const now = Date.now();
  writeFileSync(f, frame([session, { type: "turn/start", seq: 1, time: now, data: { turn: 1 } }]));
  const t = sessionTruth(f);
  assert.equal(t.phase, "working");
  assert.equal(t.state, "running");
  assert.equal(t.evidence.mode, "events");
  assert.equal(t.evidence.rule, "turn-open");
  assert.equal(t.evidence.seq, 1);
});

test("a stale working session (no writes for 10+ minutes) shows idle, not running", () => {
  resetTruthCache();
  const f = file();
  // 24 天前的 user-input-pending-turn：事件真值说 working，但 24 天没写盘——
  // 它不是在跑，是死在起跑线上。显示 idle，rule 标 stale-working。
  const old = Date.now() - 24 * 24 * 3600_000;
  writeFileSync(f, frame([session, { type: "user/message", seq: 1, time: old, data: { source: { kind: "user" } } }]));
  const t = sessionTruth(f);
  assert.equal(t.phase, "working");
  assert.equal(t.state, "idle");
  assert.equal(t.rule, "stale-working");
});

test("an appended question card turns into waiting without re-reading the file", () => {
  resetTruthCache();
  const f = file();
  writeFileSync(f, frame([session, { type: "turn/start", seq: 1, time: 10, data: { turn: 1 } }]));
  const before = sessionTruth(f);
  assert.equal(before.phase, "working");

  appendFileSync(
    f,
    frame([
      { type: "tool/call", seq: 2, time: 20, data: { turn: 1, step: 1, callId: "c1", name: "ask_user" } },
      { type: "tool/result", seq: 3, time: 30, data: { message: { role: "tool", source: { kind: "tool", callId: "c1" }, content: [], isError: false } } },
    ])
  );
  const after = sessionTruth(f);
  assert.equal(after.phase, "waiting");
  assert.equal(after.waiting.kind, "question");
  assert.equal(after.waiting.toolName, "ask_user");
  assert.equal(after.waiting.since, 20);
  assert.equal(after.lastSeq, 3);
  // 增量没有重读窗口：起点字节与上次一致。
  assert.equal(after.evidence.bytes.offset, before.evidence.bytes.offset);
  assert.ok(after.evidence.bytes.size > before.evidence.bytes.size);
});

test("a file that cannot be decoded is unknown, never idle", () => {
  resetTruthCache();
  const f = file();
  writeFileSync(f, Buffer.from("this is not a transcript\x00\x01\x02", "utf8"));
  const t = sessionTruth(f);
  assert.equal(t.phase, "unknown");
  assert.equal(t.state, "unknown");
  assert.match(t.unknown.reason, /^decode:/);
});

test("same size and mtime reuses the memo (no work)", () => {
  resetTruthCache();
  const f = file();
  writeFileSync(f, frame([session, { type: "turn/start", seq: 1, time: 10, data: { turn: 1 } }]));
  const a = sessionTruth(f);
  const b = sessionTruth(f);
  assert.equal(a, b, "同一份快照应原样复用");
});
