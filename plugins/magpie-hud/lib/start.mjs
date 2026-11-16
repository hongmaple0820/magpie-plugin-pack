// start_session（M4）：起新会话，首条消息就是调用方的。
//
// 协议照 Agent HUD messaging/start.rs + platform/delivery/starts：
//   Claude：spawn `claude --bg -- <text>`（cwd=folder，30 秒），输出里带
//   "backgrounded" 的行拆出十六进制 job id，再轮询
//   <CLAUDE_CONFIG_DIR>/jobs/<job>/state.json 的 sessionId（uuid，20×250ms）。
//   Codex：app-server thread/start {cwd, ephemeral:false} → thread/name/set →
//   首条消息入队（thread/queue/add）→ 打开 codex://threads/wake/<id>。
// folder 为空时用独立任务夹 <home>/.magpie-agents/tasks/<client>/<requestId>。
// 计一棒（照 start 的 next_pass）；答复由 get_message 从新会话转录读。
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { queueAdd, startThread, wakeThread } from "./delivery/codex.mjs";
import { texts } from "./words.mjs";

const CLAUDE_TIMEOUT_MS = 30_000;
const JOB_POLLS = 20;
const JOB_POLL_MS = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function claudeCommand() {
  return (process.env.MAGPIE_AGENTS_CLAUDE_CMD || "claude").split(/\s+/).filter(Boolean);
}

function claudeConfigDir() {
  if (process.env.MAGPIE_AGENTS_HOME) return join(process.env.MAGPIE_AGENTS_HOME, ".claude");
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 跑一条命令拿输出（照 runner.run：超时或退出码非 0 都如实报）。
function run(command, args, folder, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: folder, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ error: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
  });
}

// 从 claude --bg 的输出里拆 job id（照 start_claude：带 "backgrounded" 的
// 行按空白/·切开，取第一个 ≥6 位十六进制的词）。
function jobIdFrom(output) {
  for (const line of output.split("\n")) {
    if (!line.includes("backgrounded")) continue;
    for (const word of line.split(/[\s·]+/)) {
      if (word.length >= 6 && /^[0-9a-f]+$/i.test(word)) return word;
    }
  }
  return null;
}

// Claude 后台 job 的 state.json（照 job_state）。
function jobStatePath(job) {
  return join(claudeConfigDir(), "jobs", job, "state.json");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 起一个 Claude Code 后台会话。返回 {sessionId} 或 {reason}。
async function startClaude(folder, text) {
  const [cmd, ...base] = claudeCommand();
  const output = await run(cmd, [...base, "--bg", "--", text], folder, CLAUDE_TIMEOUT_MS);
  if (output.error) return { reason: "Claude Code 启动失败：" + output.error };
  if (output.timedOut) return { reason: "Claude Code 启动超时，会话可能仍在建。" };
  if (output.code !== 0) {
    return { reason: "Claude Code 拒绝启动后台会话：" + (output.stderr || output.stdout).trim().slice(0, 200) };
  }
  const job = jobIdFrom(output.stdout + "\n" + output.stderr);
  if (!job) return { reason: "Claude Code 没报后台 job id，会话状态不确定。" };
  for (let i = 0; i < JOB_POLLS; i++) {
    const state = readJson(jobStatePath(job));
    const sessionId = state?.sessionId;
    if (typeof sessionId === "string" && UUID.test(sessionId)) {
      return { sessionId };
    }
    await sleep(JOB_POLL_MS);
  }
  return { reason: "Claude Code 后台会话还没报出 sessionId，稍后用 list_sessions 找它。" };
}

// 起一个 Codex 线程并把首条消息入队。返回 {sessionId} 或 {reason}。
async function startCodex(folder, text, title, clientMessageId) {
  try {
    const { threadId } = await startThread(folder, title);
    await queueAdd(threadId, text, clientMessageId);
    wakeThread(threadId);
    return { sessionId: threadId };
  } catch (error) {
    return { reason: error?.message ?? String(error) };
  }
}

// start_session 主体。args: {client, folder, text}；ctx: {caller, limit}。
// 返回 {id, state, reason, session} 供 journal 记账与工具返回。
export async function startSession(args, { caller, limit = 10, count = 1, startFolders = null } = {}) {
  const client = (args?.client ?? "").trim();
  const text = String(args?.text ?? "").trim();
  if (!client) return { refused: texts.start.noClient() };
  if (!text) return { refused: texts.start.noText() };
  if (text.startsWith("/")) return { refused: texts.slash() };
  if (text.length > 1024 * 1024) return { refused: texts.start.noText() };
  if (client !== "claude" && client !== "codex") {
    return { refused: texts.start.unsupportedClient(client) };
  }
  if (count > limit) {
    return { refused: texts.limit(limit) };
  }

  const requestId = randomUUID();
  let folder = (args?.folder ?? "").trim();
  if (folder) {
    // 照 Agent HUD：folder 必须是 list_sessions 的 startFolders 里给这个
    // 客户端 offer 的项目夹（或显式 "" 选独立任务）。不给 startFolders
    // 的老调用方放行，由存在性兜底。
    const offered = startFolders?.[client]?.folders;
    if (offered && !offered.includes(folder)) {
      return { refused: "folder 不在 list_sessions 的 startFolders 里：只能在这些项目夹或空 folder（独立任务）里选。" };
    }
    let stat;
    try { stat = statSync(folder); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) return { refused: texts.start.folderMissing() };
  } else {
    folder = join(homeDir(), ".magpie-agents", "tasks", client, requestId);
    try { mkdirSync(folder, { recursive: true }); } catch (error) {
      return { refused: texts.start.taskFolder() + "：" + (error?.message ?? error) };
    }
  }

  const title = text.split("\n")[0].trim().slice(0, 40) || text.slice(0, 40);
  const clientMessageId = "magpie-agents:" + requestId;
  const started =
    client === "claude"
      ? await startClaude(folder, text)
      : await startCodex(folder, text, title, clientMessageId);

  if (started.reason) {
    return {
      state: "uncertain",
      reason: started.reason,
      session: null,
      requestId,
      folder,
    };
  }
  return {
    state: "started",
    reason: null,
    session: started.sessionId,
    requestId,
    folder,
  };
}
