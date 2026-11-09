// LobsterAI (lobsterai-server.youdao.com) protocol constants.
//
// Everything here is a protocol fact: an endpoint, a header name, a version
// string the official client sends. The two X-LobsterAI-Client-* headers are
// load-bearing, not metadata -- see CAPABILITIES below.

export const ID = "lobsterai";
export const NAME = "LobsterAI";
export const NPM = "@ai-sdk/openai-compatible";

/** Chat and account endpoints. */
export const API_BASE = "https://lobsterai-server.youdao.com";
export const PORTAL_BASE = "https://lobsterai.youdao.com";

/** The base magpie's SDK talks to; our fetch ignores the path beyond /chat/completions. */
export const CHAT_BASE = API_BASE + "/api/proxy/v1";
export const CHAT_PATH = "/chat/completions";
export const EXCHANGE_PATH = "/api/auth/exchange";
export const REFRESH_PATH = "/api/auth/refresh";

/** Daily check-in endpoints. */
export const ACTIVITY_BASE = "/api/client-activities";
export const CLIENT_VERSION_API =
  "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update";

/** Client identity, copied verbatim from the official desktop client. */
export const CLIENT_VERSION = "2026.9.4";
export const USER_AGENT = "LobsterAI/0.1.0";

/**
 * Capability gate. Without kimi-k3-agentic-v1 the gateway silently serves a
 * model list that has no kimi-k3; without thinking-level-control-v1 a request
 * with reasoning_effort "off" is answered 500.
 */
export const CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1";

/**
 * The redirect the portal sends the browser back to. Nothing listens on this
 * port: the browser shows the URL with the code in its address bar and the
 * reader pastes it back, which is how every paste-back sign-in in magpie
 * works. The port only has to make the URL well formed.
 */
export const CALLBACK_PORT = 58123;
export const CALLBACK_PATH = "/auth/callback";

/** Refresh this long before the token expires. */
export const EXPIRY_LEAD_MS = 5 * 60 * 1000;
export const TIMEOUT_MS = 30_000;

/** How long a started sign-in stays reusable. */
export const LOGIN_TTL_MS = 15 * 60 * 1000;

/**
 * Wire model ids as display names. The key is what the upstream API takes; the
 * name is what the model picker shows. Several upstream ids carry a vendor
 * date stamp, which is why display and wire differ.
 */
const MODEL_ROWS = [
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["kimi-k2.7-code", "Kimi K2.7 Code"],
  ["kimi-k2.7-code-highspeed", "Kimi K2.7 Code Highspeed"],
  ["kimi-k2.6", "Kimi K2.6"],
  ["kimi-k2.5", "Kimi K2.5"],
  ["qwen3.7-max", "Qwen3.7 Max"],
  ["qwen3.7-plus", "Qwen3.7 Plus"],
  ["qwen3.6-plus", "Qwen3.6 Plus"],
  ["MiniMax-M3", "MiniMax M3"],
  ["MiniMax-M2.7", "MiniMax M2.7"],
  ["doubao-seed-2-1-pro-260628", "Doubao Seed 2.1 Pro"],
  ["doubao-seed-2-1-turbo-260628", "Doubao Seed 2.1 Turbo"],
  ["doubao-seed-2-0-code-preview-260215", "Doubao Seed 2.0 Code"],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5.1", "GLM-5.1"],
  ["glm-5v-turbo", "GLM-5V Turbo"],
  ["glm-5", "GLM-5"],
];

export function modelRows() {
  const out = {};
  for (const [wire, name] of MODEL_ROWS) out[wire] = { name, attachment: false, reasoning: true, tool_call: true };
  return out;
}
