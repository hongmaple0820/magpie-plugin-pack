// 帧级读取的单元测试：用 node:zlib 现造多帧 zstd（生产代码用 fzstd 解），
// 覆盖「尾部窗口 / 增量追加 / 半帧 / seq 缺口 / 半行 carry」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  continuityBreak,
  frameCandidates,
  parseLines,
  readAll,
  readAppend,
  readWindow,
  seqSpan,
} from "../lib/truth/frames.mjs";

const dir = mkdtempSync(join(tmpdir(), "hud-frames-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const frame = (text) => Buffer.from(zstdCompressSync(Buffer.from(text, "utf8")));
const line = (o) => JSON.stringify(o) + "\n";
const ev = (seq, type, data = {}) => ({ type, seq, time: 1000 + seq, data });

function writeFrames(name, texts) {
  const file = join(dir, name);
  writeFileSync(file, Buffer.concat(texts.map(frame)));
  return file;
}

test("frameCandidates finds each concatenated frame start", () => {
  const a = frame(line(ev(0, "session", { id: "s" })));
  const b = frame(line(ev(1, "turn/start", { turn: 1 })));
  const buf = Buffer.concat([a, b]);
  assert.deepEqual(frameCandidates(buf), [0, a.length]);
});

test("readWindow decodes only the tail window and keeps seq order", () => {
  const file = writeFrames("tail.zstd", [
    line(ev(0, "session")),
    line(ev(1, "turn/start")) + line(ev(2, "tool/call")),
    line(ev(3, "tool/result")) + line(ev(4, "turn/end")),
  ]);
  const w = readWindow(file, { maxBytes: 1024 * 1024, lookback: 1 });
  assert.equal(w.error, null);
  assert.ok(w.events.length >= 2);
  const { first, last } = seqSpan(w.events);
  assert.ok(first != null && last != null);
  assert.equal(continuityBreak(w.events), -1);
  assert.equal(last, 4);
});

test("readWindow looks back to a frame that opened an approval", () => {
  const file = writeFrames("ask.zstd", [
    line(ev(0, "session")) + line(ev(1, "approval/asked", { id: "a1", toolName: "pwsh" })),
    line(ev(2, "system/message")),
    line(ev(3, "system/message")),
  ]);
  const w = readWindow(file, { maxBytes: 1024 * 1024, lookback: 3 });
  assert.equal(w.error, null);
  assert.ok(w.events.some((e) => e.type === "approval/asked" && e.data.id === "a1"));
  assert.equal(seqSpan(w.events).first, 0);
});

test("readAppend validates seq continuity against the previous read", () => {
  const f1 = line(ev(0, "session")) + line(ev(1, "turn/start"));
  const f2 = line(ev(2, "turn/end"));
  const file = writeFrames("append.zstd", [f1]);
  const first = readWindow(file, { maxBytes: 1024 * 1024 });
  const lastSeq = seqSpan(first.events).last;
  assert.equal(lastSeq, 1);
  appendFileSync(file, frame(f2));
  const next = readAppend(file, first.size, { expectedSeq: lastSeq, carry: first.carry });
  assert.equal(next.error, null);
  assert.equal(seqSpan(next.events).last, 2);
  assert.equal(next.size, first.size + frame(f2).length);
});

test("readAppend reports seq-gap instead of guessing", () => {
  const f1 = line(ev(0, "session")) + line(ev(1, "turn/start"));
  const f2 = line(ev(5, "turn/end")); // 缺口：2..4 丢了
  const file = writeFrames("gap.zstd", [f1]);
  const first = readWindow(file, { maxBytes: 1024 * 1024 });
  appendFileSync(file, frame(f2));
  const next = readAppend(file, first.size, { expectedSeq: seqSpan(first.events).last });
  assert.match(String(next.error), /^seq-gap/);
  assert.equal(next.events.length, 0);
});

test("a half-written frame yields no events until it completes", () => {
  const f1 = line(ev(0, "session"));
  const f2 = frame(line(ev(1, "turn/start")) + line(ev(2, "turn/end")));
  const file = writeFrames("half.zstd", [f1]);
  const first = readWindow(file, { maxBytes: 1024 * 1024 });
  appendFileSync(file, f2.subarray(0, Math.floor(f2.length / 2)));
  const half = readAppend(file, first.size, { expectedSeq: seqSpan(first.events).last });
  // 流式解码器对「还没写完的帧」不会报错——它只是还没解出东西。
  // 这里要保证的是「不编造事件」，而不是「必须报错」。
  assert.equal(half.events.length, 0);
  appendFileSync(file, f2.subarray(Math.floor(f2.length / 2)));
  const done = readAppend(file, half.size, { expectedSeq: seqSpan(first.events).last, carry: half.carry });
  assert.equal(done.error, null);
  assert.equal(seqSpan(done.events).last, 2);
});

test("parseLines carries a trailing half line to the next read", () => {
  const a = parseLines('{"type":"x","seq":1}\n{"type":"y"');
  assert.equal(a.events.length, 1);
  assert.equal(a.carry, '{"type":"y"');
  const b = parseLines(',"seq":2}\n', a.carry);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].type, "y");
  assert.equal(b.carry, "");
});

test("readAll works for plain jsonl and zstd alike", () => {
  const plain = join(dir, "plain.jsonl");
  writeFileSync(plain, line(ev(0, "session")) + line(ev(1, "turn/start")));
  const p = readAll(plain);
  assert.equal(p.events.length, 2);
  assert.equal(p.error, null);
  const zf = writeFrames("all.zstd", [line(ev(0, "session")), line(ev(1, "turn/start"))]);
  const z = readAll(zf);
  assert.equal(z.events.length, 2);
  assert.equal(z.error, null);
});
