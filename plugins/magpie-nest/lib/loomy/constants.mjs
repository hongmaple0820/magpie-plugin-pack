// Loomy (iFlytek) protocol facts.
//
// Plain OpenAI chat completions with standard SSE: the whole plugin is a
// credential swap and a model table.

export const ID = "loomy";
export const NAME = "Loomy";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://loomyad.xunfei.cn/api/v1";
export const CHAT_PATH = "/chat/completions";

/**
 * The model name carries its billing multiplier. That is upstream data, not
 * decoration: the same request can cost 30x more on one model than another,
 * and the multiplier is how a user budgets.
 */
const ROWS = [
  ["deepseek-v4-flash-0731", "DeepSeek V4 Flash · x3.0"],
  ["MiniMax-M3", "MiniMax M3 · x4.0"],
  ["Kimi-k2.6", "Kimi k2.6 · x6.5"],
  ["qwen-3.8-max", "Qwen 3.8 Max · x12.0"],
  ["GLM-5.3-Flash", "GLM 5.3 Flash · x0.8"],
  ["qwen3.8-flash", "Qwen 3.8 Flash · x0.8"],
  ["spark-x", "Spark X2.5 · x0.1"],
  ["mimo-v2.5", "MiMo V2.5 · x3.3"],
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
