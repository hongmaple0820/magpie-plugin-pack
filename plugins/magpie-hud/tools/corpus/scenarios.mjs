// 带真值的场景生成器：造 40 个会话 × 3 个等待 episode（累计 120 条），
// 每条都在生成时就知道「何时开始等、何时结束」，不需要事后推断。
//
// 产物（corpus/scenarios/）：
//   <id>.jsonl.zstd   多帧追加的真实格式转录（用 node:zlib 压，生产用 fzstd 解）
//   <id>.jsonl        同一事件的明文（第二实现/差分用）
//   labels.jsonl      每条 episode 的真值：kind/since/until/askedSeq/closedSeq
//   manifest.json     生成参数与种子（可复跑）
//
// 用法：node tools/corpus/scenarios.mjs [会话数=40]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

const HERE = dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(HERE, "..", "..", "corpus", "scenarios");
const SESSIONS = Number(process.argv[2] || 40);
export const SEED = 20261115;

function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_TIME = 1792000000000;

export function buildScenario(seed, sessionIndex) {
  const rnd = mulberry32(seed + sessionIndex);
  const id = `scenario-${String(sessionIndex).padStart(3, "0")}`;
  let seq = 0;
  let t = BASE_TIME + sessionIndex * 3_600_000;
  const events = [];
  const episodes = [];
  let turn = 0;
  let step = 0;
  const push = (type, data = {}, extra = {}) => {
    const e = { type, seq, time: t, data, ...extra };
    events.push(e);
    seq += 1;
    return e;
  };
  push("session", { id, cwd: "/proj/" + id, createdAt: t, version: 4 }, { id, cwd: "/proj/" + id, createdAt: t });

  for (let ep = 0; ep < 3; ep += 1) {
    turn += 1;
    push("turn/start", { turn });
    step += 1;
    push("step/start", { turn, step });
    push("assistant/message", { usage: { inputTokens: 100 + ep, outputTokens: 50, cacheReadTokens: 20 } });
    t += 5_000;

    const kind = (sessionIndex + ep) % 2 === 0 ? "approval" : "question";
    if (kind === "approval") {
      const callId = `call-${id}-${ep}`;
      push("tool/call", { turn, step, callId, name: ep === 0 ? "pwsh" : "run_code", arguments: "{}" });
      t += 1_000;
      const askId = `approval-${id}-${ep}`;
      const asked = push("approval/asked", { id: askId, toolName: ep === 0 ? "pwsh" : "run_code", reason: "needs approval" });
      // 等待时长：从 30 秒到 40 分钟，模拟真实分布（p50 91s，p99 17.8h）
      const waitMs = Math.round(30_000 + rnd() * 2_400_000);
      t += waitMs;
      const decided = push("approval/decided", { id: askId, outcome: "allowed-once" });
      push("tool/result", { turn, step, toolCallId: callId, message: { role: "tool", isError: false } });
      episodes.push({ sessionId: id, kind: "approval", since: asked.time, until: decided.time, askedSeq: asked.seq, closedSeq: decided.seq, closeEvent: "approval/decided" });
    } else {
      const callId = `call-${id}-${ep}`;
      const call = push("tool/call", { turn, step, callId, name: ep === 1 ? "ask_user" : "exit_plan_mode", arguments: "{}" });
      t += 800;
      const card = push("tool/result", { turn, step, toolCallId: callId, message: { role: "tool", isError: false, content: "The card is on screen" } });
      const waitMs = Math.round(20_000 + rnd() * 600_000);
      t += waitMs;
      const answered = push("user/message", { source: { kind: "user" }, content: "答案" });
      episodes.push({ sessionId: id, kind: "question", since: call.time, until: answered.time, askedSeq: call.seq, resultSeq: card.seq, closedSeq: answered.seq, closeEvent: "user/message" });
    }
    t += 3_000;
    push("tool/result", { turn, step, toolCallId: `call-${id}-${ep}`, message: { role: "tool", isError: false } });
    push("step/end", { turn, step });
  }
  push("session/title", { title: `scenario ${sessionIndex}` });
  push("turn/start", { turn: turn + 1 });
  push("assistant/message", { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
  push("turn/end", { turn: turn + 1 });

  return { id, events, episodes };
}

// 按真实写法切帧：每个帧 1–6 个事件，整帧追加。
// boundaries 里的 seq 之后必须强制收帧：否则「等待刚开始」与「等待已结束」会落进同一帧，
// 截断测试就无法模拟「文件恰好写完 asked 帧、decided 还没到」的真实时刻。
function frameChunks(events, rnd, boundaries = new Set()) {
  const frames = [];
  let i = 0;
  while (i < events.length) {
    const maxN = 1 + Math.floor(rnd() * 6);
    let n = 1;
    while (n < maxN && i + n < events.length && !boundaries.has(events[i + n - 1].seq)) n += 1;
    frames.push(events.slice(i, i + n));
    i += n;
  }
  return frames;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const labels = [];
  const frameIndex = [];
  for (let s = 0; s < SESSIONS; s += 1) {
    const rnd = mulberry32(SEED + s * 31);
    const { id, events, episodes } = buildScenario(SEED, s);
    const boundaries = new Set(episodes.map((ep) => (ep.kind === "question" ? ep.resultSeq : ep.askedSeq)));
    const frames = frameChunks(events, rnd, boundaries);
    const parts = frames.map((fr) => Buffer.from(zstdCompressSync(Buffer.from(fr.map((e) => JSON.stringify(e)).join("\n") + "\n"))));
    let at = 0;
    const idx = frames.map((fr, i) => {
      const f = { start: at, end: at + parts[i].length, firstSeq: fr[0].seq, lastSeq: fr[fr.length - 1].seq };
      at += parts[i].length;
      return f;
    });
    writeFileSync(join(OUT, `${id}.jsonl.zstd`), Buffer.concat(parts));
    writeFileSync(join(OUT, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    frameIndex.push({ id, frames: idx });
    for (const ep of episodes) labels.push({ ...ep, scenario: true, file: join(OUT, `${id}.jsonl.zstd`).replace(/\\/g, "/") });
  }
  writeFileSync(join(OUT, "labels.jsonl"), labels.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(OUT, "frames.json"), JSON.stringify(frameIndex));
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ seed: SEED, sessions: SESSIONS, episodes: labels.length, at: new Date().toISOString() }, null, 2));
  console.log(`scenarios: ${SESSIONS} sessions, ${labels.length} episodes → ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
