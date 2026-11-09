// Doubao (www.doubao.com) web protocol facts.

import { randomUUID } from "node:crypto";

export const ID = "doubao";
export const NAME = "豆包";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://www.doubao.com";
export const CHAT_PATH = "/samantha/chat/completion";

export const ASSISTANT_ID = "497858";
export const VERSION_CODE = "20800";
export const PC_VERSION = "2.44.0";

/** Generated once per process and reused: the web client is one device. */
export const DEVICE_ID = "7" + randomDigits(18);
export const WEB_ID = "7" + randomDigits(18);

export function randomDigits(length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

export function randomStr(length) {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export function uuid() {
  return randomUUID();
}

/**
 * The query parameters the web client sends. They are fixed identity, not
 * per-request state, apart from the tab id.
 */
export function queryParams() {
  return {
    aid: ASSISTANT_ID,
    device_id: DEVICE_ID,
    device_platform: "web",
    language: "zh",
    pc_version: PC_VERSION,
    pkg_type: "release_version",
    real_aid: ASSISTANT_ID,
    region: "CN",
    samantha_web: "1",
    sys_region: "CN",
    tea_uuid: WEB_ID,
    "use-olympus-account": "1",
    version_code: VERSION_CODE,
    web_id: WEB_ID,
    web_tab_id: uuid(),
  };
}

/**
 * Note what is NOT here: Accept-Encoding. The web client advertises zstd, but a
 * runtime that cannot decode zstd would then be handed bytes it cannot read, so
 * the header is left to the HTTP layer, which asks only for what it can decode.
 */
export function clientHeaders(sessionId) {
  return {
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Last-Event-Id": "undefined",
    Origin: API_BASE,
    Pragma: "no-cache",
    Priority: "u=1, i",
    Referer: API_BASE,
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    Cookie: "sessionid=" + sessionId + "; sessionid_ss=" + sessionId,
    "X-Flow-Trace": "04-" + uuid() + "-" + uuid().slice(0, 16) + "-01",
  };
}

/** One model: the web app picks the assistant, not a model id. */
export function modelRows() {
  return { doubao: { name: "豆包", tool_call: true } };
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}

/**
 * The web app takes the whole conversation as one text, in the chat-template
 * markers its own client writes.
 */
export function conversationText(messages) {
  const textOf = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : "";
  const list = Array.isArray(messages) ? messages : [];
  const kept = list.filter((message) => textOf(message?.content).trim());
  if (kept.length < 2) return textOf(kept[0]?.content).trim();
  let out = "";
  for (const message of kept) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user";
    out += role + "\n" + textOf(message.content).trim() + "\n<|im_end|>\n";
  }
  return out;
}

export function requestBody(content) {
  return {
    messages: [
      {
        content: JSON.stringify({ text: content }),
        content_type: 2001,
        attachments: [],
        references: [],
      },
    ],
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      message_from: 0,
      action_bar_skill_id: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      event_id: "0",
    },
    evaluate_option: { web_ab_params: "" },
    section_id: "26" + randomDigits(16),
    conversation_id: "0",
    local_conversation_id: "local_16" + randomDigits(14),
    local_message_id: uuid(),
  };
}
