// Kimi (www.kimi.com) web protocol facts.
//
// The chat call is gRPC-Web over HTTP: the body is a framed JSON message, not
// a plain JSON body, and the reply is a stream of the same frames.

export const ID = "kimi-web";
export const NAME = "Kimi 网页版";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://www.kimi.com";
export const CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";

/** The scenario tag every web request carries. */
export const SCENARIO = "SCENARIO_K2D5";

export const CLIENT_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Origin: API_BASE,
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Priority: "u=1, i",
};

const ROWS = [
  ["kimi-k3", "Kimi K3"],
  ["kimi-k2.7-code", "Kimi K2.7 Code"],
  ["kimi-k2.6", "Kimi K2.6"],
  ["kimi-k2.5", "Kimi K2.5"],
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

/** The transcript as one text block: the web app takes a single user message. */
export function flatten(messages) {
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

export function requestBody(content, { thinking, search }) {
  return {
    scenario: SCENARIO,
    chat_id: "",
    tools: search ? [{ type: "TOOL_TYPE_SEARCH", search: {} }] : [],
    message: {
      parent_id: "",
      role: "user",
      blocks: [{ message_id: "", text: { content } }],
      scenario: SCENARIO,
    },
    options: { thinking },
  };
}
