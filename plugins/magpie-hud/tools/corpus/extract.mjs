// 语料提取：把 DSH 的 v4 转录读成「带真值的事件流」，产出等待 episode 语料。
//
// 为什么要有它：HUD 现在用 mtime 和正则猜状态，没有任何 precision/recall 数据。
// 这份脚本只做一件事——从原始字节里按事件语义**定义**真值，让后面的验收有据可依：
//
//   等待用户 = 打开且未关闭的等待 episode
//     · 审批：approval/asked{id} 打开，approval/decided{id} 关闭
//     · 提问：tool/call{name=ask_user|exit_plan_mode} 打开，
//             之后第一条 user/message 关闭（DSH 的语义：卡片上屏，答案即下一条消息）
//
// 输出（都在插件目录下）：
//   corpus/labels.jsonl   每条 episode 一行，带来源文件与 seq，可回原始字节复核
//   corpus/stats.json     会话数、事件类型分布、等待时长分位数、解码耗时、seq 缺口
//   corpus/report.md      人读的摘要（EDA）
//
// 用法：node tools/corpus/extract.mjs [根目录]
// 根目录默认 DSH_HOME/sessions 或 ~/.dsh/sessions。
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { decompress } from "fzstd";

const HERE = dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(HERE, "..", "..", "corpus");

function dshRoot() {
  const given = process.argv[2] || process.env.DSH_HOME;
  if (typeof given === "string" && given && isAbsolute(given)) {
    return given.endsWith("sessions") ? given : join(given, "sessions");
  }
  return join(homedir(), ".dsh", "sessions");
}

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zstd")) out.push(p);
  }
  return out;
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
function countFrames(buf) {
  let n = 0;
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) n += 1;
  }
  return n;
}

function decode(file, buf) {
  if (!file.endsWith(".zstd")) return buf.toString("utf8");
  return new TextDecoder().decode(decompress(new Uint8Array(buf)));
}

function quantiles(values, qs = [0.5, 0.9, 0.95, 0.99]) {
  if (!values.length) return {};
  const s = [...values].sort((a, b) => a - b);
  const out = {};
  for (const q of qs) out["p" + Math.round(q * 100)] = s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return out;
}

// 一条事件流 → 统计 + 等待 episode。只认严格的事件语义，不做文本猜测。
function analyze(file, text) {
  const lines = text.split("\n");
  const episodes = [];
  const openApprovals = new Map();
  const openQuestions = new Map(); // 已上屏（result 非错误）的提问，按 call seq
  const pendingCards = new Map(); // 已发出但结果未到的提问 call，按 callId
  const calls = new Map(); // seq → {name, at}
  const typeCounts = new Map();
  let events = 0;
  let badLines = 0;
  let seqGaps = 0;
  let lastSeq = -1;
  let sessionId = "";
  let createdAt = null;
  let cwd = "";
  let firstSeq = null;
  let currentTurn = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { badLines += 1; continue; }
    events += 1;
    const t = j.type ?? "?";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    if (t === "session") {
      sessionId = String(j.id ?? "");
      cwd = String(j.cwd ?? "");
      createdAt = typeof j.createdAt === "number" ? j.createdAt : null;
      continue;
    }
    const seq = typeof j.seq === "number" ? j.seq : null;
    if (seq != null) {
      if (firstSeq == null) firstSeq = seq;
      if (lastSeq >= 0 && seq !== lastSeq + 1) seqGaps += 1;
      lastSeq = seq;
    }
    const at = typeof j.time === "number" ? j.time : null;

    if (t === "turn/start") {
      currentTurn = j.data?.turn ?? currentTurn;
    } else if (t === "turn/end") {
      // 用户打断的 turn：挂着的审批不会再被回答，等待在 turn/end 处结束。
      if (j.data?.reason?.kind === "interrupted") {
        for (const [id, open] of [...openApprovals]) {
          if (String(open.turn) !== String(j.data?.turn)) continue;
          episodes.push({ kind: "approval", sessionId, since: open.at, until: at, askedSeq: open.seq, closedSeq: seq, closeEvent: "turn/end(interrupted)", askId: id, toolName: open.toolName, file });
          openApprovals.delete(id);
        }
      }
      currentTurn = null;
    } else if (t === "tool/call") {
      const callId = String(j.data?.callId ?? "");
      const name = String(j.data?.name ?? "");
      calls.set(seq, { name, at, callId });
      if (name === "ask_user" || name === "ask_user_question" || name === "exit_plan_mode") {
        pendingCards.set(callId, { callId, name, at, seq });
      }
    } else if (t === "tool/result") {
      // 真实形状：callId 在 data.message.source.callId，不在 data.toolCallId。
      const callId = String(j.data?.message?.source?.callId ?? j.data?.toolCallId ?? "");
      const card = pendingCards.get(callId);
      if (card) {
        pendingCards.delete(callId);
        // 卡片只有在结果「非错误」时才算上屏；isError=true 表示提问本身失败了，没有等人。
        // 结果里直接带回 {"answers":[…]} 的（DSH 的 ask_user_question 常见形状）
        // 在落盘那一刻已经答完 —— 转录里没有可观测的等待区间，不算 episode。
        const body = typeof j.data?.message?.content === "string"
          ? j.data.message.content
          : (Array.isArray(j.data?.message?.content) ? j.data.message.content.map((c) => c?.text ?? "").join("\n") : "");
        const answeredInline = /"answers"\s*:/.test(body);
        if (j.data?.message?.isError !== true && !answeredInline) openQuestions.set(card.seq, { ...card, resultSeq: seq });
      }
      // 未决审批的调用已经产出结果（含 interrupted-tool-result）：审批不可能再被回答。
      for (const [id, open] of [...openApprovals]) {
        if (open.callId !== callId) continue;
        episodes.push({ kind: "approval", sessionId, since: open.at, until: at, askedSeq: open.seq, closedSeq: seq, closeEvent: "tool/result(interrupted)", askId: id, toolName: open.toolName, file });
        openApprovals.delete(id);
      }
    } else if (t === "approval/asked") {
      const id = String(j.data?.id ?? "");
      if (id) openApprovals.set(id, { id, at, seq, toolName: String(j.data?.toolName ?? ""), callId: String(j.data?.callId ?? ""), turn: currentTurn });
    } else if (t === "approval/decided") {
      const id = String(j.data?.id ?? "");
      const open = openApprovals.get(id);
      if (open) {
        episodes.push({
          kind: "approval",
          sessionId,
          since: open.at,
          until: at,
          askedSeq: open.seq,
          closedSeq: seq,
          closeEvent: "approval/decided",
          askId: id,
          toolName: open.toolName,
          file,
        });
        openApprovals.delete(id);
      }
    } else if (t === "user/message" || t === "agent/inbox/spliced") {
      // 用户答卡：直接消息与「拼进下一 turn」的 inbox 消息都是答案。
      const isUser = t === "user/message"
        ? j.data?.source?.kind === "user"
        : Array.isArray(j.data?.inserted) && j.data.inserted.some((it) => it?.source?.kind === "user");
      if (isUser && openQuestions.size) {
        const [qseq, q] = [...openQuestions.entries()].sort((a, b) => a[0] - b[0])[0];
        episodes.push({
          kind: "question",
          sessionId,
          since: q.at,
          until: at,
          askedSeq: qseq,
          resultSeq: q.resultSeq,
          closedSeq: seq,
          closeEvent: t,
          askId: q.callId,
          toolName: q.name,
          file,
        });
        openQuestions.delete(qseq);
      }
    }
  }

  // 到文件末尾仍未关闭的：open 为 true，until 为 null（这是「此刻还在等」的真值）
  for (const [id, open] of openApprovals) {
    episodes.push({ kind: "approval", sessionId, since: open.at, until: null, askedSeq: open.seq, closedSeq: null, closeEvent: null, askId: id, toolName: open.toolName, file, open: true });
  }
  for (const [qseq, q] of openQuestions) {
    episodes.push({ kind: "question", sessionId, since: q.at, until: null, askedSeq: qseq, resultSeq: q.resultSeq, closedSeq: null, closeEvent: null, askId: q.callId, toolName: q.name, file, open: true });
  }

  return {
    file, sessionId, cwd, createdAt, events, badLines, seqGaps,
    firstSeq, lastSeq,
    typeCounts: Object.fromEntries(typeCounts),
    episodes,
  };
}

function main() {
  const root = dshRoot();
  const files = walk(root);
  const stats = {
    root,
    at: new Date().toISOString(),
    files: files.length,
    bytes: 0,
    decodedBytes: 0,
    decodeMs: 0,
    frames: 0,
    multiFrameFiles: 0,
    sessions: 0,
    events: 0,
    badLines: 0,
    seqGaps: 0,
    typeCounts: {},
    episodes: { total: 0, approval: 0, question: 0, open: 0 },
    durationsMs: { all: [], approval: [], question: [] },
    filesWithMismatchedSessionId: [],
  };
  const labels = [];

  for (const file of files.sort()) {
    let st;
    try { st = statSync(file); } catch { continue; }
    stats.bytes += st.size;
    let raw;
    try { raw = readFileSync(file); } catch { continue; }
    if (file.endsWith(".zstd")) {
      const frames = countFrames(raw);
      stats.frames += frames;
      if (frames > 1) stats.multiFrameFiles += 1;
    }
    const t0 = performance.now();
    let text;
    try { text = decode(file, raw); } catch { stats.badLines += 1; continue; }
    stats.decodeMs += performance.now() - t0;
    stats.decodedBytes += text.length;

    const a = analyze(file, text);
    stats.sessions += 1;
    stats.events += a.events;
    stats.badLines += a.badLines;
    stats.seqGaps += a.seqGaps;
    for (const [t, n] of Object.entries(a.typeCounts)) stats.typeCounts[t] = (stats.typeCounts[t] ?? 0) + n;
    const dirId = file.split(/[\\/]/).slice(-2, -1)[0];
    if (a.sessionId && dirId && !a.sessionId.includes(dirId)) stats.filesWithMismatchedSessionId.push({ file, dirId, sessionId: a.sessionId });

    for (const e of a.episodes) {
      labels.push({ ...e, file: file.replace(/\\/g, "/") });
      stats.episodes.total += 1;
      stats.episodes[e.kind] += 1;
      if (e.open) stats.episodes.open += 1;
      else if (typeof e.since === "number" && typeof e.until === "number" && e.until >= e.since) {
        stats.durationsMs.all.push(e.until - e.since);
        stats.durationsMs[e.kind].push(e.until - e.since);
      }
    }
  }

  stats.durationQuantiles = {
    all: quantiles(stats.durationsMs.all),
    approval: quantiles(stats.durationsMs.approval),
    question: quantiles(stats.durationsMs.question),
  };
  delete stats.durationsMs;

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "labels.jsonl"), labels.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(OUT, "stats.json"), JSON.stringify(stats, null, 2));

  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) + "%" : "-");
  const report = [
    "# DSH 转录语料 EDA",
    "",
    `生成时间：${stats.at}`,
    `根目录：${stats.root}`,
    "",
    "## 规模",
    "",
    `- 文件：${stats.files}，压缩后 ${(stats.bytes / 1048576).toFixed(1)} MB，解压后文本 ${(stats.decodedBytes / 1048576).toFixed(1)} MB`,
    `- 解码总耗时：${stats.decodeMs.toFixed(0)} ms（纯 JS fzstd，全量解码）`,
    `- zstd 帧：${stats.frames}，多帧文件：${stats.multiFrameFiles}/${stats.files}`,
    `- 事件：${stats.events}，坏行：${stats.badLines}，seq 缺口：${stats.seqGaps}`,
    "",
    "## 等待 episode",
    "",
    `- 总数：${stats.episodes.total}（审批 ${stats.episodes.approval}，提问 ${stats.episodes.question}，仍开着 ${stats.episodes.open}）`,
    `- 时长分位（ms）：${JSON.stringify(stats.durationQuantiles)}`,
    "",
    "## 事件类型（Top 30）",
    "",
    "| 事件 | 次数 |",
    "|---|---|",
    ...Object.entries(stats.typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => `| \`${t}\` | ${n} |`),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), report);
  console.log(report);
  console.log(`labels: ${labels.length} → ${join(OUT, "labels.jsonl")}`);
}

main();
