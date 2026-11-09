// ChatGPT web (chatgpt.com) protocol facts.
//
// This is the web app's private /backend-api, not api.openai.com.

export const ID = "chatgpt-web";
export const NAME = "ChatGPT 网页版";
export const NPM = "@ai-sdk/openai-compatible";
export const BASE = "https://chatgpt.com";

/** The web client version; it changes with every release. */
export const DEFAULT_CLIENT_VERSION = "prod-a194cd50d4416d3c0b47c740f206b12ce60f5887";
export const DEFAULT_CLIENT_BUILD_NUMBER = "6708908";

export const FALLBACK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const ROWS = [
  ["auto", "ChatGPT Auto"],
  ["gpt-5", "ChatGPT-5"],
  ["gpt-5-5", "ChatGPT-5-5"],
  ["gpt-5-5-thinking", "ChatGPT-5-5 Thinking"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name, tool_call: false };
  return out;
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}
