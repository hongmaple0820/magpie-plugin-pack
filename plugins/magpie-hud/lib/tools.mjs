// 鹊楼的 5 个工具（magpie tool 钩子：{name: {description, args, execute}}）。
//
// args 用完整 JSON Schema（host.js 的 argsSchema 原样放行，工具自查）；
// execute 返回字符串（原样）或对象（JSON 序列化）。
// 语义照 Agent HUD 的 messaging/tools.rs；list_quotas 是 v2.1 追加的额度工具
// （M-U2 已实现 Claude + Codex，协议照 agents crate 的 account 读取器）。
import { listSessions } from "./sessions.mjs";
import { listQuotas } from "./usage/index.mjs";
import { createMessaging } from "./messaging.mjs";

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

export const AGENTS_TOOLS = {
  list_sessions: {
    description:
      "List the AI coding agent sessions on this computer that this plugin sees (Claude Code, Codex, DeepSeek Harness and Antigravity): id, client, title, project folder, state (idle or running, from how recently the transcript changed), reachable (Claude: whether its magpie-agents plugin checked in within 20 s; Codex: true, it takes messages through its own queue; others: false with the reason) and self. startFolders says where start_session can open a session for each client. Read-only.",
    args: NO_ARGS,
    execute: async () => JSON.stringify(await listSessions(), null, 2),
  },
  send_message: {
    description:
      "Send text to another agent session on this computer (an id from list_sessions). It never interrupts a turn in progress: a Claude Code recipient with the magpie-agents plugin installed takes it as a new turn once it is idle; a Codex recipient takes it through its own queue once it opens the thread. Returns at once with a message id and state queued, or refused with the reason; read the answer later with get_message. Pass reply_to with the id of a message you received to answer it: the reply goes back to its sender. After a number of passes back and forth with no word from the user (10 unless changed), further messages are refused until the user steps in.",
    args: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient session's id from list_sessions; with reply_to it may be left out to answer the sender." },
        text: { type: "string", description: "What to send, whole." },
        reply_to: { type: "string", description: "The id of a message you received that this answers." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const messaging = createMessaging();
      const rows = (await listSessions()).sessions;
      // MCP 参数是蛇形（reply_to），send 收驼峰（replyTo）。
      const out = await messaging.send(
        { to: args.to, text: args.text, replyTo: args.reply_to },
        { allSessions: rows },
      );
      return JSON.stringify(out, null, 2);
    },
  },
  start_session: {
    description:
      "Start a new Claude Code or Codex session with text as its first user prompt, and return the new session's id. The folder argument opens it in a project folder that exists on this computer; without one it starts in its own task folder. Counts as one pass, like send_message. Returns a message id with state started; get_message gives the new session's id and its first answer. Besides started it answers state refused with a reason (no text, unknown client, the client's folder does not exist, the per-user message limit is reached) or state uncertain with a reason (the client's command could not be run, or it ran without reporting a job id) — uncertain means the turn may or may not have started, check list_sessions before retrying.",
    args: {
      type: "object",
      properties: {
        client: { type: "string", description: "Which client to start: claude or codex." },
        folder: { type: "string", description: "Project folder to open the session in (optional)." },
        text: { type: "string", description: "The first prompt for the new session." },
        withoutFolder: { type: "boolean", description: "Start without a folder even when folder is given." },
      },
      required: ["client"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const messaging = createMessaging();
      const listing = await listSessions();
      const out = await messaging.start(args, { allSessions: listing.sessions, startFolders: listing.startFolders });
      return JSON.stringify(out, null, 2);
    },
  },
  get_message: {
    description:
      "Read where a message you sent stands and, once its recipient's turn ended, that turn's last answer. state: queued (waiting for the recipient to take it), taken, started (the recipient is working on it), done (answer below), replied (the recipient answered with send_message), refused, expired, unknown. Read-only.",
    args: {
      type: "object",
      properties: {
        id: { type: "string", description: "The message id send_message returned." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const messaging = createMessaging();
      return JSON.stringify(messaging.get(args.id), null, 2);
    },
  },
  list_quotas: {
    description:
      "Read the vendor-side usage quotas for this computer's AI coding agents (Claude Code and Codex now): the current plan's limits, what is used, and what is left. Read-only; lands in milestone M-U2.",
    args: NO_ARGS,
    execute: async () => JSON.stringify(await listQuotas(), null, 2),
  },
};
