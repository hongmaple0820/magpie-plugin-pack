// Codex 会话的事件真值（reducer）：把 codex 转录事件折叠成「此刻在干什么」。
//
// 为什么单独一个模块而不是复用 lib/truth/fold.mjs：codex 的事件形状与 DSH
// 完全不同（DSH 是 /turn|step|tool/ 事件族，codex 是 event_msg/response_item
// 家族），强行适配会让 DSH 的 reducer 被 codex 的怪形状污染。这里是一个
// 独立的、只认 codex 形状的 reducer，输出与 fold 的 summary 同构的字段，
// 上层（sessions.mjs 的 codexSessions）可以统一消费。
//
// 事件（本机 763 个会话实测，fzstd 可解压 .jsonl.zst）：
//   {type:"session_meta", payload:{id, cwd}}
//   {type:"event_msg", payload:{type:"task_started", turn_id}}          —— turn 开始
//   {type:"event_msg", payload:{type:"task_complete", turn_id}}         —— turn 结束
//   {type:"event_msg", payload:{type:"turn_aborted", turn_id}}          —— turn 被中断
//   {type:"event_msg", payload:{type:"item_completed", turn_id, item}}  —— 一个 item 完成
//   {type:"response_item", payload:{type:"message", role:"user"|"assistant"|"developer", content:[…]}}
//   {type:"response_item", payload:{type:"custom_tool_call", call_id, name}}
//   {type:"response_item", payload:{type:"custom_tool_call_output", call_id}}
//   {type:"response_item", payload:{type:"function_call"|"function_call_output"}}
//   {type:"token_usage_record", payload:{usage:{input_tokens, output_tokens, …}}}
//
// 诚实性（照 v7 §4.1）：phase 只能由事件证据决定，不猜 mtime。turn 开着 →
// working；没有开着 turn、但最后是用户消息/进行中的工具 → working（等起跑
// 或工具在跑）；全部收口 → idle；只有会话头 → starting；否则 unknown。
// 没有证据时绝不落 running/idle。
//
// 注意：codex 没有 DSH 那样的 approval/asked 事件，也没有 ask_user 工具名。
// 它的「等你回答」形态是 custom_tool_call 挂起（call 有 call_id 而无对应
// output）——这不能可靠地区分「在等用户」与「在等工具」，所以 waiting 只在
// 明确识别出挂起的输入请求工具（request_user_input_async / ask_user）时给出，
// 其余挂起 call 一律按 working（工具在跑）处理，不假装等用户。

// 明确等用户输入的工具名（codex 会话里实测出现 request_user_input_async）。
const ASK_TOOL_RE = /(^|[^a-z])(request_user_input|ask_user|input)/;

export function codexEmptyState() {
  return {
    sessionId: null,
    createdAt: null,
    cwd: "",
    lastOrdinal: -1,
    lastType: null,
    lastEventAt: null,
    lastUserMsgOrdinal: null,
    currentTurn: null,
    turns: {}, // turn_id → {seq, at}
    calls: {}, // call_id → {seq, name, at}
    asks: {}, // call_id → {seq, at, name}
    tokens: { input: 0, output: 0, cacheRead: 0 },
    counts: { turns: 0, toolCalls: 0, questions: 0 },
    phase: "unknown",
    phaseSinceOrdinal: null,
    phaseRule: null,
    sawActivity: false,
    unknown: { reason: "no-evidence", sinceOrdinal: null },
  };
}

// 从当前集合推导 phase 与等待。纯函数，不修改 state。
export function codexDerive(state) {
  if (state.unknown) {
    return { phase: "unknown", rule: "unknown:" + state.unknown.reason, waiting: null };
  }
  const asks = Object.values(state.asks);
  if (asks.length) {
    const a = asks.sort((x, y) => x.seq - y.seq)[0];
    return {
      phase: "waiting",
      rule: "ask-user-input",
      waiting: { kind: "question", askId: a.name || a.callId, toolName: a.name || null, since: a.at, seq: a.seq },
    };
  }
  const openTurns = Object.keys(state.turns).length;
  const openCalls = Object.keys(state.calls).length;
  if (openTurns || openCalls) {
    return { phase: "working", rule: openCalls ? "tool-open" : "turn-open", waiting: null };
  }
  if (state.lastType === "user-message") {
    // 用户刚说完话、还没 task_started —— 正在起跑，不是空闲。
    return { phase: "working", rule: "user-input-pending-turn", waiting: null };
  }
  if (state.lastType === "task-complete" || state.lastType === "turn-aborted") {
    // 最后一条是收口事件：收工。
    return { phase: "paused", rule: "turn-closed-tail", waiting: null };
  }
  if (state.sawActivity) {
    // 之前跑过东西、现在没有开着 turn/call：收工了。
    return { phase: "paused", rule: "tail-closed", waiting: null };
  }
  if (state.counts.turns > 0) return { phase: "paused", rule: "turn-closed", waiting: null };
  if (state.sessionId) return { phase: "starting", rule: "session-only", waiting: null };
  if (state.lastType) return { phase: "starting", rule: "metadata-only", waiting: null };
  return { phase: "unknown", rule: "no-evidence", waiting: null };
}

function applyPhase(state, { phase, rule, waiting }, seq) {
  state.waiting = waiting ?? null;
  if (state.phase !== phase) {
    state.phase = phase;
    state.phaseSinceOrdinal = seq;
    state.phaseRule = rule;
  }
  return state;
}

// 事件正文文本：content 可能是 string | [{type:"text"|"input_text"|"output_text", text}]。
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
    .join("\n");
}

export function codexReduce(state, ev) {
  const type = ev?.type;
  if (typeof type !== "string") return state;
  const ordinal = typeof ev.ordinal === "number" ? ev.ordinal : null;
  if (ordinal != null && ordinal <= state.lastOrdinal) return state; // 幂等

  const s = { ...state };
  s.turns = state.turns;
  s.calls = state.calls;
  s.asks = state.asks;

  if (ordinal != null) s.lastOrdinal = ordinal;
  if (typeof ev.timestamp === "string") {
    const t = Date.parse(ev.timestamp);
    if (Number.isFinite(t)) s.lastEventAt = t;
  }
  s.lastType = type;

  const payload = ev?.payload ?? {};

  switch (type) {
    case "session_meta": {
      s.sessionId = String(payload?.id ?? payload?.session_id ?? s.sessionId ?? "");
      s.cwd = String(payload?.cwd ?? "");
      break;
    }
    case "event_msg": {
      const et = payload?.type;
      if (et === "task_started") {
        const turnId = String(payload?.turn_id ?? "");
        if (turnId) {
          s.turns = { ...state.turns, [turnId]: { seq: ordinal, at: s.lastEventAt } };
          s.counts = { ...state.counts, turns: state.counts.turns + 1 };
          s.currentTurn = turnId;
        }
        s.sawActivity = true;
        s.lastType = "task-started";
      } else if (et === "task_complete") {
        const turnId = String(payload?.turn_id ?? "");
        s.turns = { ...state.turns };
        delete s.turns[turnId];
        if (s.currentTurn === turnId) s.currentTurn = null;
        s.sawActivity = true;
        s.lastType = "task-complete";
      } else if (et === "turn_aborted") {
        const turnId = String(payload?.turn_id ?? "");
        s.turns = { ...state.turns };
        delete s.turns[turnId];
        if (s.currentTurn === turnId) s.currentTurn = null;
        // 被中断的 turn：它下面挂着的输入请求与工具调用都不会有人答/不会返回。
        const nextAsks = {};
        for (const [cid, a] of Object.entries(s.asks)) {
          if (String(a.turn) !== String(turnId)) nextAsks[cid] = a;
        }
        s.asks = nextAsks;
        // 挂在被中断 turn 下的工具调用也要关闭（它不会再返回 output）。
        const nextCalls = {};
        for (const [cid, c] of Object.entries(s.calls)) {
          if (String(c.turn) !== String(turnId)) nextCalls[cid] = c;
        }
        s.calls = nextCalls;
        s.sawActivity = true;
        s.lastType = "turn-aborted";
      } else if (et === "item_completed") {
        s.sawActivity = true;
        s.lastType = "item-completed";
      }
      break;
    }
    case "response_item": {
      const rt = payload?.type;
      if (rt === "message") {
        const role = String(payload?.role ?? "");
        if (role === "user") {
          s.lastType = "user-message";
          s.lastUserMsgOrdinal = ordinal;
          // 用户答了卡：已上屏的提问被这条消息关闭。
          s.asks = {};
        } else {
          s.lastType = "assistant-message";
          s.sawActivity = true;
        }
      } else if (rt === "custom_tool_call" || rt === "function_call") {
        const callId = String(payload?.call_id ?? payload?.id ?? "");
        const name = String(payload?.name ?? "");
        const turn = String(payload?.turn_id ?? s.currentTurn ?? "");
        if (callId) {
          s.calls = { ...state.calls, [callId]: { seq: ordinal, name, at: s.lastEventAt, turn } };
          if (ASK_TOOL_RE.test(name)) {
            s.asks = { ...state.asks, [callId]: { seq: ordinal, at: s.lastEventAt, name, turn } };
            s.counts = { ...state.counts, questions: state.counts.questions + 1 };
          }
          s.counts = { ...s.counts, toolCalls: s.counts.toolCalls + 1 };
        }
        s.sawActivity = true;
        s.lastType = "tool-call";
      } else if (rt === "custom_tool_call_output" || rt === "function_call_output") {
        const callId = String(payload?.call_id ?? payload?.id ?? "");
        if (callId) {
          s.calls = { ...state.calls };
          delete s.calls[callId];
          // 输入请求有了输出 = 用户答了（或工具返回了），不再等。
          if (s.asks[callId]) {
            const next = { ...s.asks };
            delete next[callId];
            s.asks = next;
          }
        }
        s.sawActivity = true;
        s.lastType = "tool-result";
      }
      break;
    }
    default:
      break;
  }

  // 「还没有证据」只是空状态的哨兵。
  if (s.unknown?.reason === "no-evidence") s.unknown = null;
  return applyPhase(s, codexDerive(s), ordinal);
}

// 带完整性检查的 fold：ordinal 必须严格 +1（会话内每事件递增），出现缺口立即 unknown。
export function codexFold(events, { state = codexEmptyState(), startOrdinal = null } = {}) {
  let s = state;
  let expected = startOrdinal;
  for (const ev of events) {
    const ordinal = typeof ev?.ordinal === "number" ? ev.ordinal : null;
    if (ordinal != null && ordinal <= s.lastOrdinal) continue;
    if (ordinal != null && expected == null) expected = ordinal;
    if (expected != null && ordinal != null && ordinal !== expected) {
      s = { ...s, unknown: { reason: `ordinal-gap:expected:${expected}:got:${ordinal}`, sinceOrdinal: s.lastOrdinal } };
      s = applyPhase(s, codexDerive(s), s.lastOrdinal);
      return s;
    }
    if (ordinal != null) expected = ordinal + 1;
    s = codexReduce(s, ev);
  }
  return s;
}

// 给上层用的摘要：与 DSH fold 的 summary 同构，供 codexSessions 统一消费。
export function codexSummary(state) {
  const d = codexDerive(state);
  const openCalls = Object.values(state.calls).sort((a, b) => b.seq - a.seq);
  const activity = openCalls.length
    ? { tool: openCalls[0].name, since: openCalls[0].at, seq: openCalls[0].seq }
    : Object.keys(state.turns).length
      ? { tool: null, since: null, seq: state.lastOrdinal }
      : null;
  return {
    phase: d.phase,
    rule: state.phaseRule ?? d.rule,
    phaseSinceSeq: state.phaseSinceOrdinal,
    waiting: d.waiting,
    activity,
    title: null,
    lastSeq: state.lastOrdinal,
    lastEventAt: state.lastEventAt,
    unknown: state.unknown,
    tokens: state.tokens,
    counts: state.counts,
  };
}
