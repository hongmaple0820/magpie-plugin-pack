// Codex 投递（M5）：经 Codex 自家队列送消息，不打断进行中的回合。
//
// 协议照 Agent HUD platform crate delivery/codex（windows.rs 的 enqueue_stdio
// 与 starts/clients.rs 的 start_codex），不猜：
//   spawn `codex app-server --listen stdio://`（CODEX_HOME）
//   initialize → initialized → thread/queue/add {threadId, clientUserMessageId,
//   input:[{type:"text",text,text_elements:[]}]}，result 里有 queuedSubmission
//   对象即入队成功；新会话另用 thread/start {cwd, ephemeral:false} →
//   thread/name/set {threadId,name}，再把首条消息入队，最后打开
//   codex://threads/wake/<id> 唤醒桌面端。
// Windows 无共享 CLI 守护进程，队列是唯一不打断的路径（SUPPORTED=true）。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DEADLINE_MS = 25_000;

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function codexCommand() {
  return (process.env.MAGPIE_AGENTS_CODEX_CMD || "codex").split(/\s+/).filter(Boolean);
}

export function codexHome() {
  if (process.env.MAGPIE_AGENTS_HOME) return join(process.env.MAGPIE_AGENTS_HOME, ".codex");
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

// 一次短命 app-server 会话：initialize → initialized → 按序发请求，收齐答复
// 后退出。requests: [{method, params}]。返回 {error} 或 {answers: [result…]}。
function appServerSession(requests) {
  return new Promise((resolve) => {
    const [cmd, ...base] = codexCommand();
    let child;
    try {
      child = spawn(cmd, [...base, "app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_HOME: codexHome() },
      });
    } catch (error) {
      resolve({ error: "Codex app-server could not start: " + error.message });
      return;
    }
    let buffer = "";
    let settled = false;
    let dispatched = false; // initialize 答复后，正式请求都发出去了
    const answers = new Map(); // id -> result
    const pending = new Set(); // 还没答的请求 id
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ answers: [...answers.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ error });
    };
    const timer = setTimeout(() => fail("Codex app-server timed out"), DEADLINE_MS);
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", (error) => fail("Codex engine (codex command) not found: " + error.message));
    child.on("exit", () => {
      if (!settled) fail("Codex app-server exited before answering");
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const id = typeof message?.id === "number" ? message.id : null;
        if (id === null) continue;
        if (message.error && typeof message.error === "object") {
          fail("Codex app-server: " + (message.error.message ?? "error"));
          continue;
        }
        if (message.result === undefined) continue;
        answers.set(id, message.result);
        pending.delete(id);
        if (id === 1 && !dispatched) {
          // initialize 答复到了：发 initialized 通知，再发正式请求
          send({ method: "initialized" });
          let next = 2;
          for (const request of requests) {
            pending.add(next);
            send({ id: next, method: request.method, params: request.params ?? {} });
            next++;
          }
          dispatched = true;
        }
        if (dispatched && pending.size === 0) finish();
      }
    });
    pending.add(1);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "magpie-agents", title: "magpie-agents", version: "0.1.0" } } });
  });
}

// 把一条消息加进 Codex 线程队列（照 enqueue_stdio / queue_created）。
// 返回 true（入队成功）或抛错。
export async function queueAdd(threadId, text, clientMessageId) {
  const session = await appServerSession([
    {
      method: "thread/queue/add",
      params: {
        threadId,
        clientUserMessageId: clientMessageId,
        input: [{ type: "text", text, text_elements: [] }],
      },
    },
  ]);
  if (session.error) throw new Error(session.error);
  // answers[0] 是 initialize 的答复，最后一个才是正式请求的
  const result = session.answers.at(-1);
  if (!result || typeof result !== "object" || !result.queuedSubmission || typeof result.queuedSubmission !== "object") {
    throw new Error("Codex did not confirm the message was queued");
  }
  return true;
}

// 起新 Codex 线程（照 start_codex）：thread/start → thread/name/set。
// 返回 {threadId} 或抛错。
export async function startThread(folder, title) {
  const session = await appServerSession([
    { method: "thread/start", params: { cwd: folder, ephemeral: false } },
  ]);
  if (session.error) throw new Error(session.error);
  const started = session.answers.at(-1);
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string" || !/^[0-9a-f-]{36}$/i.test(threadId)) {
    throw new Error("Codex did not confirm the new thread");
  }
  const named = await appServerSession([
    { method: "thread/name/set", params: { threadId, name: title } },
  ]);
  if (named.error) throw new Error(named.error);
  return { threadId };
}

// 打开一个 URL 唤醒桌面端（照 runner.open；Windows 用 start，macOS open，
// Linux xdg-open）。失败不致命：消息已在队列里。
export function openUrl(url) {
  const command = process.platform === "win32"
    ? ["cmd", ["/d", "/s", "/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(command[0], command[1], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

// 唤醒持有某线程的 Codex 桌面端（照 start_codex 的收尾）。
export function wakeThread(threadId) {
  return openUrl("codex://threads/wake/" + threadId);
}
