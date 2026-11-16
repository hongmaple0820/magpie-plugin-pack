// 收件人读到的包装与各拒绝文案（照 messaging/words.rs）。
// 语言：MAGPIE_AGENTS_LANG=zh|en，默认 zh（本插件中文优先；标签匹配
// "· <id>]" 与语言无关）。回复工具名按 magpie 的 MCP 命名
// <插件短名>_<工具>（internal/gateway/tools_mcp.go 的 namedTools）：
// 共享服务器上是 magpie-hud_send_message，插件专属服务器上是 send_message。
const ZH = (process.env.MAGPIE_AGENTS_LANG || "zh") !== "en";

function say(zh, chinese, english) {
  return zh ? chinese : english;
}

function clientName(client) {
  if (client === "claude") return "Claude Code";
  if (client === "codex") return "Codex";
  if (client === "deepseek") return "DeepSeek Harness";
  if (client === "antigravity") return "Antigravity";
  if (client === "human") return "人（鹊楼面板）";
  return client;
}

// 回复指引里点名的工具（照 reply_tool 的语义，落到 magpie 的命名）。
function replyTool() {
  return ZH ? "鹊楼的 send_message 工具（共享 MCP 服务器上名为 magpie-hud_send_message）" : "the send_message tool of magpie-hud (magpie-hud_send_message on the shared MCP server)";
}

// 送达的文字（照 compose）：首行署名标签、正文、末行回复指引。
// 回复的末行更短，免得两个 agent 互相道谢个没完。own 形式只发正文。
export function compose({ form, from, toClient, id, replyTo, text }) {
  if (form === "own") return text;
  const title = (from.title ?? "")
    .replace(/[\n\r]/g, " ")
    .replace(/\]/g, ")")
    .replace(/\[/g, "(")
    .slice(0, 60)
    .trim();
  const titlePart = title ? ` · ${title}` : "";
  const replyPart = replyTo ? ` · ${ZH ? "回复" : "re"} ${replyTo}` : "";
  const label = `[magpie-hud · ${ZH ? "来自" : "from"} ${clientName(from.client)}${titlePart} · ${id}${replyPart}]`;
  const footer = replyTo
    ? say(
        ZH,
        `这是对 ${replyTo} 的回复。还需要再说时，用${replyTool()}回复，reply_to: ${id}。`,
        `This answers ${replyTo}. Only if more is needed, reply with ${replyTool()}, reply_to: ${id}.`,
      )
    : say(
        ZH,
        `请用${replyTool()}回复，reply_to: ${id}，回复会作为一条消息送到发件方。没有这个工具时就直接作答，发件方能取回你这一轮最后的回答。`,
        `Reply with ${replyTool()}, reply_to: ${id}: your reply reaches the sender as a message. Without that tool, answer here: the sender can read this turn's last reply.`,
      );
  return `${label}\n\n${text}\n\n${footer}`;
}

export const texts = {
  empty: () => say(ZH, "没有要发的内容。", "There is no text to send."),
  toSelf: () => say(ZH, "不能给自己发消息。", "A session cannot message itself."),
  unknown: () => say(ZH, "没有这个会话。", "There is no such session."),
  unknownReply: (id) => say(ZH, `没有收到过 ${id} 这条消息，不能回复它。`, `No message ${id} was received, so it cannot be answered.`),
  otherClient: () => say(ZH, "这个客户端还不在支持范围内。", "This client is not supported yet."),
  notLoaded: () => say(ZH, "这个会话还没装配套的 Claude Code 插件（或签到已过期）。", "This session is not running the magpie-agents Claude Code plugin, or its check-in expired."),
  limit: (n) => say(ZH, `这条链已经来回 ${n} 次没有用户介入，先请用户看看再继续。`, `This chain has gone ${n} passes with no word from the user; ask the user to look before continuing.`),
  slash: () => say(ZH, "Claude Code 插件不能提交 slash 命令。", "Claude plugins cannot submit slash commands."),
  replied: (id) => say(ZH, `对方已用消息 ${id} 回复。`, `It was answered with message ${id}.`),
  unknownMessage: () => say(ZH, "没有这条消息。", "There is no such message."),
  codexM5: () => say(ZH, "Codex 投递在里程碑 M5 落地。", "Codex delivery lands in milestone M5."),
  start: {
    noClient: () => say(ZH, "start_session 需要 client（claude 或 codex）。", "start_session needs a client: claude or codex."),
    noText: () => say(ZH, "start_session 需要 text：新会话的首条用户消息。", "start_session needs text: the new session's first user message."),
    unsupportedClient: (client) => say(ZH, `鹊楼现在只起 claude 与 codex 会话，${client} 还没接。`, `Only claude and codex sessions can be started now, not ${client}.`),
    folderMissing: () => say(ZH, "folder 不是本机现存的目录。", "The folder is not an existing directory on this computer."),
    taskFolder: () => say(ZH, "任务目录建不起来。", "The task folder could not be created."),
  },
};
