// Codex 会话真值读取：把「转录文件」变成「此刻在干什么」的带证据结论。
//
// 与 DSH 的 lib/truth/collect.mjs 对齐，但只处理 codex 的转录：
//   · codex 会话是单文件 jsonl（.jsonl 明文或 .zst/.zstd 整帧压缩），
//     没有 DSH 那样的多帧追加布局，所以「增量读」不适用——每次读尾部窗口。
//   · 只读尾部窗口即可判断当前状态：turn 开着没、工具在跑没。
//   · 读不动/看不懂返回 unknown，绝不退回 mtime 猜测。
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { codexFold, codexSummary } from "./codex-fold.mjs";

const zstd = await import("fzstd").then((m) => m.decompress, () => null);

// 尾部窗口：只折叠末尾这么多行，足以判断 turn/工具是否开着。
const TAIL_LINES = 400;

function codexSessionId(file) {
  try {
    const base = basename(file);
    // rollout-<ts>-<uuid>.jsonl(.zst|.zstd)
    const m = /^rollout-.*-([0-9a-f-]{36})\.jsonl(\.zst|\.zstd)?$/.exec(base);
    if (m) return m[1];
    return base.replace(/\.jsonl(\.zst|\.zstd)?$/, "");
  } catch {
    return basename(file);
  }
}

// 解压：.zst/.zstd 用 fzstd 整帧解；明文直读。解压器不在/帧坏返回 ""。
function readText(file) {
  const raw = readFileSync(file);
  if (!/\.zst|\.zstd$/.test(file)) return raw.toString("utf8");
  if (!zstd) return "";
  try {
    return new TextDecoder().decode(zstd(new Uint8Array(raw)));
  } catch {
    return "";
  }
}

// 读尾部窗口：解整份后取末尾 TAIL_LINES 行折叠。
function readTailEvents(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { events: [], error: "stat", size: 0, mtimeMs: 0 };
  }
  const full = readText(file);
  if (!full) return { events: [], error: "decode", size: st.size, mtimeMs: st.mtimeMs };
  const all = full.split("\n").filter((l) => l.trim());
  if (!all.length) return { events: [], error: "empty", size: st.size, mtimeMs: st.mtimeMs };
  const lines = all.slice(-TAIL_LINES);
  const events = [];
  let bad = 0;
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (j && typeof j.type === "string") events.push(j);
    } catch {
      bad += 1;
    }
  }
  return {
    events,
    error: bad > 0 ? `bad-lines:${bad}` : null,
    truncated: all.length > TAIL_LINES,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * 读一个 codex 转录，返回 phase/waiting/evidence（与 DSH sessionTruth 同构）。
 * st 可传入已 stat 的结果。
 */
export function codexTruth(file, st = statSync(file)) {
  const { events, error, truncated, size, mtimeMs } = readTailEvents(file);
  if (error) {
    return {
      phase: "unknown",
      rule: "unknown:" + error,
      state: "unknown",
      lastSeq: null,
      lastEventAt: null,
      unknown: { reason: error, sinceSeq: null },
      evidence: { mode: "transcript", bytes: { offset: 0, size, truncated: true }, mtimeMs, error, rule: null, seq: null },
    };
  }
  const folded = codexFold(events);
  const s = codexSummary(folded);
  const state = { starting: "idle", working: "running", waiting: "running", paused: "idle", unknown: "unknown" }[s.phase] ?? "unknown";
  return {
    phase: s.phase,
    state,
    rule: s.rule,
    title: null,
    phaseSinceSeq: s.phaseSinceSeq,
    waiting: s.waiting,
    activity: s.activity,
    lastSeq: s.lastSeq,
    lastEventAt: s.lastEventAt,
    unknown: s.unknown,
    tokens: s.tokens,
    counts: s.counts,
    evidence: {
      mode: "transcript",
      bytes: { offset: 0, size, truncated: Boolean(truncated) },
      mtimeMs,
      error: null,
      rule: s.rule,
      seq: s.lastSeq,
    },
  };
}

export { codexSessionId };
