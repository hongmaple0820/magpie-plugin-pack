// 等待判定的 precision/recall 评测（真值来自 corpus/labels.jsonl 与场景生成器）。
//
// 三组检查，缺一不可：
//   1) 语义层：fold 在 episode 的起点/中点必须 waiting，关闭后必须不是；
//   2) 时间点层：每份转录随机 3 个时刻，predicted waiting 对比真值区间；
//   3) 读取层（场景）：把 zstd 截断在 asked 帧之后，走 readWindow + fold 端到端，
//      必须仍是 waiting —— 证明「窗口没覆盖到起点就漏判」不会发生。
//
// 用法：node tools/eval/waiting.mjs   → corpus/eval-waiting.json + 控制台摘要
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fold, summary } from "../../lib/truth/fold.mjs";
import { readAll, readWindow } from "../../lib/truth/frames.mjs";

const HERE = dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const PLUGIN = join(HERE, "..", "..");
const CACHE = join(PLUGIN, "corpus", "cache");
const OUT = join(PLUGIN, "corpus", "eval-waiting.json");

const readJsonl = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// 解码结果缓存：真实转录全量解码很贵（一次 ~60s），评测要能反复跑。
function eventsOf(file) {
  mkdirSync(CACHE, { recursive: true });
  const st = statSync(file);
  const key = createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
  const cached = join(CACHE, key + ".jsonl");
  if (existsSync(cached)) return readJsonl(cached);
  const all = readAll(file);
  if (all.error) throw new Error(`decode ${file}: ${all.error}`);
  // 只留 seq ≤ maxNeeded 的事件，缓存体积可控；调用方负责传 maxNeeded 前先建索引。
  writeFileSync(cached, all.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return all.events;
}

function foldAt(events, seq) {
  const i = events.findIndex((e) => typeof e.seq === "number" && e.seq >= seq);
  const slice = i < 0 ? events : events.slice(0, i + 1);
  return summary(fold(slice));
}

function resultSeqOf(events, callId) {
  const r = events.find((e) => e.type === "tool/result" && (e.data?.message?.source?.callId ?? e.data?.toolCallId) === callId);
  return r?.seq ?? null;
}

function truthAt(labels, sessionId, seq) {
  return labels.some((l) => {
    const start = l.kind === "question" ? l.resultSeq ?? l.askedSeq + 1 : l.askedSeq;
    const end = l.closedSeq ?? Number.MAX_SAFE_INTEGER;
    return seq >= start && seq < end;
  });
}

function main() {
  const real = readJsonl(join(PLUGIN, "corpus", "labels.jsonl"));
  const scen = readJsonl(join(PLUGIN, "corpus", "scenarios", "labels.jsonl"));
  const labels = [...real, ...scen];

  // 每个文件一次解码，补齐 question 的 resultSeq。
  const byFile = new Map();
  for (const l of labels) {
    if (!byFile.has(l.file)) byFile.set(l.file, []);
    byFile.get(l.file).push(l);
  }
  const eventsByFile = new Map();
  for (const [file, ls] of byFile) {
    const events = eventsOf(file);
    eventsByFile.set(file, events);
    for (const l of ls) {
      if (l.kind !== "question") continue;
      let askId = l.askId;
      if (!askId) {
        // 场景标签不存 askId：用 askedSeq 上的 tool/call 反查。
        const call = events.find((e) => e.seq === l.askedSeq && e.type === "tool/call");
        askId = call?.data?.callId;
      }
      l.resultSeq = askId ? resultSeqOf(events, askId) : null;
    }
  }

  // 经验规则不该只在「被它启发过的数据」上好看：按 sessionId 哈希留出 20% 作 holdout。
  const splitOf = (l) => {
    let h = 0;
    for (const ch of String(l.sessionId)) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
    return (h >>> 0) % 5 === 0 ? "holdout" : "tune";
  };
  for (const l of labels) l.split = splitOf(l);
  // 留出集构成必须报出来：哈希划分是「现算」不是「冻结清单」，而且里面合成场景占比可能很高。
  // 不报构成，读者会把 N 条留出集当成 N 条真实会话。
  const holdLabels = labels.filter((l) => l.split === "holdout");
  const mixOf = (ls) => ({
    realApproval: ls.filter((l) => !l.scenario && l.kind === "approval").length,
    realQuestion: ls.filter((l) => !l.scenario && l.kind === "question").length,
    scenarioApproval: ls.filter((l) => l.scenario && l.kind === "approval").length,
    scenarioQuestion: ls.filter((l) => l.scenario && l.kind === "question").length,
  });
  const holdoutMix = mixOf(holdLabels);

  const sem = { tp: 0, fn: 0, fp: 0, tn: 0, details: [] };
  const semHold = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const t0s = [];
  // 判定「这一条 episode 是否在等」：只看 waiting.seq 是否指向该 episode 的起点。
  // 同一会话可能有多条重叠 episode，关闭一条不代表整体不再 waiting。
  const waitingThis = (got, l) => got.phase === "waiting" && got.waiting?.seq === l.askedSeq;
  for (const l of labels) {
    const events = eventsByFile.get(l.file);
    const checkpoints = [];
    if (l.kind === "approval") checkpoints.push({ at: l.askedSeq, want: true });
    else if (l.resultSeq != null) checkpoints.push({ at: l.resultSeq, want: true });
    // 中点：asked 与 closed 之间的一个事件
    const span = events.filter((e) => typeof e.seq === "number" && e.seq > l.askedSeq && (l.closedSeq == null || e.seq < l.closedSeq));
    if (span.length && l.resultSeq != null) checkpoints.push({ at: span[Math.floor(span.length / 2)].seq, want: true });
    // 关闭点：closed 之后这条 episode 必须不再被报为 waiting；EOF 仍开的则在末尾仍应 waiting。
    if (l.closedSeq != null) checkpoints.push({ at: l.closedSeq, want: false });
    else if (events.length) checkpoints.push({ at: events[events.length - 1].seq, want: true });

    for (const cp of checkpoints) {
      const got = foldAt(events, cp.at);
      const pred = waitingThis(got, l);
      const acc = l.split === "holdout" ? semHold : null;
      if (cp.want && pred) {
        sem.tp += 1;
        if (acc) acc.tp += 1;
        if (typeof got.waiting?.since === "number" && l.since != null) t0s.push(Math.abs(got.waiting.since - l.since));
      } else if (cp.want && !pred) {
        sem.fn += 1;
        if (acc) acc.fn += 1;
        sem.details.push({ file: l.file, kind: l.kind, at: cp.at, verdict: "FN", phase: got.phase, waiting: got.waiting, unknown: got.unknown });
      } else if (!cp.want && pred) {
        sem.fp += 1;
        if (acc) acc.fp += 1;
        sem.details.push({ file: l.file, kind: l.kind, at: cp.at, verdict: "FP", waiting: got.waiting });
      } else {
        sem.tn += 1;
        if (acc) acc.tn += 1;
      }
    }
  }

  // 时间点层：分层采样——每条 episode 内 3 点（必须是 waiting）、同文件 episode 外 3 点（必须不是）。
  // 均匀随机采样会让正例只剩 11 个，指标没有统计意义。
  let rnd = 987654321;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pts = { tp: 0, fn: 0, fp: 0, tn: 0, details: [] };
  const inEpisode = (l, seq) => {
    const start = l.kind === "question" ? l.resultSeq ?? l.askedSeq : l.askedSeq;
    const end = l.closedSeq ?? Number.MAX_SAFE_INTEGER;
    return seq >= start && seq < end;
  };
  for (const l of labels) {
    const events = eventsByFile.get(l.file);
    const seqs = events.filter((e) => typeof e.seq === "number").map((e) => e.seq);
    if (!seqs.length) continue;
    const start = l.kind === "question" ? l.resultSeq ?? l.askedSeq : l.askedSeq;
    const end = l.closedSeq ?? seqs[seqs.length - 1] + 1;
    const fileLabels = labels.filter((x) => x.file === l.file);
    const inside = seqs.filter((s) => s >= start && s < end);
    const outside = seqs.filter((s) => !truthAt(fileLabels, null, s));
    for (let k = 0; k < 3; k += 1) {
      if (inside.length) pts_pred(inside[Math.floor(rand() * inside.length)], true, l);
      if (outside.length) pts_pred(outside[Math.floor(rand() * outside.length)], false, l);
    }
  }
  function pts_pred(seq, truth, l) {
    const events = eventsByFile.get(l.file);
    const got = foldAt(events, seq);
    const pred = got.phase === "waiting";
    if (truth && pred) pts.tp += 1;
    else if (truth && !pred) { pts.fn += 1; pts.details.push({ file: l.file, seq, verdict: "FN", phase: got.phase }); }
    else if (!truth && pred) { pts.fp += 1; pts.details.push({ file: l.file, seq, verdict: "FP", waiting: got.waiting }); }
    else pts.tn += 1;
  }

  // 读取层：场景文件截断在 asked 帧之后，走 readWindow + fold
  const frames = JSON.parse(readFileSync(join(PLUGIN, "corpus", "scenarios", "frames.json"), "utf8"));
  const frameById = new Map(frames.map((f) => [f.id, f.frames]));
  let winOk = 0;
  const winFail = [];
  const tmp = join(PLUGIN, "corpus", "cache");
  mkdirSync(tmp, { recursive: true });
  for (const l of scen) {
    const id = l.sessionId;
    const need = l.resultSeq ?? l.askedSeq;
    const idx = frameById.get(id);
    if (!idx) continue;
    // 精确停在「等待刚开始」那一帧的末尾：模拟真实文件恰好写完 asked/result、关闭还没到。
    const frame = idx.find((f) => f.lastSeq === need) ?? idx.find((f) => f.lastSeq >= need);
    if (!frame) continue;
    const raw = readFileSync(l.file);
    const cut = join(tmp, `cut-${id}-${l.askedSeq}.zstd`);
    writeFileSync(cut, raw.subarray(0, frame.end));
    const w = readWindow(cut, { maxBytes: 256 * 1024, maxFrames: 64 });
    rmSync(cut, { force: true });
    const got = summary(fold(w.events));
    if (w.error || got.phase !== "waiting") winFail.push({ file: id, seq: l.askedSeq, error: w.error, phase: got.phase, events: w.events.length });
    else winOk += 1;
  }

  const pr = (x) => ({
    precision: x.tp + x.fp ? x.tp / (x.tp + x.fp) : null,
    recall: x.tp + x.fn ? x.tp / (x.tp + x.fn) : null,
    tp: x.tp, fp: x.fp, fn: x.fn, tn: x.tn,
  });
  t0s.sort((a, b) => a - b);
  const out = {
    at: new Date().toISOString(),
    labels: { real: real.length, scenario: scen.length, total: labels.length },
    holdout: {
      labels: holdLabels.length,
      metric: pr(semHold),
      mix: holdoutMix,
      splitRule: "sessionId 哈希 % 5 === 0（每次运行现算，未冻结清单）",
    },
    files: byFile.size,
    semantic: pr(sem),
    pointwise: pr(pts),
    sinceErrorMs: { p50: t0s[Math.floor(t0s.length / 2)] ?? null, max: t0s[t0s.length - 1] ?? null, samples: t0s.length },
    windowPath: { ok: winOk, fail: winFail.length, failures: winFail.slice(0, 10) },
    semanticDetails: sem.details.slice(0, 20),
    pointDetails: pts.details.slice(0, 20),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
