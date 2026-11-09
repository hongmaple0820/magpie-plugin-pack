// Qwen (chat2.qianwen.com, the China build) protocol facts.
//
// A preset named qwen already exists in magpie (the API-key vendor); this is
// the web session behind qianwen.com, which is a different credential and a
// different model set.

import { randomUUID } from "node:crypto";

export const ID = "qwen-web";
export const NAME = "Qwen 网页版";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://chat2.qianwen.com";
export const CHAT_PATH = "/api/v2/chat";

export const CLIENT_HEADERS = {
  Accept: "application/json, text/event-stream, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Cache-Control": "no-cache",
  Origin: "https://www.qianwen.com",
  Pragma: "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  Referer: "https://www.qianwen.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};

/** Display name to wire id. The agent ids are the ones the web app chats with. */
const ROWS = [
  ["Qwen3.8-Max", "Qwen3.8-Max"],
  ["Qwen3.7-Plus", "Qwen3.7-Plus"],
  ["qwen3.8-flash", "Qwen3.8-Flash"],
  ["Qwen3.5-Plus", "Qwen3.5-Plus"],
  ["tongyi-qwen3-max-model-agent", "Qwen3-Max"],
  ["tongyi-qwen3-max-thinking-agent", "Qwen3-Max-Thinking"],
  ["tongyi-qwen-plus-agent", "Qwen3-Plus"],
  ["qwen3-flash", "Qwen3-Flash"],
  ["qwen3-coder-plus", "Qwen3-Coder"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name, tool_call: true, reasoning: true };
  return out;
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}

export function uuid() {
  return randomUUID();
}

/** Twelve lowercase alphanumerics, as the web client sends. */
export function generateNonce() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/** The query string the web client puts in front of every chat call. */
export function queryString(nowMs = Date.now()) {
  return new URLSearchParams({
    biz_id: "ai_qwen",
    chat_client: "h5",
    device: "pc",
    fr: "pc",
    pr: "qwen",
    ut: uuid(),
    nonce: generateNonce(),
    timestamp: String(nowMs),
  }).toString();
}

/** The web app takes one message per turn; the transcript is written into it. */
export function flatten(messages) {
  const textOf = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : "";
  let system = "";
  let user = "";
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (message?.role === "system") system = text;
    else if (message?.role === "user") user = text;
  }
  return system ? system + "\n\nUser: " + user : user;
}

export function requestBody({ model, content, thinking, search, reqId, sessionId, nowMs = Date.now() }) {
  return {
    deep_search: thinking || search ? "1" : "0",
    req_id: reqId,
    model,
    scene: "chat",
    session_id: sessionId,
    sub_scene: "chat",
    temporary: false,
    messages: [
      {
        content,
        mime_type: "text/plain",
        meta_data: { ori_query: content },
      },
    ],
    from: "default",
    parent_req_id: "0",
    enable_search: search,
    biz_data: '{"entryPoint":"tongyigw"}',
    scene_param: "first_turn",
    chat_client: "h5",
    client_tm: String(nowMs),
    protocol_version: "v2",
    biz_id: "ai_qwen",
  };
}

/** Thinking arrives as a separate load inside a message's meta_data. */
export function thinkingOf(message) {
  const loads = Array.isArray(message?.meta_data?.multi_load) ? message.meta_data.multi_load : [];
  let best = "";
  for (const load of loads) {
    if (load?.type !== "deep_think" && load?.type !== "multimodal_chat_think") continue;
    const text = load?.content?.think_content ?? load?.content?.content ?? "";
    if (typeof text === "string" && text.length > best.length) best = text;
  }
  return best;
}
