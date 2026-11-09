// Agnes AI (api.agnes-ai.cn) protocol facts.
//
// The host serves an OpenAI-compatible API under /v1. Without that prefix the
// request hits the bare host, which Cloudflare answers with a 403 HTML page.

export const ID = "agnes";
export const NAME = "Agnes AI";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://api.agnes-ai.cn/v1";
export const CHAT_PATH = "/chat/completions";

/**
 * The text models only. Agnes also serves agnes-image-* and agnes-video-*,
 * whose endpoints are not chat completions -- those are a different surface
 * (magpie's image/video drawers) and are deliberately not listed here, so the
 * model picker cannot offer something that would fail at the turn.
 */
const ROWS = [
  ["agnes-2.5-flash", "Agnes 2.5 Flash"],
  ["agnes-2.5-pro", "Agnes 2.5 Pro"],
  ["agnes-2.5-pro-alpha", "Agnes 2.5 Pro Alpha"],
  ["agnes-2.5-pro-beta", "Agnes 2.5 Pro Beta"],
  ["agnes-3.0-flash", "Agnes 3.0 Flash"],
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
