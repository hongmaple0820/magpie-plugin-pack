// reducer 的属性测试与场景测试。
// 属性用自建 seeded PRNG（mulberry32）——零依赖、可复跑、失败可给种子。
import test from "node:test";
import assert from "node:assert/strict";
import { derive, emptyState, fold, reduce, summary } from "../lib/truth/fold.mjs";

const ev = (seq, type, data = {}, extra = {}) => ({ type, seq, time: 1_000 + seq, data, ...extra });

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genStream(seed, n) {
  const rnd = mulberry32(seed);
  const out = [{ type: "session", seq: 0, time: 1_000, id: "seed-" + seed, data: {} }];
  let seq = 1;
  let turn = 0;
  let lastCall = "c0";
  while (out.length < n) {
    const r = rnd();
    if (r < 0.12) {
      turn += 1;
      out.push(ev(seq++, "turn/start", { turn }));
    } else if (r < 0.24) {
      out.push(ev(seq++, "turn/end", { turn }));
    } else if (r < 0.38) {
      lastCall = "c" + seq;
      out.push(ev(seq++, "tool/call", { turn, step: 1, callId: lastCall, name: rnd() < 0.2 ? "ask_user" : "pwsh" }));
    } else if (r < 0.48) {
      out.push(ev(seq++, "tool/result", { message: { role: "tool", source: { kind: "tool", callId: lastCall }, content: [{ type: "text", text: "ok" }], isError: false } }));
    } else if (r < 0.58) {
      out.push(ev(seq++, "approval/asked", { id: "a" + seq, toolName: "pwsh", callId: lastCall }));
    } else if (r < 0.64) {
      out.push(ev(seq++, "approval/decided", { id: "a1", outcome: "allowed-once" }));
    } else if (r < 0.76) {
      out.push(ev(seq++, "user/message", { source: { kind: rnd() < 0.8 ? "user" : "system" }, content: [{ type: "text", text: "u" }] }));
    } else if (r < 0.86) {
      out.push(ev(seq++, "job/registered", { jobId: "j" + seq, kind: "bash" }));
    } else if (r < 0.94) {
      out.push(ev(seq++, "job/settled", { jobId: "j1", status: "ok" }));
    } else {
      out.push(ev(seq++, "assistant/message", { usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1 } }));
    }
  }
  return out;
}

test("ASSOCIATIVITY: fold(A then B) equals fold(B, fold(A)) — 200 random streams", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const events = genStream(seed, 40 + (seed % 20));
    const whole = fold(events);
    const cut = Math.floor(events.length / 2);
    const split = fold(events.slice(cut), { state: fold(events.slice(0, cut)) });
    assert.deepEqual(JSON.parse(JSON.stringify(split)), JSON.parse(JSON.stringify(whole)), "seed " + seed);
  }
});

test("REPLAY: folding the same events twice changes nothing", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const events = genStream(seed, 40);
    const once = fold(events);
    const twice = fold(events, { state: once });
    assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)), "seed " + seed);
  }
});

test("EVIDENCE: every phase transition names a rule and a seq that exists in the stream", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const events = genStream(seed, 60);
    let s = emptyState();
    let prev = s.phase;
    for (const e of events) {
      s = reduce(s, e);
      if (s.phase !== prev) {
        assert.ok(s.phaseRule, "phase 变了却没有 rule（seed " + seed + "）");
        assert.ok(Number.isInteger(s.phaseSinceSeq), "phase 变了却没有 seq（seed " + seed + "）");
        assert.ok(events.some((x) => x.seq === s.phaseSinceSeq), "phaseSinceSeq 不在事件流里");
        prev = s.phase;
      }
    }
  }
});

test("GAP: a missing seq makes the session unknown, not running", () => {
  const s = fold([ev(0, "session", {}, { id: "s" }), ev(2, "turn/start", { turn: 1 })]);
  assert.equal(s.phase, "unknown");
  assert.match(s.unknown.reason, /^seq-gap:/);
});

test("approval asked → waiting; decided → paused", () => {
  const base = [ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" })];
  const asked = fold([...base, ev(3, "approval/asked", { id: "a1", toolName: "pwsh" })]);
  assert.equal(asked.phase, "waiting");
  assert.deepEqual(summary(asked).waiting, { kind: "approval", askId: "a1", toolName: "pwsh", since: 1_003, seq: 3 });
  const decided = fold([...base, ev(3, "approval/asked", { id: "a1", toolName: "pwsh" }), ev(4, "tool/result", { toolCallId: "c1" }), ev(5, "approval/decided", { id: "a1", outcome: "allowed-once" }), ev(6, "turn/end", { turn: 1 })]);
  assert.equal(decided.phase, "paused");
  assert.equal(summary(decided).waiting, null);
});

test("question card: call+result → waiting until the next real user message", () => {
  const s1 = fold([ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user" })]);
  assert.equal(s1.phase, "working", "卡片还没上屏时不算等待");
  const s2 = fold([ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user" }), ev(3, "tool/result", { toolCallId: "c1" })]);
  assert.equal(s2.phase, "waiting");
  assert.equal(summary(s2).waiting.kind, "question");
  const s3 = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user" }),
    ev(3, "tool/result", { toolCallId: "c1" }),
    ev(4, "user/message", { source: { kind: "user" }, content: "answer" }),
    ev(5, "turn/end", { turn: 1 }),
  ]);
  assert.equal(s3.phase, "paused");
});

test("a result that already carries the answer is not a pending question", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user_question" }),
    ev(3, "tool/result", {
      message: {
        role: "tool",
        source: { kind: "tool", callId: "c1" },
        content: [{ type: "text", text: '{"answers":[{"id":"intent","selected":["a"]}]}' }],
        isError: false,
      },
    }),
    ev(4, "step/end", { turn: 1, step: 1 }),
  ]);
  assert.equal(s.phase, "working", "答案已经随结果回来了，没有在等人");
});

test("a result that only says the card is on screen does start the wait", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user" }),
    ev(3, "tool/result", {
      message: { role: "tool", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "The card is on screen; the user's answer arrives as their next message." }], isError: false },
    }),
  ]);
  assert.equal(s.phase, "waiting");
});

test("system-injected user messages do not close a question", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user" }),
    ev(3, "tool/result", { toolCallId: "c1" }),
    ev(4, "user/message", { source: { kind: "user-approval" } }),
  ]);
  assert.equal(s.phase, "waiting");
});

test("open job keeps working; settled returns to paused", () => {
  const base = [ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }), ev(2, "turn/end", { turn: 1 })];
  const working = fold([...base, ev(3, "job/registered", { jobId: "j1", kind: "bash" })]);
  assert.equal(working.phase, "working");
  const done = fold([...base, ev(3, "job/registered", { jobId: "j1", kind: "bash" }), ev(4, "job/settled", { jobId: "j1" })]);
  assert.equal(done.phase, "paused");
});

test("unknown surfaceOp makes the session unknown and stays unknown", () => {
  const s = fold([ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/result", { toolCallId: "x" }, { surfaceOp: "rewrite-history" })]);
  assert.equal(s.phase, "unknown");
  assert.match(s.unknown.reason, /^surface-op:/);
  const s2 = fold([ev(3, "turn/end", { turn: 1 })], { state: s });
  assert.equal(s2.phase, "unknown");
});

test("empty stream is unknown, never idle", () => {
  const s = fold([]);
  assert.equal(s.phase, "unknown");
  assert.equal(summary(s).waiting, null);
});

test("tokens accumulate from assistant usage", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }),
    ev(1, "assistant/message", { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 } }),
    ev(2, "assistant/message", { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } }),
  ]);
  assert.deepEqual(s.tokens, { input: 11, output: 22, cacheRead: 8 });
});

test("derive is pure: state is not mutated", () => {
  const s = fold(genStream(3, 10));
  const snapshot = JSON.stringify(s);
  derive(s);
  assert.equal(JSON.stringify(s), snapshot);
});

// ── 变异测试（tools/mutation/run.mjs）暴露的未覆盖语义：每条都对应一个真实分支 ──

test("只有会话头 → starting；刚说完话但 turn 还没起 → working", () => {
  const only = fold([ev(0, "session", {}, { id: "s" })]);
  assert.equal(only.phase, "starting");
  const spoken = fold([ev(0, "session", {}, { id: "s" }), ev(1, "user/message", { source: { kind: "user" }, content: "hi" })]);
  assert.equal(spoken.phase, "working");
  assert.equal(spoken.phaseRule, "user-input-pending-turn");
  const spliced = fold([ev(0, "session", {}, { id: "s" }), ev(1, "agent/inbox/spliced", { inserted: [{ source: { kind: "user" }, text: "hi" }] })]);
  assert.equal(spliced.phase, "working");
});

test("session 事件写 id/cwd，事件时间写 lastEventAt，tool/call 记 callId", () => {
  const s = fold([ev(0, "session", {}, { id: "s1", cwd: "F:/x" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" })]);
  assert.equal(s.sessionId, "s1");
  assert.equal(s.cwd, "F:/x");
  assert.equal(s.lastEventAt, 1_002);
  assert.equal(s.calls.c1.name, "pwsh");
  assert.equal(s.counts.turns, 1);
  assert.equal(summary(s).activity.tool, "pwsh");
});

test("重复 seq 幂等：同一个 tool/call 不重复计数", () => {
  const one = ev(0, "session", {}, { id: "s" });
  const call = ev(1, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" });
  const s = fold([one, call, call]);
  assert.equal(s.counts.toolCalls, 1);
  assert.equal(summary(fold([one, call])).lastSeq, s.lastSeq);
});

test("replace 是已知派生：继续折叠并留下替代记录，不降级 unknown", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }),
    ev(1, "turn/start", { turn: 1 }),
    ev(2, "system/message", { turn: 1, step: 1 }, { surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 } }),
  ]);
  assert.equal(s.phase, "working");
  assert.equal(s.replaced.length, 1);
  assert.deepEqual(s.replaced[0], { at: 2, startSeq: 2, endSeq: 2 });
});

test("审批的调用产出结果就关闭审批（含 interrupted-tool-result）", () => {
  const done = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }), ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" }),
    ev(3, "approval/asked", { id: "a1", toolName: "pwsh", callId: "c1" }),
    ev(4, "tool/result", { message: { role: "tool", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "x" }], isError: true } }),
  ]);
  assert.equal(done.phase, "working", "审批不可能再被回答，不能继续显示等你");
  assert.equal(summary(done).waiting, null);
});

test("turn 正常结束不关闭审批；只有 interrupted 才关", () => {
  const base = [
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "approval/asked", { id: "a1", toolName: "pwsh", callId: "c9" }),
  ];
  const normal = fold([...base, ev(3, "turn/end", { turn: 1 })]);
  assert.equal(normal.phase, "waiting");
  const interrupted = fold([...base, ev(3, "turn/end", { turn: 1, reason: { kind: "interrupted" } })]);
  assert.equal(interrupted.phase, "paused");
});

test("inbox 拼接进来的真人消息关闭已上屏提问", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "tool/call", { turn: 1, step: 1, callId: "c1", name: "ask_user" }),
    ev(3, "tool/result", { toolCallId: "c1" }),
    ev(4, "agent/inbox/spliced", { inserted: [{ source: { kind: "user" }, text: "答案是 B" }] }),
  ]);
  assert.equal(s.phase, "working");
  assert.equal(summary(s).waiting, null);
});

test("reduce 直接收到重复 seq 也幂等（fold 之外的第二道门）", () => {
  const one = reduce(emptyState(), ev(0, "session", {}, { id: "s" }));
  const call = ev(1, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" });
  const s = reduce(reduce(one, call), call);
  assert.equal(s.counts.toolCalls, 1);
});

test("exit_plan_mode 也是提问卡", () => {
  const s = fold([
    ev(0, "session", {}, { id: "s" }), ev(1, "turn/start", { turn: 1 }),
    ev(2, "tool/call", { turn: 1, step: 1, callId: "c2", name: "exit_plan_mode" }),
    ev(3, "tool/result", { toolCallId: "c2" }),
  ]);
  assert.equal(s.phase, "waiting");
  assert.equal(summary(s).waiting.toolName, "exit_plan_mode");
});

// 尾部窗口从 turn 中间开始是常态（128KB 窗口 vs 几 MB 转录）：这些规则决定
// 「窗口里看不到 turn/start 时，到底算在跑、算收工、还是算未知」。
test("窗口从 turn 中段开始：最后一条是 turn/end → paused（不是 unknown）", () => {
  const s = fold([ev(100, "tool/call", { turn: 7, step: 3, callId: "c1", name: "pwsh" }), ev(101, "turn/end", { turn: 7 })]);
  assert.equal(s.phase, "paused");
  assert.equal(s.phaseRule, "turn-closed-tail");
});

test("窗口从 turn 中段开始：最后一条是进行中事件 → working(activity-tail)", () => {
  // 不带任何「开着的容器」：只截到一个 tool/call（call 本身不算 phase 容器）。
  const s = fold([ev(50, "tool/call", { turn: 2, step: 1, callId: "c1", name: "pwsh" })]);
  assert.equal(s.phase, "working");
  assert.equal(s.phaseRule, "activity-tail");
  // 容器开着时用更具体的规则（step-open / turn-open）。
  const open = fold([ev(50, "step/start", { turn: 2, step: 9 }), ev(51, "assistant/message", { turn: 2, step: 9 })]);
  assert.equal(open.phase, "working");
  assert.equal(open.phaseRule, "step-open");
});

test("跑过东西但尾部只剩元数据事件 → paused(tail-closed)，不是 unknown", () => {
  const s = fold([
    ev(10, "step/start", { turn: 1, step: 1 }),
    ev(11, "tool/call", { turn: 1, step: 1, callId: "c1", name: "pwsh" }),
    ev(12, "tool/result", { message: { source: { kind: "tool", callId: "c1" }, isError: false } }),
    ev(13, "step/end", { turn: 1, step: 1 }),
    ev(14, "job/registered", { jobId: "j1" }),
    ev(15, "job/settled", { jobId: "j1", status: "ok" }),
    ev(16, "workspace/changes", {}),
  ]);
  assert.equal(s.phase, "paused");
  assert.equal(s.phaseRule, "tail-closed");
});

test("session/end-seed 收尾 → paused；规则记录的是「第一次进入该相位的证据」", () => {
  // 只有 end-seed 一条事件：没有更早的相位转移，规则就是 session-ended。
  const only = fold([ev(5, "session/end-seed", {})]);
  assert.equal(only.phase, "paused");
  assert.equal(only.phaseRule, "session-ended");
  // 前面已经 turn/end 收过工：相位没变，phaseRule/phaseSinceSeq 保持第一次的证据（粘滞）。
  const after = fold([
    ev(1, "turn/start", { turn: 1 }),
    ev(2, "step/start", { turn: 1, step: 1 }),
    ev(3, "step/end", { turn: 1, step: 1 }),
    ev(4, "turn/end", { turn: 1 }),
    ev(5, "session/end-seed", {}),
  ]);
  assert.equal(after.phase, "paused");
  assert.equal(after.phaseRule, "turn-closed-tail");
});

test("只有元数据、没有任何活动 → starting(metadata-only)，不冒充 unknown", () => {
  const s = fold([ev(3, "session/title", { title: "x" })]);
  assert.equal(s.phase, "starting");
  assert.equal(s.phaseRule, "metadata-only");
});
