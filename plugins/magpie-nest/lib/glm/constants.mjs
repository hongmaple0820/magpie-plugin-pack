// 智谱清言 web (chatglm.cn) protocol facts.

// A preset named zhipu already exists in magpie (the API-key vendor); this is
// the web session behind chatglm.cn, a different credential and model set.
export const ID = "glm";
export const NAME = "GLM (清言网页版)";
export const NPM = "@ai-sdk/openai-compatible";

export const API_BASE = "https://chatglm.cn/chatglm";
export const STREAM_PATH = "/backend-api/assistant/stream";
export const REFRESH_PATH = "/user-api/user/refresh";

/** The assistant the web client chats with. */
export const ASSISTANT_ID = "65940acff94777010aa6b796";

/** The web client's own headers; the edge fingerprints them. */
export const CLIENT_HEADERS = {
  Accept: "text/event-stream",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "App-Name": "chatglm",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  Origin: "https://chatglm.cn",
  Pragma: "no-cache",
  "Sec-Ch-Ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "X-App-Fr": "browser_extension",
  "X-App-Platform": "pc",
  "X-App-Version": "0.0.1",
  "X-Device-Brand": "",
  "X-Device-Model": "",
  "X-Lang": "zh",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
};

const ROWS = [
  ["glm-5.3", "GLM-5.3"],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5", "GLM-5"],
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
