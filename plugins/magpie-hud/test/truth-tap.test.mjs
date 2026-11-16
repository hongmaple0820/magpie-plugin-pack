// tap：第二证据源。它必须能被独立读、能在半行/滚动时守住边界，
// 并且仲裁规则只有三条：tap 新 → 信 tap；同 seq 同结论 → both；
// 同 seq 不同结论 → unknown（两份证据打架时不替它们猜）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTap, readTapFrom, tapPath } from "../lib/truth/tap.mjs";
import { resetTruthCache, sessionTruth } from "../lib/truth/collect.mjs";
import { frameCandidates, MAGIC } from "../lib/truth/frames.mjs";
import { zstdCompressSync } from "node:zlib";
import { start } from "../dsh/magpie-hud.mjs";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "magpie-tap-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const line = (row) => JSON.stringify(row) + "\n";

test("tapPath 只接受安全 id，拒绝路径穿越", () => {
  assert.equal(tapPath("C:/x", "abc-1"), join("C:/x", "abc-1.jsonl"));
  assert.equal(tapPath("C:/x", "../evil"), null);
  assert.equal(tapPath("C:/x", ""), null);
  assert.equal(tapPath(null, "abc"), null);
});

test("readTap：坏行计数、尾部半行不算事件", () => {
  const t = tmp();
  try {
    const file = join(t.dir, "s.jsonl");
    writeFileSync(file, line({ type: "session", seq: 1, time: 1, data: { id: "s" } }) + "{not json\n" + line({ type: "turn/start", seq: 2, time: 2, data: { turn: 1 } }) + '{"type":"turn/end","seq":3');
    const r = readTap(file);
    assert.equal(r.exists, true);
    assert.equal(r.events.length, 2);
    assert.equal(r.badLines, 1);
    assert.equal(r.lastSeq, 2);
  } finally {
    t.done();
  }
});

test("readTapFrom：只读新增部分，半行留到下次", () => {
  const t = tmp();
  try {
    const file = join(t.dir, "s.jsonl");
    writeFileSync(file, line({ type: "session", seq: 1, time: 1, data: {} }));
    const a = readTapFrom(file, 0);
    assert.equal(a.events.length, 1);
    appendFileSync(file, line({ type: "turn/start", seq: 2, time: 2, data: { turn: 1 } }) + '{"type":"turn/e');
    const b = readTapFrom(file, a.next);
    assert.equal(b.events.length, 1);
    assert.equal(b.events[0].seq, 2);
    // 半行没被消费：把剩下的半个补上，再写一条完整行，从 b.next 读到的应是两条。
    appendFileSync(file, 'nd","seq":3,"time":3,"data":{"turn":1,"reason":{"kind":"stop"}}}\n');
    appendFileSync(file, line({ type: "turn/start", seq: 4, time: 4, data: { turn: 2 } }));
    const rest = readTapFrom(file, b.next);
    assert.equal(rest.events.length, 2);
    assert.deepEqual(rest.events.map((e) => e.seq), [3, 4]);
    const full = readTap(file);
    assert.equal(full.badLines, 0);
    assert.equal(full.lastSeq, 4);
  } finally {
    t.done();
  }
});

test("仲裁：tap 更新时用 tap 的结论", () => {
  const t = tmp();
  try {
    const sessions = join(t.dir, "sessions", "proj", "sess-1");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "session.v4.jsonl.zstd");
    const events = [
      { type: "session", seq: 0, time: 1, data: { id: "sess-1", cwd: "/x" } },
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
    ];
    writeFileSync(file, zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e) + "\n").join(""))));
    mkdirSync(join(t.dir, "tap"), { recursive: true });
    const tapFile = join(t.dir, "tap", "sess-1.jsonl");
    writeFileSync(
      tapFile,
      [
        { type: "session", seq: 0, time: 1, data: { id: "sess-1", cwd: "/x" } },
        { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
        { type: "approval/asked", seq: 2, time: 3, data: { id: "a1", toolName: "bash", callId: "c1", reason: "rm" } },
      ]
        .map(line)
        .join(""),
    );
    resetTruthCache();
    const r = sessionTruth(file, undefined, { tapDir: join(t.dir, "tap") });
    assert.equal(r.phase, "waiting");
    assert.equal(r.waiting.toolName, "bash");
    assert.equal(r.evidence.mode, "tap");
    assert.equal(r.evidence.cross.mode, "transcript");
    assert.equal(r.lastSeq, 2);
  } finally {
    t.done();
  }
});

test("仲裁：同一 seq 结论一致 → mode both；不一致 → unknown", () => {
  const t = tmp();
  try {
    const sessions = join(t.dir, "sessions", "proj", "sess-2");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "session.v4.jsonl.zstd");
    const base = [
      { type: "session", seq: 0, time: 1, data: { id: "sess-2", cwd: "/x" } },
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
    ];
    writeFileSync(file, zstdCompressSync(Buffer.from(base.map((e) => JSON.stringify(e) + "\n").join(""))));
    mkdirSync(join(t.dir, "tap"), { recursive: true });
    writeFileSync(join(t.dir, "tap", "sess-2.jsonl"), base.map(line).join(""));
    resetTruthCache();
    const agree = sessionTruth(file, undefined, { tapDir: join(t.dir, "tap") });
    assert.equal(agree.evidence.mode, "both");

    // tap 说 ended，转录说 paused —— 两份证据在同一 seq 上打架。
    writeFileSync(
      join(t.dir, "tap", "sess-2.jsonl"),
      [...base, { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "stop" } } }].map(line).join(""),
    );
    // 转录仍是 2 条（tap 多一条）→ 属于「tap 更新」，不是打架；先验证它信 tap。
    const newer = sessionTruth(file, undefined, { tapDir: join(t.dir, "tap") });
    assert.equal(newer.phase, "paused");
    assert.equal(newer.evidence.mode, "tap");

    // 让转录也到 seq2 且结论不同：转录 turn/end reason=interrupted 仍是 paused；
    // 造一个真打架的场景：tap 的 seq1 是 turn/start，转录 seq1 是别的。
    const other = join(t.dir, "sessions", "proj", "sess-3");
    mkdirSync(other, { recursive: true });
    const file3 = join(other, "session.v4.jsonl.zstd");
    const tr3 = [
      { type: "session", seq: 0, time: 1, data: { id: "sess-3", cwd: "/x" } },
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
    ];
    writeFileSync(file3, zstdCompressSync(Buffer.from(tr3.map((e) => JSON.stringify(e) + "\n").join(""))));
    writeFileSync(
      join(t.dir, "tap", "sess-3.jsonl"),
      [
        { type: "session", seq: 0, time: 1, data: { id: "sess-3", cwd: "/x" } },
        { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
        { type: "approval/asked", seq: 2, time: 3, data: { id: "a9", toolName: "bash", callId: "c9", reason: "x" } },
      ]
        .map(line)
        .join(""),
    );
    // 转录追加 seq2：turn/end（paused），与 tap 的 waiting 冲突且同 seq。
    const half = zstdCompressSync(Buffer.from(JSON.stringify({ type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "stop" } } }) + "\n"));
    appendFileSync(file3, half);
    resetTruthCache();
    const clash = sessionTruth(file3, undefined, { tapDir: join(t.dir, "tap") });
    assert.equal(clash.phase, "unknown");
    assert.equal(clash.state, "unknown");
    assert.equal(clash.unknown.reason, "tap-mismatch");
    assert.equal(clash.evidence.cross.mode, "tap");
  } finally {
    t.done();
  }
});

test("DSH 插件：session/event 被抄进 tap，字段够 reducer 用", () => {
  const t = tmp();
  const channel = join(t.dir, "channel");
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect() {},
    get() {
      return null;
    },
  };
  const plugin = start(ctx, channel, { answerPollMs: 20, promptPollMs: 20, checkInMs: 1000 });
  try {
    const tap = handlers.get("session/event");
    assert.equal(typeof tap, "function");
    tap({ header: { id: "s-tap" } }, { type: "session", seq: 0, time: 10, data: { id: "s-tap", cwd: "/w" } });
    tap(
      { header: { id: "s-tap" } },
      {
        type: "tool/result",
        seq: 1,
        time: 11,
        data: { message: { source: { kind: "tool", callId: "c1" }, isError: false, content: [{ type: "text", text: "The card is on screen; the user's answer arrives as their next message." }] } },
      },
    );
    const file = join(channel, "tap", "s-tap.jsonl");
    const r = readTap(file);
    assert.equal(r.events.length, 2);
    assert.equal(r.events[1].data.message.source.callId, "c1");
    assert.match(r.events[1].data.message.content[0].text, /card is on screen/);
    // 危险 id 不落盘
    tap({ header: { id: "../evil" } }, { type: "session", seq: 0, time: 1, data: {} });
    assert.equal(readTap(join(channel, "tap", "evil.jsonl")).exists, false);
  } finally {
    plugin.stop();
    t.done();
  }
});

test("tap 投影认真实 v4 形状：正文在 data.content / inserted[].content", async () => {
  const { tapProject } = await import("../dsh/magpie-hud.mjs");
  const user = tapProject({
    type: "user/message",
    seq: 8,
    time: 100,
    data: { source: { kind: "user" }, content: [{ type: "text", text: "say OK" }] },
  });
  assert.equal(user.data.message.content[0].text, "say OK");
  assert.equal(user.data.source.kind, "user");
  const inbox = tapProject({
    type: "agent/inbox/spliced",
    seq: 3,
    time: 101,
    data: { inserted: [{ source: { kind: "user" }, content: [{ type: "text", text: "你好" }] }] },
  });
  assert.equal(inbox.data.inserted[0].message.content[0].text, "你好");
  assert.equal(inbox.data.inserted[0].source.kind, "user");
  // turn/end 的 reason 可能挂在事件顶层
  const end = tapProject({ type: "turn/end", seq: 17, time: 102, reason: { kind: "interrupted" }, data: { turn: 1 } });
  assert.equal(end.data.reason.kind, "interrupted");
});

test("frameCandidates 只在 zstd 魔数处切帧", () => {
  const a = zstdCompressSync(Buffer.from("a\n"));
  const b = zstdCompressSync(Buffer.from("b\n"));
  const buf = Buffer.concat([a, b]);
  const c = frameCandidates(buf);
  assert.equal(c.length, 2);
  assert.equal(c[0], 0);
  assert.equal(c[1], a.length);
});
