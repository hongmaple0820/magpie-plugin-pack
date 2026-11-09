// DeepSeek web (chat.deepseek.com) protocol facts.
//
// Every write is PoW-gated: a challenge is fetched, solved with DeepSeek's own
// sha3 wasm, and the answer travels in x-ds-pow-response. A conversation needs
// a session created first and deleted after; the transcript is sent as one
// plain prompt, so the session carries no history of its own.

export const ID = "deepseek-web";
export const NAME = "DeepSeek 网页版";
export const NPM = "@ai-sdk/openai-compatible";
export const BASE = "https://chat.deepseek.com";

export const COMPLETION_PATH = "/api/v0/chat/completion";
export const SESSION_CREATE_PATH = "/api/v0/chat_session/create";
export const SESSION_DELETE_PATH = "/api/v0/chat_session/delete";
export const POW_CHALLENGE_PATH = "/api/v0/chat/create_pow_challenge";

/** Fallback identity when the account names none. */
export const FALLBACK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const FALLBACK_CLIENT_VERSION = "20241129.1";

const ROWS = [
  ["deepseek-chat", "DeepSeek Chat"],
  ["deepseek-reasoner", "DeepSeek Reasoner"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name, reasoning: true, tool_call: true };
  return out;
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}

/** The thinking switch is the model, not a flag. */
export function isThinkingModel(model) {
  return String(model ?? "").toLowerCase().includes("reason");
}

/** The transcript as the one plain prompt the web app sends. */
export function promptOf(messages) {
  const textOf = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : "";
  const systems = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (message?.role === "system") systems.push(text);
    else turns.push((message?.role === "assistant" ? "Assistant: " : "User: ") + text);
  }
  const parts = [];
  if (systems.length) parts.push(systems.join("\n\n"));
  parts.push(...turns);
  return parts.join("\n\n");
}
