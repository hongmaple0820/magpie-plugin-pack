// 消息核心：send_message / get_message / list_sessions 的语义与投递管线。
//
// 语义照 Agent HUD messaging crate（send.rs / get.rs / listing.rs），
// 投递对 Claude 走 lib/delivery/claude.mjs（M3），Codex 在 M5。
//
// 调用方识别是 magpie 上的适配：magpie 的 tool 钩子 ctx 只有
// {agent, abort, directory}（internal/plugin/tools.go），没有 Agent HUD
// relay 注入的 caller（client + sessionId + turnId）。所以这里在收过消息的
// Claude/Codex 会话里扫描转录尾部，若最后一条用户文本正好是某条已送达
// 消息（标签或指纹），调用方就是那个会话，回复链继续（照 next_pass 的
// 精神）；认不出就当作新链第一棒。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homeDir, loaded as claudeLoaded } from "./delivery/claude.mjs";
import * as channel from "./delivery/claude.mjs";
import { queueAdd, wakeThread } from "./delivery/codex.mjs";
import { startSession } from "./start.mjs";
import { Journal, newMessage } from "./journal.mjs";
import { compose, texts } from "./words.mjs";
import { assistantText, isWords, lastUserRow, readTail, userText } from "./transcripts.mjs";

const DEFAULT_LIMIT = 10;

function clientRoot(client) {
  return client === "claude"
    ? join(homeDir(), ".claude", "projects")
    : join(homeDir(), ".codex", "sessions");
}

// 某会话的转录文件；找不到为 null。
export function findTranscript(client, sessionId) {
  if (client === "claude") {
    const root = clientRoot(client);
    if (!existsSync(root)) return null;
    let dirs;
    try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return null; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = join(root, dir.name, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
    return null;
  }
  if (client === "codex") {
    const root = clientRoot(client);
    if (!existsSync(root)) return null;
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
      }
    };
    walk(root);
    for (const file of files) {
      const rows = readTail(file, 8_192);
      const meta = rows.find((r) => r?.type === "session_meta");
      if (meta?.payload?.id === sessionId) return file;
    }
    return null;
  }
  return null;
}

// 某会话转录里最后一条用户文本；转录读不到为 null。
export function lastPrompt(client, sessionId) {
  const file = findTranscript(client, sessionId);
  if (!file) return null;
  return lastUserRow(readTail(file), client);
}

// 收到过消息的候选会话（客户端 + sessionId），供调用方扫描用。
function receivedCandidates(journal) {
  const seen = new Set();
  const out = [];
  for (const m of journal.messages) {
    const key = m.to.client + "\u0000" + m.to.sessionId;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ client: m.to.client, sessionId: m.to.sessionId });
    }
  }
  return out;
}

// 最近有活动的会话（转录 mtime 最新且 5 分钟内）：工具调用瞬间，调用方
// 自己的转录正在写，作为识别不出精准匹配时的回退。返回
// {client, sessionId, title} | null。
function recentSession() {
  let best = null;
  let bestMtime = 0;
  const now = Date.now();
  const scan = (client, dirs) => {
    for (const dir of dirs) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scan(client, [join(dir, entry.name)]);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const file = join(dir, entry.name);
          let mtime = 0;
          try { mtime = statSync(file).mtimeMs; } catch { continue; }
          if (mtime > bestMtime) {
            bestMtime = mtime;
            best = {
              client,
              sessionId: entry.name.slice(0, -6),
              title: entry.name.slice(0, -6),
            };
          }
        }
      }
    }
  };
  scan("claude", [clientRoot("claude")]);
  scan("codex", [clientRoot("codex")]);
  if (best && now - bestMtime < 5 * 60_000) return best;
  return null;
}

// 尽力判断调用方会话：先扫收到过消息的会话，最后一条用户文本正好是
// 某条已送达消息（标签或指纹）→ 就是它；认不出就用最近活动会话回退。
// 返回 {client, sessionId, title} | null。
export function identifyCaller(journal) {
  let best = null;
  let bestSentAt = 0;
  for (const candidate of receivedCandidates(journal)) {
    const last = lastPrompt(candidate.client, candidate.sessionId);
    if (!last) continue;
    for (const message of journal.messages) {
      if (
        message.to.client === candidate.client &&
        message.to.sessionId === candidate.sessionId &&
        message.state !== "refused" &&
        isWords(last.text, message) &&
        message.sentAtMs > bestSentAt
      ) {
        bestSentAt = message.sentAtMs;
        best = {
          client: candidate.client,
          sessionId: candidate.sessionId,
          title: message.to.title ?? "",
          message,
        };
      }
    }
  }
  return best ?? recentSession();
}

// 送达状态从投递收据（channel state）映射到 journal 状态（照 delivered）。
function delivered(state) {
  switch (state) {
    case "waiting":
    case "cancelRequested":
      return "queued";
    case "taken":
      return "taken";
    case "started":
      return "started";
    case "refused":
    case "cancelled":
      return "refused";
    case "expired":
      return "expired";
    default:
      return "queued";
  }
}

function messageId() {
  return "m-" + createHash("sha256").update(String(Date.now()) + String(Math.random())).digest("hex").slice(0, 12);
}

// 送达的文字 trim 后的指纹（照 transcript::fingerprint）。
function fingerprintOf(text) {
  return createHash("sha256").update(text.trim()).digest("hex");
}

// 某消息的答复：在收件方转录尾部找"送达那句话"之后最后一条助手文本。
// 返回 {done, answer} | {done:false, started} | null。
function findAnswer(message) {
  const file = findTranscript(message.to.client, message.to.sessionId);
  if (!file) return null;
  const rows = readTail(file);
  let ours = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = userText(rows[i], message.to.client);
    if (text && isWords(text, message)) {
      ours = i;
      break;
    }
  }
  if (ours < 0) return null;
  const after = rows.slice(ours + 1);
  for (let i = after.length - 1; i >= 0; i--) {
    const text = assistantText(after[i], message.to.client);
    if (text) return { done: true, answer: text };
  }
  return { done: false, started: after.length > 0 };
}

export function createMessaging() {
  const journal = new Journal();

  return {
    journal,
    // list_sessions 数据源已把 Claude/Codex 行带来；这里只标 reachable/reason。
    listSessions: (rows) => {
      const loaded = claudeLoaded();
      for (const session of rows) {
        if (session.client === "claude") {
          if (loaded.has(session.id)) {
            session.reachable = true;
            session.reason = "Claude 插件已签到，可以收消息。";
          } else {
            session.reachable = false;
            session.reason = texts.notLoaded();
          }
        } else if (session.client === "codex") {
          // Codex 经自家队列收消息（M5），无需装任何插件
          session.reachable = true;
          session.reason = "Codex 经自身队列收消息，无需插件。";
        }
      }
      return rows;
    },
    // human 旗标：面板（人）发的消息。跳过 identifyCaller——那是给 agent
    // 调用方认领链用的，人发消息不该被误记到某个 agent 头上。
    send: async ({ to, text, replyTo, human }, { allSessions, limit = DEFAULT_LIMIT } = {}) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return { state: "refused", reason: texts.empty() };

      let replied = null;
      if (replyTo) {
        replied = journal.find(replyTo);
        if (!replied) return { state: "refused", reason: texts.unknownReply(replyTo) };
      }
      const toId = (to ?? "").trim() || replied?.from.sessionId;
      if (!toId) return { state: "refused", reason: texts.unknown() };

      const recipient = (allSessions ?? []).find((s) => s.id === toId) ?? null;
      if (!recipient) return { state: "refused", reason: texts.unknown() };

      const caller = human ? null : identifyCaller(journal);
      const sender = human
        ? { client: "human", sessionId: "", title: "鹊楼面板" }
        : caller
          ? { client: caller.client, sessionId: caller.sessionId, title: caller.title }
          : { client: "magpie", sessionId: "", title: "" };
      if (caller && caller.sessionId === toId) {
        return { state: "refused", reason: texts.toSelf() };
      }

      if (recipient.client === "claude") {
        if (!claudeLoaded().has(toId)) {
          return { state: "refused", reason: texts.notLoaded() };
        }
        if (trimmed.startsWith("/")) {
          return { state: "refused", reason: texts.slash() };
        }
        const chain = replied ? replied.chain : null;
        const count = replied ? replied.count + 1 : 1;
        if (count > limit) {
          return { state: "refused", reason: texts.limit(limit) };
        }
        const form = process.env.MAGPIE_AGENTS_AS_USER === "1" ? "own" : "labelled";
        const id = messageId();
        const delivered = compose({ form, from: sender, toClient: "claude", id, replyTo: replyTo ?? undefined, text: trimmed });
        try {
          channel.leave(toId, id, delivered, form === "own", Date.now());
        } catch (error) {
          return { state: "refused", reason: error?.message ?? String(error) };
        }
        const message = newMessage({
          id,
          kind: "send",
          chain: chain ?? id,
          count,
          from: sender,
          to: { client: "claude", sessionId: toId, title: recipient.title ?? "" },
          form,
          replyTo: replyTo ?? null,
          requestId: id,
          sentAtMs: Date.now(),
          fingerprint: fingerprintOf(delivered),
          state: "queued",
          reason: null,
        });
        if (replied) {
          const parent = journal.find(replied.id);
          if (parent) {
            parent.answered = true;
            parent.repliedBy = id;
            journal.replace(parent);
          }
        }
        journal.add(message);
        return { id, state: "queued", reason: null, pass: count };
      }
      if (recipient.client === "codex") {
        if (trimmed.startsWith("/")) {
          return { state: "refused", reason: texts.slash() };
        }
        const chain = replied ? replied.chain : null;
        const count = replied ? replied.count + 1 : 1;
        if (count > limit) {
          return { state: "refused", reason: texts.limit(limit) };
        }
        const form = process.env.MAGPIE_AGENTS_AS_USER === "1" ? "own" : "labelled";
        const id = messageId();
        const delivered = compose({ form, from: sender, toClient: "codex", id, replyTo: replyTo ?? undefined, text: trimmed });
        try {
          // thread_id 即会话 id（照 snapshot.rs：Codex 的 thread_id 就是 id）
          await queueAdd(toId, delivered, "magpie-agents:" + id);
          wakeThread(toId);
        } catch (error) {
          return { state: "refused", reason: error?.message ?? String(error) };
        }
        const message = newMessage({
          id,
          kind: "send",
          chain: chain ?? id,
          count,
          from: sender,
          to: { client: "codex", sessionId: toId, title: recipient.title ?? "" },
          form,
          replyTo: replyTo ?? null,
          requestId: id,
          sentAtMs: Date.now(),
          fingerprint: fingerprintOf(delivered),
          state: "queued",
          reason: null,
        });
        if (replied) {
          const parent = journal.find(replied.id);
          if (parent) {
            parent.answered = true;
            parent.repliedBy = id;
            journal.replace(parent);
          }
        }
        journal.add(message);
        return { id, state: "queued", reason: "已入 Codex 队列，等它打开该线程。", pass: count };
      }
      return { state: "refused", reason: texts.otherClient() };
    },
    start: async ({ client, folder, text }, { allSessions, limit = DEFAULT_LIMIT } = {}) => {
      const caller = identifyCaller(journal);
      const replied = null;
      const chain = null;
      // 计一棒（照 start 的 next_pass）：调用方在链上时接续计数
      let count = 1;
      if (caller) {
        const mine = journal.messages.filter(
          (m) => m.from.client === caller.client && m.from.sessionId === caller.sessionId && m.state !== "refused",
        );
        const latest = mine[mine.length - 1];
        if (latest) count = latest.count + 1;
      }
      const sender = caller
        ? { client: caller.client, sessionId: caller.sessionId, title: caller.title }
        : { client: "magpie", sessionId: "", title: "" };
      const result = await startSession({ client, folder, text }, { caller, limit, count });
      if (result.refused) return { state: "refused", reason: result.refused };
      const id = messageId();
      const message = newMessage({
        id,
        kind: "start",
        chain: chain ?? id,
        count,
        from: sender,
        to: { client, sessionId: result.session ?? "", title: (text ?? "").trim().split("\n")[0].slice(0, 40) },
        form: process.env.MAGPIE_AGENTS_AS_USER === "1" ? "own" : "labelled",
        replyTo: null,
        requestId: result.requestId,
        sentAtMs: Date.now(),
        fingerprint: fingerprintOf(String(text ?? "").trim()),
        state: result.state,
        reason: result.reason,
      });
      journal.add(message);
      return { id, state: result.state, reason: result.reason, session: result.session ?? null, pass: count };
    },
    get: (id) => {
      const message = journal.find(id);
      if (!message) return { id, state: "unknown", reason: texts.unknownMessage() };
      let state = message.state;
      let reason = message.reason;
      if (message.to.client === "claude") {
        const receipt = channel.state(message.to.sessionId, message.requestId);
        if (receipt) {
          state = delivered(receipt.state);
          reason = receipt.reason ?? null;
        }
      }
      let answer = null;
      if (message.to.sessionId && !["refused", "expired"].includes(state)) {
        const found = findAnswer(message);
        if (found?.done) {
          state = "done";
          answer = found.answer;
          reason = null;
        } else if (found?.started) {
          state = "started";
        }
      }
      if (message.repliedBy && (state !== "done" || answer == null)) {
        state = "replied";
        reason = texts.replied(message.repliedBy);
      }
      return {
        id: message.id,
        state,
        reason,
        to: { client: message.to.client, sessionId: message.to.sessionId, title: message.to.title },
        kind: message.kind,
        reply: message.repliedBy,
        answer,
        sentAt: new Date(message.sentAtMs).toISOString(),
      };
    },
  };
}
