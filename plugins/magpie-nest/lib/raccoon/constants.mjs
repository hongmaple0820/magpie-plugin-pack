// SenseTime Raccoon Work (xiaohuanxiong.com) protocol facts.
//
// Plain OpenAI chat completions with standard SSE: the plugin is a credential
// swap plus the client headers the gateway expects.

export const ID = "raccoon";
export const NAME = "Raccoon Work";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://xiaohuanxiong.com";
export const CHAT_PATH = "/api/web/llm/v2/chat/completions";

const ROWS = [
  ["sn-sensenova-6-8-flash", "SenseNova 6.8 Flash (Free)"],
  ["sn-sensenova-6-8-flash-lite", "SenseNova 6.8 Flash Lite (Free)"],
  ["sn-glm-5-3", "GLM-5.3"],
  ["sn-kimi-k3", "Kimi K3"],
  ["sn-glm-5-3-flash", "GLM-5.3 Flash"],
  ["sn-deepseek-v4-1-flash", "DeepSeek V4.1 Flash"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name, tool_call: true };
  return out;
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}

/**
 * The client headers. X-Org-Code is dropped when the account names no
 * organisation -- the gateway treats an empty one as a different identity.
 */
export function clientHeaders(token, officeCode) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Raccoon-Language": "zh",
    "X-Client-Platform": "desktop-windows",
    "User-Agent": "Raccoon Work/1.0.35 (Windows)",
    Authorization: "Bearer " + token,
  };
  const code = typeof officeCode === "string" ? officeCode.trim() : "";
  if (code) headers["X-Org-Code"] = code;
  return headers;
}
