// 纯 reducer：把 DSH 事件流折叠成「会话此刻在干什么」。
//
// 设计约束（docs/magpie-hud-truth-model.md §3/§10）：
//   · 只用事件语义，不看 mtime、不看文本正则；
//   · 每次 phase 变化都记下 {rule, seq}，没有触发事件的转移视为实现错误；
//   · 未知（解码失败/seq 缺口/未知 surfaceOp）优先级最高，绝不被猜成 running/idle；
//   · 纯函数：same 输入 → same 输出；重复 seq 幂等；前缀可重放。
//
// 状态是可 JSON 化的普通对象（Map 转 Object），便于落盘、diff 与断言。
import { seqSpan } from "./frames.mjs";

export const OPEN = "open";
export const CLOSED = "closed";

const PHASES = new Set(["starting", "working", "waiting", "paused", "unknown"]);
// 会「上屏一张卡等人」的工具名：名字可能带后缀（ask_user_question 等）。
const ASK_TOOL_RE = /(^|[^a-z])(ask_user|exit_plan_mode)/;
// 尾部窗口从 turn 中间开始时，这些「进行中」事件说明 turn 还没收口。
const TAIL_ACTIVITY = new Set([
  "tool/call",
  "tool/result",
  "step/start",
  "step/end",
  "assistant/message",
  "assistant/attempt",
  "compaction/start",
  "compaction/summary",
]);
export { PHASES };

export function emptyState() {
  return {
    sessionId: null,
    createdAt: null,
    cwd: "",
    title: null, // 最新一条 session/title 的标题（用户改过的会覆盖 provider 生成的）
    lastSeq: -1,
    lastEventSeq: null,
    lastType: null,
    lastEventAt: null,
    lastUserMessageSeq: null,
    turns: {}, // turn → 起始 seq
    steps: {}, // "turn:step" → 起始 seq
    jobs: {}, // jobId → {seq, kind, owner}
    calls: {}, // callId → {seq, name, at}
    approvals: {}, // askId → {seq, at, toolName}
    asks: {}, // callId → {seq, at, name, resultSeen}
    tokens: { input: 0, output: 0, cacheRead: 0 },
    counts: { turns: 0, toolCalls: 0, approvals: 0, questions: 0 },
    phase: "unknown",
    phaseSinceSeq: null,
    phaseRule: null,
    sawActivity: false,
    unknown: { reason: "no-evidence", sinceSeq: null },
    surfaceOpUnknown: null,
    replaced: [], // {op:"replace"} 派生事件的替代区间，供 provenance 审计
  };
}

// 从当前集合推导 phase 与等待。纯函数，不修改 state。
export function derive(state) {  if (state.unknown) {
    return { phase: "unknown", rule: "unknown:" + state.unknown.reason, waiting: null };
  }
  const approvals = Object.entries(state.approvals);
  if (approvals.length) {
    const [id, a] = approvals.sort((x, y) => x[1].seq - y[1].seq)[0];
    return { phase: "waiting", rule: "approval-asked", waiting: { kind: "approval", askId: id, toolName: a.toolName || null, since: a.at, seq: a.seq } };
  }
  const asks = Object.entries(state.asks).filter(([, a]) => a.resultSeen && !a.resultError && !a.answered);
  if (asks.length) {
    const [id, a] = asks.sort((x, y) => x[1].seq - y[1].seq)[0];
    return { phase: "waiting", rule: "question-card", waiting: { kind: "question", askId: id, toolName: a.name || null, since: a.at, seq: a.seq } };
  }
  const openTurns = Object.keys(state.turns).length;
  const openSteps = Object.keys(state.steps).length;
  const openJobs = Object.keys(state.jobs).length;
  if (openTurns || openSteps || openJobs) {
    return { phase: "working", rule: openTurns ? "turn-open" : openSteps ? "step-open" : "job-open", waiting: null };
  }
  if (state.lastType === "user/message" || state.lastType === "agent/inbox/spliced") {
    // 用户刚说完话、还没有 turn/start —— 正在起跑，不是空闲。
    return { phase: "working", rule: "user-input-pending-turn", waiting: null };
  }
  if (state.lastType === "session/end-seed") {
    // 会话被显式收尾（导出/播种结束）：不是「在跑」，也不是「未知」。
    return { phase: "paused", rule: "session-ended", waiting: null };
  }
  if (state.lastType === "turn/end") {
    // 尾部窗口常常从 turn 中间开始：turn/start 在窗口外，靠「最后一条是 turn/end」判定收工。
    return { phase: "paused", rule: "turn-closed-tail", waiting: null };
  }
  if (TAIL_ACTIVITY.has(state.lastType)) {
    // 尾部窗口只截到 turn 中段（step/start 在窗口外）：最后一条仍是进行中的事件类型。
    return { phase: "working", rule: "activity-tail", waiting: null };
  }
  if (state.sawActivity) {
    // 之前确实跑过东西、现在没有任何开着的 turn/step/job：收工了（尾部只剩元数据类事件）。
    return { phase: "paused", rule: "tail-closed", waiting: null };
  }
  if (state.counts.turns > 0) return { phase: "paused", rule: "turn-closed", waiting: null };
  if (state.sessionId) return { phase: "starting", rule: "session-only", waiting: null };
  if (state.lastType) return { phase: "starting", rule: "metadata-only", waiting: null };
  return { phase: "unknown", rule: "no-evidence", waiting: null };
}

// tool/result 的文本体：DSH 是 [{type:"text",text}]，其它客户端可能直接给字符串。
function resultText(d) {
  const c = d?.message?.content ?? d?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n");
  return "";
}

function applyPhase(state, { phase, rule, waiting }, seq) {  if (!PHASES.has(phase)) throw new Error(`bad phase: ${phase}`);
  state.waiting = waiting ?? null;
  if (state.phase !== phase) {
    state.phase = phase;
    state.phaseSinceSeq = seq;
    state.phaseRule = rule;
  }
  return state;
}

// reduce：事件的「语义」只在这里落地。返回新对象；相同 seq 重复出现直接忽略。
export function reduce(state, ev) {
  const type = ev?.type;
  if (typeof type !== "string") return state;
  const seq = typeof ev.seq === "number" ? ev.seq : null;
  if (seq != null && seq <= state.lastSeq) return state; // 重放/重复投递幂等

  const s = { ...state };
  // 浅拷贝会被改动的集合；没被改到的共享。
  s.turns = state.turns;
  s.steps = state.steps;
  s.jobs = state.jobs;
  s.calls = state.calls;
  s.approvals = state.approvals;
  s.asks = state.asks;

  if (seq != null) {
    s.lastSeq = seq;
    s.lastEventSeq = seq;
  }
  if (typeof ev.time === "number") s.lastEventAt = ev.time;
  s.lastType = type;
  if (TAIL_ACTIVITY.has(type) || type === "turn/start" || type === "turn/end") s.sawActivity = true;

  if (ev.surfaceOp && ev.surfaceOp !== "append") {
    if (typeof ev.surfaceOp === "object" && ev.surfaceOp.op === "replace") {
      // 已知派生：replace 表示「本事件替代 startSeq..endSeq 的可见性」。
      // 事件本身仍要折叠（它承载新的语义），但要留下替代记录供 provenance 检查。
      s.replaced = [...state.replaced, { at: seq, startSeq: ev.surfaceOp.startSeq ?? null, endSeq: ev.surfaceOp.endSeq ?? null }];
    } else {
      // 未知的派生意图：不猜，整会话降级 unknown 等下一轮重读。
      s.unknown = { reason: `surface-op:${typeof ev.surfaceOp === "string" ? ev.surfaceOp : JSON.stringify(ev.surfaceOp)}`, sinceSeq: seq };
      s.surfaceOpUnknown = ev.surfaceOp;
      return applyPhase(s, derive(s), seq);
    }
  }

  const d = ev.data ?? {};
  switch (type) {
    case "session": {
      // 真实转录把 id/cwd 放顶层；tap 投影可能放进 data，两种都认。
      s.sessionId = String(ev.id ?? d.id ?? s.sessionId ?? "");
      s.cwd = String(ev.cwd ?? d.cwd ?? "");
      s.createdAt = typeof (ev.createdAt ?? d.createdAt) === "number" ? (ev.createdAt ?? d.createdAt) : s.createdAt;
      break;
    }
    case "session/title": {
      // 标题事件按时间顺序后者覆盖前者：fallback → provider → 用户改的。
      // 尾部窗口正好覆盖最新事件，所以这里拿到的是「当前生效」的标题。
      if (typeof d.title === "string" && d.title) s.title = d.title;
      break;
    }
    case "turn/start": {
      s.turns = { ...state.turns, [String(d.turn ?? seq)]: { seq, at: ev.time ?? null } };
      s.currentTurn = d.turn ?? s.currentTurn;
      s.counts = { ...state.counts, turns: state.counts.turns + 1 };
      break;
    }
    case "turn/end": {
      const t = String(d.turn ?? "");
      s.turns = { ...state.turns };
      delete s.turns[t];
      // 被用户打断的 turn：挂在它下面的审批不会再有人回答，必须关闭，否则 HUD 永远显示「等你」。
      if (d.reason?.kind === "interrupted" && Object.keys(s.approvals).length) {
        const next = {};
        for (const [id, a] of Object.entries(s.approvals)) if (String(a.turn) !== String(d.turn)) next[id] = a;
        s.approvals = next;
      }
      s.currentTurn = null;
      break;
    }
    case "step/start": {
      s.steps = { ...state.steps, [`${d.turn}:${d.step}`]: { seq, at: ev.time ?? null } };
      break;
    }
    case "step/end": {
      s.steps = { ...state.steps };
      delete s.steps[`${d.turn}:${d.step}`];
      break;
    }
    case "tool/call": {
      const callId = String(d.callId ?? "");
      if (callId) s.calls = { ...state.calls, [callId]: { seq, name: String(d.name ?? ""), at: ev.time ?? null } };
      if (ASK_TOOL_RE.test(String(d.name ?? ""))) {
        s.asks = { ...state.asks, [callId]: { seq, at: ev.time ?? null, name: String(d.name), resultSeen: false } };
        s.counts = { ...state.counts, questions: state.counts.questions + 1 };
      }
      s.counts = { ...s.counts, toolCalls: s.counts.toolCalls + 1 };
      break;
    }
    case "tool/result": {
      // 真实形状：callId 在 data.message.source.callId；兼容 data.toolCallId 的其它客户端。
      const callId = String(d.message?.source?.callId ?? d.toolCallId ?? "");
      if (callId) {
        s.calls = { ...state.calls };
        delete s.calls[callId];
        if (s.asks[callId]) {
          // 两种真实形状：
          //   · 结果里直接带回 {"answers":[…]} —— 卡片当场答完，不再等人；
          //   · 结果只是「卡片已上屏，答案随下一条消息来」—— 从这一刻开始等人。
          const text = resultText(d);
          s.asks = {
            ...s.asks,
            [callId]: {
              ...s.asks[callId],
              resultSeen: true,
              resultError: d.message?.isError === true,
              answered: /"answers"\s*:/.test(text),
            },
          };
        }
        // 未决审批的调用已经产出结果（含 interrupted-tool-result）：审批不可能再被回答。
        const stuck = Object.entries(s.approvals).filter(([, a]) => a.callId === callId);
        if (stuck.length) {
          const next = { ...s.approvals };
          for (const [id] of stuck) delete next[id];
          s.approvals = next;
        }
      }
      break;
    }
    case "approval/asked": {
      const id = String(d.id ?? "");
      if (id) {
        s.approvals = { ...state.approvals, [id]: { seq, at: ev.time ?? null, toolName: String(d.toolName ?? ""), callId: String(d.callId ?? ""), turn: s.currentTurn ?? null } };
        s.counts = { ...state.counts, approvals: state.counts.approvals + 1 };
      }
      break;
    }
    case "approval/decided": {
      const id = String(d.id ?? "");
      s.approvals = { ...state.approvals };
      delete s.approvals[id];
      break;
    }
    case "user/message": {
      if (d?.source?.kind === "user") {
        // 用户答了卡：已上屏的提问（resultSeen）被这条消息关闭；
        // 还没上屏的（调用还在跑）不关——答案不可能先于卡片出现。
        const next = {};
        for (const [id, a] of Object.entries(s.asks)) if (!a.resultSeen) next[id] = a;
        s.asks = next;
        s.lastUserMessageSeq = seq;
      }
      break;
    }
    case "agent/inbox/spliced": {
      // 会话空闲后，用户的下一条消息以「拼接进下一 turn」的形式落盘；
      // 它同样是答案，必须关闭已上屏的提问。
      const items = Array.isArray(d?.inserted) ? d.inserted : [];
      if (items.some((it) => it?.source?.kind === "user")) {
        const next = {};
        for (const [id, a] of Object.entries(s.asks)) if (!a.resultSeen) next[id] = a;
        s.asks = next;
        s.lastUserMessageSeq = seq;
      }
      break;
    }
    case "job/registered": {
      const jobId = String(d.jobId ?? "");
      if (jobId) s.jobs = { ...state.jobs, [jobId]: { seq, kind: String(d.kind ?? ""), owner: String(d.owner ?? "") } };
      break;
    }
    case "job/settled": {
      const jobId = String(d.jobId ?? "");
      s.jobs = { ...state.jobs };
      delete s.jobs[jobId];
      break;
    }
    case "assistant/message": {
      const usage = d?.data?.usage ?? d?.usage;
      if (usage) {
        s.tokens = {
          input: state.tokens.input + (Number(usage.inputTokens) || 0),
          output: state.tokens.output + (Number(usage.outputTokens) || 0),
          cacheRead: state.tokens.cacheRead + (Number(usage.cacheReadTokens) || 0),
        };
      }
      break;
    }
    default:
      break; // 不认识的事件不影响状态；它们的语义不在本 reducer 的证明范围里
  }
  // 「还没有证据」只是空状态的哨兵，任何被理解的事件出现后都必须让位给真实语义；
  // 注意 surfaceOp 未知的分支在上面已经 return，不会被这里清掉。
  if (s.unknown?.reason === "no-evidence") s.unknown = null;
  return applyPhase(s, derive(s), seq);
}

// 带完整性检查的 fold：seq 必须从 startSeq 起严格 +1；出现缺口立即 unknown。
export function fold(events, { state = emptyState(), startSeq = null, now = null } = {}) {
  let s = state;
  let expected = startSeq;
  for (const ev of events) {
    const seq = typeof ev?.seq === "number" ? ev.seq : null;
    if (seq != null && seq <= s.lastSeq) continue; // 重放/重复投递：幂等跳过
    if (seq != null && expected == null) expected = seq;
    if (expected != null && seq != null && seq !== expected) {
      s = { ...s, unknown: { reason: `seq-gap:expected:${expected}:got:${seq}`, sinceSeq: s.lastSeq } };
      s = applyPhase(s, derive(s), s.lastSeq);
      return s;
    }
    if (seq != null) expected = seq + 1;
    s = reduce(s, ev);
  }
  if (now != null) s.now = now;
  return s;
}

// 给上层用的摘要：显示需要的最小集合，含证据。
export function summary(state) {
  const d = derive(state);
  const openCalls = Object.values(state.calls).sort((a, b) => b.seq - a.seq);
  const activity = openCalls.length
    ? { tool: openCalls[0].name, since: openCalls[0].at, seq: openCalls[0].seq }
    : Object.keys(state.turns).length
      ? { tool: null, since: null, seq: state.lastSeq }
      : null;
  return {
    phase: d.phase,
    rule: state.phaseRule ?? d.rule,
    phaseSinceSeq: state.phaseSinceSeq,
    waiting: d.waiting,
    activity,
    title: state.title ?? null,
    lastSeq: state.lastSeq,
    lastEventAt: state.lastEventAt,
    unknown: state.unknown,
    tokens: state.tokens,
    counts: state.counts,
  };
}
