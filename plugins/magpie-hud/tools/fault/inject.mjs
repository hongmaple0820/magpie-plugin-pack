#!/usr/bin/env node
// 故障注入：把真实世界会遇到的坏输入造出来，看读取层与 reducer 会不会「假装正常」。
//
// 每个用例都断言「坏输入 → 明确的降级」，而不是「不崩就算过」：
//   · 截断/腐坏/空文件 → unknown 或「只信已解出的部分」，绝不显示 running；
//   · seq 缺口/乱序 → unknown(seq-gap)；
//   · tap 半行/滚动 → 不消费半个事件、不从头重算。
//
// 输出 corpus/fault.json；任一用例失败退出码 1。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readWindow, readAll, readAppend } from "../../lib/truth/frames.mjs";
import { fold } from "../../lib/truth/fold.mjs";
import { readTapFrom } from "../../lib/truth/tap.mjs";
import { sessionTruth, resetTruthCache } from "../../lib/truth/collect.mjs";

const root = mkdtempSync(join(tmpdir(), "hud-fault-"));
const line = (e) => JSON.stringify(e) + "\n";
const ev = (seq, type, data = {}, extra = {}) => ({ type, seq, time: 1_000 + seq, data, ...extra });
const base = [ev(0, "session", {}, { id: "s-fault" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" })];
const text = (events) => events.map(line).join("");

const cases = [];
function kase(name, fn) {
  cases.push({ name, fn });
}

kase("截断的最后一帧：HUD 必须显示「未知」，不是 running/idle", () => {
  const full = zstdCompressSync(Buffer.from(text(base)));
  const cut = full.subarray(0, Math.max(1, full.length - 6));
  const file = join(root, "truncated.jsonl.zstd");
  writeFileSync(file, cut);
  resetTruthCache();
  // 走 collect 而不是直接 fold：要验的是「HUD 最终显示什么」，包括 phase→state 映射。
  const s = sessionTruth(file, undefined, { tapDir: false });
  if (s.state !== "unknown") throw new Error(`截断文件被显示成 ${s.state}（phase=${s.phase}），应 unknown`);
  return { state: s.state, reason: s.unknown?.reason ?? null };
});

kase("中间帧腐坏：要么 unknown，要么 working 但必须标明只读到窗口的一部分", () => {
  const first = zstdCompressSync(Buffer.from(text(base)));
  const second = zstdCompressSync(Buffer.from(text([ev(3, "tool/result", { message: { source: { callId: "c1" }, content: [] } })])));
  const bad = Buffer.from(second);
  for (let i = 4; i < Math.min(bad.length, 24); i++) bad[i] ^= 0xff;
  const file = join(root, "corrupt.jsonl.zstd");
  writeFileSync(file, Buffer.concat([first, bad]));
  resetTruthCache();
  const s = sessionTruth(file, undefined, { tapDir: false });
  // 前缀能解、后缀腐坏时允许给出 working（前缀是真实事件），但必须让读者知道窗口不完整。
  if (s.state !== "unknown" && s.evidence?.truncated !== true) {
    throw new Error(`腐坏文件被当成完整证据：state=${s.state} truncated=${s.evidence?.truncated}`);
  }
  return { state: s.state, truncated: s.evidence?.truncated ?? null };
});

kase("空 zstd 文件：显示「未知」，不是 idle", () => {
  const file = join(root, "empty.jsonl.zstd");
  writeFileSync(file, zstdCompressSync(Buffer.from("")));
  resetTruthCache();
  const s = sessionTruth(file, undefined, { tapDir: false });
  if (s.state !== "unknown") throw new Error(`空文件被显示成 ${s.state}`);
  return { state: s.state, reason: s.unknown?.reason ?? null };
});

kase("seq 缺口：unknown(seq-gap)", () => {
  const file = join(root, "gap.jsonl");
  writeFileSync(file, text([ev(0, "session", {}, { id: "s" }), ev(2, "turn/start", { turn: 1 })]));
  const s = fold(readAll(file).events);
  if (s.phase !== "unknown" || !/^seq-gap:/.test(s.unknown?.reason ?? "")) throw new Error("缺口没被抓住: " + s.phase + " " + s.unknown?.reason);
  return { reason: s.unknown.reason };
});

kase("乱序事件：unknown(seq-gap)，不静默重排", () => {
  const file = join(root, "order.jsonl");
  writeFileSync(file, text([ev(0, "session", {}, { id: "s" }), ev(2, "turn/start", { turn: 1 }), ev(1, "turn/start", { turn: 1 })]));
  const s = fold(readAll(file).events);
  if (s.phase !== "unknown") throw new Error("乱序没被抓住: " + s.phase);
  return { reason: s.unknown.reason };
});

kase("重复 seq：幂等，计数不翻倍", () => {
  const file = join(root, "dup.jsonl");
  const dup = ev(1, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" });
  writeFileSync(file, text([ev(0, "session", {}, { id: "s" }), dup, dup]));
  const s = fold(readAll(file).events);
  if (s.counts.toolCalls !== 1) throw new Error("重复投递让计数翻倍: " + s.counts.toolCalls);
  return { toolCalls: s.counts.toolCalls };
});

kase("明文 jsonl（非 zstd）：照常解析", () => {
  const file = join(root, "plain.jsonl");
  writeFileSync(file, text(base));
  const s = fold(readWindow(file).events);
  if (s.phase !== "working") throw new Error("明文没解析出来: " + s.phase);
  return { phase: s.phase };
});

kase("未知 surfaceOp：unknown 且粘滞", () => {
  const file = join(root, "surface.jsonl");
  writeFileSync(file, text([ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }, { surfaceOp: "rewrite-history" }), ev(2, "turn/end", { turn: 1 })]));
  const s = fold(readAll(file).events);
  if (s.phase !== "unknown" || !/^surface-op:/.test(s.unknown?.reason ?? "")) throw new Error("未知 surfaceOp 没被降级");
  return { reason: s.unknown.reason };
});

kase("tap 半行：不消费半个事件，next 停在最后一个换行后", () => {
  const file = join(root, "tap.jsonl");
  const ok = line({ type: "user/message", seq: 1, time: 1, data: { source: { kind: "user" } } });
  writeFileSync(file, ok + '{"type":"assistant/message","seq":2');
  const r = readTapFrom(file, 0);
  if (r.events.length !== 1) throw new Error("半行被当作事件: " + r.events.length);
  if (r.next !== ok.length) throw new Error("next 越过了半行: " + r.next + " vs " + ok.length);
  return { events: r.events.length, next: r.next };
});

kase("tap 滚动：文件变短 → 从头重读并标记 rotated", () => {
  const file = join(root, "tap-roll.jsonl");
  writeFileSync(file, line({ type: "session", seq: 0, time: 1, data: {} }));
  const r = readTapFrom(file, 10_000);
  if (!r.rotated) throw new Error("滚动没被识别");
  if (r.events.length !== 1) throw new Error("滚动后没重读: " + r.events.length);
  return { rotated: r.rotated, events: r.events.length };
});

kase("追加读取：半帧不前进 offset，补齐后能接上", () => {
  const file = join(root, "append.jsonl.zstd");
  const f1 = zstdCompressSync(Buffer.from(text([ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 })])));
  writeFileSync(file, f1);
  const w = readWindow(file);
  const f2 = zstdCompressSync(Buffer.from(text([ev(2, "turn/end", { turn: 1 })])));
  writeFileSync(file, Buffer.concat([f1, f2.subarray(0, Math.max(1, f2.length - 3))]));
  const half = readAppend(file, w.size, { expectedSeq: w.events.at(-1).seq });
  if (half.events.length) throw new Error("半个帧被当成了事件");
  writeFileSync(file, Buffer.concat([f1, f2]));
  const ok = readAppend(file, w.size, { expectedSeq: w.events.at(-1).seq });
  if (ok.events.length !== 1 || ok.events[0].seq !== 2) throw new Error("补齐后没接上");
  return { halfEvents: half.events.length, okEvents: ok.events.length };
});

const results = [];
let failed = 0;
try {
  for (const c of cases) {
    try {
      const detail = await c.fn();
      results.push({ name: c.name, ok: true, detail });
      console.log("ok   " + c.name);
    } catch (error) {
      failed++;
      results.push({ name: c.name, ok: false, error: String(error?.message ?? error) });
      console.log("FAIL " + c.name + " — " + (error?.message ?? error));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
const out = join(import.meta.dirname, "..", "..", "corpus");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "fault.json"), JSON.stringify({ at: new Date().toISOString(), pass: cases.length - failed, fail: failed, cases: results }, null, 2) + "\n");
console.log(`\nfault injection: ${cases.length - failed}/${cases.length} pass`);
process.exit(failed ? 1 : 0);
