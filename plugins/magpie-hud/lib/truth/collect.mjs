// 会话真值读取：把「转录文件 + tap」变成「此刻在干什么/在等什么」的带证据结论。
//
// 约束（docs/magpie-hud-truth-model.md §5、§7）：
//   · 热路径只读窗口，绝不整份解压；增量只读文件尾新追加的帧；
//   · 结论必须带证据（读到哪段字节/哪条事件、哪条规则、哪个 seq）；
//   · 读不动/看不懂时返回 unknown，绝不退回 mtime 猜测；
//   · tap（进程内直抄）与转录是两份独立证据：谁更靠后用谁的结论，
//     两边都读到同一个 seq 却结论不同 → unknown，交给人看。
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { channelRoot } from "../channel.mjs";
import { fold, summary } from "./fold.mjs";
import { readAppend, readWindow } from "./frames.mjs";
import { readTapFrom, tapPath } from "./tap.mjs";

// phase → HUD 的 state 词表（页面只认 running/idle，unknown 单独显示）。
const PHASE_STATE = {
  // starting：只写了会话头，还没有任何 turn —— 它是「还没跑」，不是「在跑」。
  starting: "idle",
  working: "running",
  waiting: "running",
  paused: "idle",
  unknown: "unknown",
};

// working 的时效：事件真值没有时间维度——「turn 开着」的会话哪怕 24 天没写盘
// 也被判 working（实测有一份 2026-10-22 的 user-input-pending-turn 至今挂着）。
// lastEventAt 距 now 超过这个阈值的 working 降级为 idle（rule 标 stale-working），
// 等你（waiting）不降级：宁可多报一个等你，不漏报。
const STALE_WORKING_MS = 10 * 60_000;

function staleAdjust(phase, state, rule, lastEventAt, now) {
  if (phase !== "working" || state !== "running") return { state, rule };
  if (typeof lastEventAt !== "number") return { state, rule };
  if (now - lastEventAt <= STALE_WORKING_MS) return { state, rule };
  return { state: "idle", rule: "stale-working" };
}

const memo = new Map(); // file → { size, mtimeMs, tapSize, tapMtime, state, result }
const tapMemo = new Map(); // tapFile → { next, state, lastSeq }

function snapshot(state, { size, offset, mtimeMs, truncated, error, mode = "events", cross = null, tailBytes = 0, tailKind = null }) {
  const s = summary(state);
  const adj = staleAdjust(s.phase, PHASE_STATE[s.phase] ?? "unknown", s.rule, s.lastEventAt, Date.now());
  return {
    phase: s.phase,
    state: adj.state,
    rule: adj.rule,
    title: s.title ?? null,
    phaseSinceSeq: s.phaseSinceSeq,
    waiting: s.waiting,
    activity: s.activity,
    lastSeq: s.lastSeq,
    lastEventAt: s.lastEventAt,
    unknown: s.unknown,
    tokens: s.tokens,
    counts: s.counts,
    evidence: {
      mode,
      bytes: { offset, size, truncated: Boolean(truncated), tailBytes, tailKind },
      mtimeMs,
      error: error ?? null,
      rule: s.rule,
      seq: s.lastSeq,
      cross,
    },
  };
}

function sessionIdOf(file) {
  try {
    return basename(dirname(file));
  } catch {
    return "";
  }
}

// tap 的 phase：从文件头开始折（tap 自己保证整行、滚动后从新 seq 起算）。
function tapTruth(tapFile, now) {
  if (!tapFile) return null;
  const prev = tapMemo.get(tapFile);
  const r = readTapFrom(tapFile, prev?.next ?? 0);
  if (!r.exists) {
    tapMemo.delete(tapFile);
    return null;
  }
  if (r.error) return { phase: "unknown", rule: `unknown:${r.error}`, state: "unknown", lastSeq: prev?.lastSeq ?? null, evidence: { mode: "tap", error: r.error } };
  let state = r.rotated ? null : prev?.state ?? null;
  let lastSeq = r.rotated ? null : prev?.lastSeq ?? null;
  if (r.events.length > 0) {
    const first = r.events[0].seq;
    // 滚动后的新文件从中间 seq 开始：这说明 tap 是片段，不能假装从头看过。
    const opts = state ? { state } : { startSeq: first };
    const folded = fold(r.events, opts);
    state = folded;
    lastSeq = folded.lastSeq;
    tapMemo.set(tapFile, { next: r.next, state, lastSeq });
  } else if (r.next !== (prev?.next ?? 0)) {
    tapMemo.set(tapFile, { next: r.next, state: prev?.state ?? null, lastSeq: prev?.lastSeq ?? null });
  }
  if (!state) return null;
  const s = summary(state);
  const adj = staleAdjust(s.phase, PHASE_STATE[s.phase] ?? "unknown", s.rule, s.lastEventAt, Date.now());
  return {
    phase: s.phase,
    rule: adj.rule,
    state: adj.state,
    title: s.title ?? null,
    waiting: s.waiting,
    lastSeq: s.lastSeq,
    phaseSinceSeq: s.phaseSinceSeq,
    unknown: s.unknown,
    evidence: { mode: "tap", bytes: { offset: 0, size: r.size, truncated: state.unknown?.reason === "seq-gap" }, mtimeMs: r.mtimeMs, error: null, rule: s.rule, seq: s.lastSeq },
  };
}

/**
 * 仲裁：转录结论 base 与 tap 结论。
 *   · tap 没有 / 更旧 → 信转录，cross 里记 tap 到哪了；
 *   · tap 更新     → 用 tap 的结论（转录还没落盘时，tap 才知道真相）；
 *   · 同一 seq 但结论不同 → unknown（两份证据打架，不替它们猜）。
 */
function arbitrate(base, tap, reused) {
  const trSeq = Number.isFinite(base.lastSeq) ? base.lastSeq : -1;
  if (!tap || !Number.isFinite(tap.lastSeq)) {
    return { ...base, evidence: { ...base.evidence, cross: tap ? { mode: "tap", seq: null } : null } };
  }
  if (tap.lastSeq > trSeq) {
    const adj = staleAdjust(tap.phase, PHASE_STATE[tap.phase] ?? "unknown", tap.rule, tap.lastEventAt ?? base.evidence?.mtimeMs, Date.now());
    return {
      ...base,
      phase: tap.phase,
      state: adj.state,
      rule: adj.rule,
      title: tap.title ?? base.title ?? null,
      phaseSinceSeq: tap.phaseSinceSeq,
      waiting: tap.waiting ?? null,
      unknown: tap.unknown ?? null,
      lastSeq: tap.lastSeq,
      evidence: { ...tap.evidence, cross: { mode: "transcript", seq: trSeq, phase: base.phase, rule: base.rule } },
    };
  }
  if (tap.lastSeq === trSeq) {
    const agree = tap.phase === base.phase && (tap.waiting?.seq ?? null) === (base.waiting?.seq ?? null);
    if (agree) {
      return { ...base, evidence: { ...base.evidence, mode: "both", cross: { mode: "tap", seq: tap.lastSeq, phase: tap.phase, rule: tap.rule } } };
    }
    return {
      ...base,
      phase: "unknown",
      state: "unknown",
      rule: "unknown:tap-mismatch",
      waiting: null,
      unknown: { reason: "tap-mismatch", sinceSeq: tap.lastSeq },
      evidence: {
        ...base.evidence,
        mode: "both",
        cross: { mode: "tap", seq: tap.lastSeq, phase: tap.phase, rule: tap.rule, transcriptPhase: base.phase },
      },
    };
  }
  return { ...base, evidence: { ...base.evidence, cross: { mode: "tap", seq: tap.lastSeq, phase: tap.phase, rule: tap.rule, stale: true } } };
}

/**
 * 读一个 DSH v4 转录，返回 phase/waiting/evidence。
 * st 可传入已 stat 的结果；不传则现场 stat（可能抛，调用方兜底）。
 * options.tapDir：tap 目录（默认 channelRoot()/tap）；传 false 关闭 tap 仲裁。
 */
export function sessionTruth(file, st = statSync(file), { maxBytes = 128 * 1024, tapDir } = {}) {
  const dir = tapDir === false ? null : typeof tapDir === "string" ? tapDir : join(channelRoot(), "tap");
  const tapFile = dir ? tapPath(dir, sessionIdOf(file)) : null;
  const tapInfo = tapFile
    ? (() => {
        try {
          const s = statSync(tapFile);
          return { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      })()
    : null;

  const prev = memo.get(file);
  const tapSize = tapInfo?.size ?? null;
  const tapMtime = tapInfo?.mtimeMs ?? null;
  const same = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.tapSize === tapSize && prev.tapMtime === tapMtime;
  if (same) return prev.result;

  const trUnchanged = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.base;
  if (trUnchanged) {
    // 转录没变、只有 tap 变了：直接用上次的转录结论，重新仲裁即可。
    const tap = tapTruth(tapFile, Date.now());
    const result = arbitrate(prev.base, tap, true);
    memo.set(file, { size: st.size, mtimeMs: st.mtimeMs, tapSize: tapInfo?.size ?? null, tapMtime: tapInfo?.mtimeMs ?? null, state: prev.state, base: prev.base, result });
    return result;
  }

  let state = null;
  let result = null;
  let transcriptDone = false;

  // 快路径：文件只追加（最常见），只解新帧并接到上次状态后面。
  if (prev && !prev.result.unknown && prev.state && prev.size < st.size && prev.state.lastSeq >= 0) {
    const ap = readAppend(file, prev.size, { expectedSeq: prev.state.lastSeq });
    if (!ap.error) {
      state = fold(ap.events, { state: prev.state });
      result = snapshot(state, {
        size: st.size,
        offset: prev.result.evidence.bytes.offset,
        mtimeMs: st.mtimeMs,
        truncated: prev.result.evidence.bytes.truncated,
        error: null,
      });
      transcriptDone = true;
    }
  }

  if (!transcriptDone) {
    // 慢路径：改写过、第一次读、或上次是 unknown —— 读窗口重建。
    const w = readWindow(file, { maxBytes });
    if (w.error || w.tailKind === "garbage") {
      // 解码失败 / 尾部是不可解的垃圾：不是「空闲」，也不是「在跑」，是「不知道」。
      const reason = w.error ?? "tail-garbage";
      state = fold([], {});
      state = { ...state, unknown: { reason: `decode:${reason}`, sinceSeq: null }, phase: "unknown", phaseRule: "unknown:decode" };
      result = snapshot(state, { size: st.size, offset: 0, mtimeMs: st.mtimeMs, truncated: true, error: reason });
    } else {
      state = fold(w.events);
      result = snapshot(state, {
        size: w.size ?? st.size,
        offset: w.offset ?? 0,
        mtimeMs: w.mtimeMs ?? st.mtimeMs,
        truncated: w.truncated,
        tailBytes: w.tailBytes,
        tailKind: w.tailKind,
        error: null,
      });
    }
  }

  const base = result;
  result = arbitrate(base, tapTruth(tapFile, Date.now()), false);

  memo.set(file, { size: st.size, mtimeMs: st.mtimeMs, tapSize: tapInfo?.size ?? null, tapMtime: tapInfo?.mtimeMs ?? null, state, base, result });
  return result;
}

// 单测用：清掉进程内缓存。
export function resetTruthCache() {
  memo.clear();
  tapMemo.clear();
}
