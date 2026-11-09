// Qwen AI (chat.qwen.ai, the international build) protocol facts.

export const ID = "qwen-ai";
export const NAME = "Qwen AI 网页版";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://chat.qwen.ai";
export const CHAT_PATH = "/api/v2/chat/completions";
export const NEW_CHAT_PATH = "/api/v2/chats/new";

import { BX_V, BX_UMIDTOKEN, BX_UA } from "./client-constants.mjs";

/**
 * The web client's headers. The bx-* trio is the vendor's anti-automation
 * fingerprint: it is a client constant, not something derivable, so it is
 * carried whole.
 */
export function clientHeaders() {
  return {
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    source: "web",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "bx-v": BX_V,
    "bx-umidtoken": BX_UMIDTOKEN,
    "bx-ua": BX_UA,
    Timezone: new Date().toString(),
    Version: "0.2.7",
    Origin: API_BASE,
  };
}

const ROWS = [
  ["qwen3.8-max", "Qwen3.8-Max"],
  ["qwen3.7-max", "Qwen3.7-Max"],
  ["qwen3.7-plus", "Qwen3.7-Plus"],
  ["qwen3.6-plus", "Qwen3.6-Plus"],
  ["qwen3.5-plus", "Qwen3.5-Plus"],
  ["qwen3.5-flash", "Qwen3.5-Flash"],
  ["qwen3-max-2026-01-23", "Qwen3-Max"],
  ["qwen3-coder-plus", "Qwen3-Coder"],
  ["qwen3-vl-plus", "Qwen3-VL"],
  ["qwen-max-latest", "Qwen Max Latest"],
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
