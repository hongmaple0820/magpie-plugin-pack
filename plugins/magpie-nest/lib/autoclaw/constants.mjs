// AutoClaw (Zhipu OpenClaw) protocol facts, sourced from the verified
// community implementation @magpie-community/opencode-autoclaw-auth@0.2.21
// (index.mjs). The gateway is NOT a plain OpenAI endpoint: chat requests
// must carry the official AutoClaw client fingerprint headers, a mandatory
// system-prompt prefix and no max_tokens, or the gateway answers 406.

export const OVERSEAS_ID = "autoclaw";
export const CN_ID = "autoclaw-cn";
export const NPM = "@ai-sdk/openai-compatible";

// --- hosts and chat paths (reference index.mjs:57-62) ---
export const GLOBAL_HOST = "https://autoglm-api.autoglm.ai";
export const CN_HOST = "https://autoglm-api.zhipuai.cn";
export const MANAGED_HOST = "https://autoglm-acceleration-api.zhipuai.cn";
export const OVERSEAS_CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions";
export const CN_CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/chat/completions";

// --- official client fingerprint constants (reference index.mjs:27-63) ---
export const APP_ID = "100003";
export const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
export const PRODUCT = "autoclaw";
export const CHANNEL = "AutoClaw4";
export const CLIENT_VERSION = "1.18.1";
export const CN_CHANNEL = "AutoClaw26";
export const CN_CLIENT_VERSION = "2.1.0";
export const OFFICIAL_CHANNEL = "official";
export const OFFICIAL_CLIENT_VERSION = "2.0.3";
export const OFFICIAL_LANG = "en";
export const OPENAI_SDK_VERSION = "6.26.0";
export const OFFICIAL_NODE_VERSION = "v24.18.0";
export const OFFICIAL_SYSTEM_PROMPT = "You are AutoClaw. Answer the user directly and concisely.";

// The gateway requires this exact prefix on the system message
// (reference README.md "对话网关与请求整形").
const OVERSEAS_ROWS = {
  "zai_auto": { name: "GLM Auto (路由)", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
  "zai_auto-fast": { name: "GLM Auto Fast", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
  "zaicoding_glm-5.3": { name: "GLM-5.3 Coding", limit: { context: 1000000, output: 131072 }, reasoning: true, tool_call: true },
  "zai_glm-5.3-flash": { name: "GLM-5.3 Flash", limit: { context: 1000000, output: 32000 }, reasoning: true, tool_call: true },
};

const VARIANTS = Object.fromEntries(["low", "high", "max"].map((effort) => [effort, { reasoningEffort: effort }]));

const CN_ROWS = {
  "zai_auto": { name: "Auto", limit: { context: 1048576, output: 393216 }, reasoning: true, attachment: true, tool_call: true, variants: VARIANTS },
  "zai_auto-fast": { name: "Auto-Fast", limit: { context: 1048576, output: 131072 }, reasoning: true, attachment: true, tool_call: true, variants: VARIANTS },
  "zaicoding_glm-5.3": { name: "GLM-5.3", limit: { context: 1048576, output: 307200 }, reasoning: true, attachment: false, tool_call: true, variants: VARIANTS },
  "zai_glm-5.3-flash": { name: "GLM-5.3-Flash", limit: { context: 1048576, output: 131072 }, reasoning: true, attachment: true, tool_call: true, variants: VARIANTS },
};

// id / 名称 / API 域 / 模型行 / 鉴权形态. 鉴权形态两版一致:
// oauth access token, chat 请求头 X-Authorization: Bearer <access token>.
export const REGIONS = {
  [OVERSEAS_ID]: {
    id: OVERSEAS_ID,
    name: "AutoClaw (Zhipu)",
    api: GLOBAL_HOST,
    chatHost: GLOBAL_HOST,
    chatPath: OVERSEAS_CHAT_PATH,
    models: OVERSEAS_ROWS,
    auth: "oauth access token; X-Authorization: Bearer",
    login: "Google / z.ai 网页 OAuth（本地引导页 + 阿里滑块）",
  },
  [CN_ID]: {
    id: CN_ID,
    name: "AutoClaw 国内 (Zhipu)",
    api: CN_HOST,
    chatHost: MANAGED_HOST,
    chatPath: CN_CHAT_PATH,
    models: CN_ROWS,
    auth: "oauth access token; X-Authorization: Bearer",
    login: "手机验证码（+86）",
  },
};

export function modelRows(regionId = OVERSEAS_ID) {
  return REGIONS[regionId]?.models ?? OVERSEAS_ROWS;
}

/** magpie may name a model "autoclaw/zai_auto" or "autoclaw-cn/zai_auto";
 * upstream wants the bare routeModelId. */
export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (id.startsWith(CN_ID + "/")) return id.slice(CN_ID.length + 1);
  if (id.startsWith(OVERSEAS_ID + "/")) return id.slice(OVERSEAS_ID.length + 1);
  return id;
}
