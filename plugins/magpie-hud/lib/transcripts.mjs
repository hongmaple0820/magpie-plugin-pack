// 转录读取：尾部 JSONL 解析、用户文本行、助手回答行、指纹与消息匹配。
// 行格式照 Agent HUD agents crate 的 transcript.rs（Claude/Codex 两家最稳）：
//   Claude: {type:"user", message:{role:"user", content: string | [{type:"text",text}]}}
//           {type:"assistant", message:{role:"assistant", content:[{type:"text",text}]}}
//   Codex:  {type:"response_item", payload:{type:"message", role:"user"|"assistant",
//           content:[{type:"input_text"|"output_text",text}]}}
//   DeepSeek Harness: {type:"session", id, cwd} 起头；用户 prompt
//           {type:"user/message", data:{source:{kind:"user"}, content}}；回答
//           {type:"assistant/message", data:{message:{content:[{type:"text",text}]}}}
//   Antigravity: 用户输入 {type:"USER_INPUT", source!=SYSTEM, content}
//           （可能包 <USER_REQUEST>）；回答 {type:"PLANNER_RESPONSE", content}
import { openSync, readSync, statSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

// 尾部窗口：认出"本回合开头是我们发的哪条消息"与"回合后的助手回答"够用。
const TAIL_BYTES = 262_144;

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

// 文本 trim 后的 SHA-256（照 transcript::fingerprint）。
export function fingerprint(text) {
  return createHash("sha256").update(String(text).trim()).digest("hex");
}

// Claude Code 把插件提交的 prompt 包一层再记进转录；这层去掉后才是原文
// （照 unwrap_prompt，两种插件名都试，加 <user_query> 兜底）。
export function unwrapPrompt(text) {
  const leads = [
    "The agent-hud plugin sent a message:\n",
    "The magpie-agents plugin sent a message:\n",
  ];
  for (const lead of leads) {
    if (text.startsWith(lead)) {
      const rest = text.slice(lead.length);
      const note = rest.lastIndexOf("\n\nThis is how Claude Code surfaces a prompt a plugin submits");
      return note >= 0 ? rest.slice(0, note) : rest;
    }
  }
  const q = text.lastIndexOf("<user_query>");
  if (q >= 0) {
    const after = text.slice(q + "<user_query>".length);
    const end = after.indexOf("</user_query>");
    if (end >= 0) return after.slice(0, end);
  }
  return text;
}

// 一行转录里的用户文本（无文本的行——如 tool_result——返回 ""）。
export function userText(row, client) {
  if (client === "codex") {
    const p = row?.payload;
    if (row?.type !== "response_item" || p?.type !== "message" || p?.role !== "user") return "";
    for (const c of p?.content ?? []) {
      if (c?.type === "input_text" && typeof c.text === "string") return c.text;
    }
    return "";
  }
  if (client === "deepseek") {
    if (row?.type !== "user/message") return "";
    if (row?.data?.source?.kind !== "user") return "";
    const c = row?.data?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === "text" && typeof p.text === "string") return p.text;
      }
    }
    return "";
  }
  if (client === "antigravity") {
    if (row?.type !== "USER_INPUT") return "";
    if (row?.source === "SYSTEM") return "";
    const raw = row?.content;
    if (typeof raw !== "string") return "";
    const open = raw.indexOf("<USER_REQUEST>");
    if (open >= 0) {
      const after = raw.slice(open + "<USER_REQUEST>".length);
      const close = after.indexOf("</USER_REQUEST>");
      if (close >= 0) return after.slice(0, close).trim();
    }
    return raw.trim();
  }
  if (row?.type !== "user") return "";
  const c = row?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

// 一行转录里的助手文本（无文本返回 ""）。
export function assistantText(row, client) {
  if (client === "codex") {
    const p = row?.payload;
    if (row?.type !== "response_item" || p?.type !== "message" || p?.role !== "assistant") return "";
    for (const c of p?.content ?? []) {
      if (c?.type === "output_text" && typeof c.text === "string") return c.text;
    }
    return "";
  }
  if (client === "deepseek") {
    if (row?.type !== "assistant/message") return "";
    for (const c of row?.data?.message?.content ?? []) {
      if (c?.type === "text" && typeof c.text === "string") return c.text;
    }
    return "";
  }
  if (client === "antigravity") {
    if (row?.type !== "PLANNER_RESPONSE") return "";
    return typeof row?.content === "string" ? row.content.trim() : "";
  }
  if (row?.type !== "assistant") return "";
  const c = row?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

// 尾部窗口：读出文件最后 TAIL_BYTES 的 JSONL 行。
export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // 首行可能被截半，丢掉（除非整个文件都在窗口里）。
    if (start > 0 && lines.length > 0) lines.shift();
    const rows = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t);
        row.timestamp =
          row.timestamp ??
          (typeof row.time === "number" ? row.time : row.time) ??
          row.created_at ??
          row.createdAt;
        rows.push(row);
      } catch { /* 非 JSON 行跳过 */ }
    }
    return rows;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 关不掉就算了 */ }
    }
  }
}

// 尾部里最后一条用户文本行（一个回合的开头）：{text, timestamp, index} | null。
export function lastUserRow(rows, client) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = userText(rows[i], client);
    if (text) {
      return { text, timestamp: rows[i]?.timestamp ?? null, index: i };
    }
  }
  return null;
}

// 这段文字是不是消息 message 送达的那句话（照 is_words）：
// labelled 看标签里的 id；own 看指纹（原文或去掉插件包装后）。
export function isWords(text, message) {
  if (message.form === "own") {
    return fingerprint(text) === message.fingerprint || fingerprint(unwrapPrompt(text)) === message.fingerprint;
  }
  return text.includes(`· ${message.id}]`) || text.includes(`· ${message.id} ·`);
}
