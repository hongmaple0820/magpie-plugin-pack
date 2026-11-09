// Z.ai protocol facts.

// A preset named zai already exists in magpie (the API-key vendor). This one is
// the web session, which is a different credential and a different model set,
// so it carries its own id rather than fighting for the name.
export const ID = "zai-web";
export const NAME = "Z.ai";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://chat.z.ai/api";
export const CHAT_PATH = "/v1/chat/completions";

const ROWS = [
  ["glm-5.3", "GLM-5.3"],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5.1", "GLM-5.1"],
  ["glm-5", "GLM-5"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name, tool_call: true, reasoning: true };
  return out;
}

/** magpie may name a model "zai/glm-5.3"; upstream wants the bare id. */
export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}
