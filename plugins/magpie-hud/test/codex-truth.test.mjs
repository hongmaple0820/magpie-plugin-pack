// codex 事件真值（lib/truth/codex-fold.mjs + codex-collect.mjs）的场景测试。
//
// 用合成的 codex 事件序列钉住语义：turn 开/收、工具调用、用户输入、
// 等输入请求、未知/缺口。事件形状照本机 763 个会话实测（见
// codex-fold.mjs 的注释），不猜。
import test from "node:test";
import assert from "node:assert/strict";
import { codexFold, codexSummary, codexEmptyState } from "../lib/truth/codex-fold.mjs";
import { codexTruth } from "../lib/truth/codex-collect.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// codex 事件构造器：ordinal 递增 + timestamp 递增。
let ord = 0;
const ev = (type, payload = {}) => {
  ord += 1;
  return { timestamp: new Date(1_700_000_000_000 + ord * 1000).toISOString(), ordinal: ord, type, payload };
};
const reset = () => { ord = 0; };

function sessionMeta() {
  return ev("session_meta", { id: "01a0a7d3-ea2e-7531-84f1-322d4d86eccf", cwd: "F:/maple/other" });
}
function taskStart(turnId = "t1") {
  return ev("event_msg", { type: "task_started", turn_id: turnId });
}
function taskComplete(turnId = "t1") {
  return ev("event_msg", { type: "task_complete", turn_id: turnId });
}
function turnAborted(turnId = "t1") {
  return ev("event_msg", { type: "turn_aborted", turn_id: turnId });
}
function userMsg(text = "hello") {
  return ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
}
function assistantMsg() {
  return ev("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] });
}
function toolCall(callId = "c1", name = "exec") {
  return ev("response_item", { type: "custom_tool_call", call_id: callId, name });
}
function toolOutput(callId = "c1") {
  return ev("response_item", { type: "custom_tool_call_output", call_id: callId, output: "done" });
}
function askCall(callId = "a1") {
  return ev("response_item", { type: "custom_tool_call", call_id: callId, name: "request_user_input_async" });
}

test("只有会话头 → starting/idle", () => {
  reset();
  const s = codexFold([sessionMeta()]);
  const sum = codexSummary(s);
  assert.equal(sum.phase, "starting");
  assert.equal(sum.rule, "session-only");
});

test("turn 开着 → working；收口 → idle", () => {
  reset();
  const s = codexFold([sessionMeta(), taskStart("t1")]);
  assert.equal(codexSummary(s).phase, "working");
  const s2 = codexFold([taskComplete("t1")], { state: s });
  assert.equal(codexSummary(s2).phase, "paused");
});

test("用户消息后无 turn → working（等起跑）", () => {
  reset();
  const s = codexFold([sessionMeta(), userMsg("do it")]);
  assert.equal(codexSummary(s).phase, "working");
  assert.equal(codexSummary(s).rule, "user-input-pending-turn");
});

test("工具调用挂着 → working；输出后收口", () => {
  reset();
  let s = codexFold([sessionMeta(), taskStart("t1"), toolCall("c1", "exec")]);
  assert.equal(codexSummary(s).phase, "working");
  assert.equal(codexSummary(s).activity?.tool, "exec");
  s = codexFold([toolOutput("c1")], { state: s });
  assert.equal(codexSummary(s).phase, "working"); // turn 还开着
  s = codexFold([taskComplete("t1")], { state: s });
  assert.equal(codexSummary(s).phase, "paused");
});

test("等输入请求工具 → waiting/running 带 question", () => {
  reset();
  const s = codexFold([sessionMeta(), taskStart("t1"), askCall("a1")]);
  const sum = codexSummary(s);
  assert.equal(sum.phase, "waiting");
  assert.equal(sum.waiting?.kind, "question");
  assert.equal(sum.waiting?.toolName, "request_user_input_async");
});

test("等输入请求被用户消息关闭", () => {
  reset();
  let s = codexFold([sessionMeta(), taskStart("t1"), askCall("a1")]);
  assert.equal(codexSummary(s).phase, "waiting");
  s = codexFold([userMsg("answer"), toolOutput("a1")], { state: s });
  assert.equal(codexSummary(s).phase, "working"); // turn 还开着
  assert.equal(codexSummary(s).waiting, null);
});

test("turn 被中断：关闭挂起的输入请求", () => {
  reset();
  let s = codexFold([sessionMeta(), taskStart("t1"), askCall("a1")]);
  assert.equal(codexSummary(s).phase, "waiting");
  s = codexFold([turnAborted("t1")], { state: s });
  const sum = codexSummary(s);
  assert.equal(sum.phase, "paused");
  assert.equal(sum.waiting, null);
});

test("无证据 → unknown，绝不落 running/idle", () => {
  reset();
  const s = codexFold([]);
  const sum = codexSummary(s);
  assert.equal(sum.phase, "unknown");
  assert.equal(sum.rule, "unknown:no-evidence");
});

test("ordinal 缺口 → unknown", () => {
  reset();
  const gap = [{ ...sessionMeta(), ordinal: 1 }, { ...userMsg(), ordinal: 5 }]; // 1→5 缺口
  const s = codexFold(gap);
  assert.equal(codexSummary(s).phase, "unknown");
  assert.match(codexSummary(s).rule, /ordinal-gap/);
});

test("重复 ordinal 幂等", () => {
  reset();
  const s = codexFold([sessionMeta(), taskStart("t1")]);
  const dup = codexFold([taskStart("t1")], { state: s });
  assert.equal(codexSummary(dup).phase, "working");
});

// codex-collect：从临时 .zst 文件读真值（需要 fzstd；CI 有）。
test("codexTruth 从 .zst 压缩文件读真值", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-truth-"));
  const file = join(dir, "rollout-2026-09-08T12-00-00-01a07f4e-294d-7361-8e41-7106f03d63df.jsonl.zst");
  const zstd = await import("fzstd").then((m) => m.compress, () => null);
  reset();
  const lines = [sessionMeta(), taskStart("t1"), toolCall("c1", "exec")]
    .map((e) => JSON.stringify(e))
    .join("\n");
  try {
    // fzstd 提供 compress？若没有则跳过（纯解压器只读）。
    if (!zstd) { rmSync(dir, { recursive: true, force: true }); return; }
    writeFileSync(file, zstd(new TextEncoder().encode(lines)));
    const truth = codexTruth(file);
    assert.equal(truth.phase, "working");
    assert.equal(truth.evidence.mode, "transcript");
    assert.equal(truth.state, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codexTruth 明文 .jsonl 也读真值", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-truth-plain-"));
  const file = join(dir, "rollout-2026-09-08T12-00-00-01a07f4e-294d-7361-8e41-7106f03d63df.jsonl");
  reset();
  const lines = [sessionMeta(), taskStart("t1"), taskComplete("t1")]
    .map((e) => JSON.stringify(e))
    .join("\n");
  try {
    writeFileSync(file, lines);
    const truth = codexTruth(file);
    assert.equal(truth.phase, "paused");
    assert.equal(truth.state, "idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
