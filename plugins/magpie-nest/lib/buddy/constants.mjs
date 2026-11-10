// 腾讯双产品/双版本渠道协议事实：WorkBuddy AI（国际版）、WorkBuddy（中国版）、
// CodeBuddy（中国版）。三者共用同一套授权 + 推理协议（auth/state → auth/token →
// login/account；POST /v2/chat/completions），产品差异全部收在 PRODUCTS 表里。
//
// 出处（file:line）：
//   ChatLink src/main/oauth/adapters/codebuddy.ts:71-91  buddyProduct 表
//   ChatLink src/main/providers/builtin/codebuddy.ts:23-45 CodeBuddy 头族
//   ChatLink src/main/providers/builtin/workbuddy.ts:34-79 国际版头族 + UA 分档
//   @magpie-community/opencode-workbuddy-auth/index.mjs:68-115 SITES 表
//   同上 index.mjs:349-407 sign/chatHeaders 头族；1753-1796 browserSignIn 授权流

export const NPM = "@ai-sdk/openai-compatible";

// [wire id, 显示名, reasoningEffort 档位（可选）]
const CN_MODELS = [
  ["auto", "Auto"],
  ["hy4-preview-f", "Hy4 preview", ["high"]],
  ["hy3", "Hy3", ["low", "high"]],
  ["hy3-x", "Hy3-X", ["low", "high"]],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", ["none", "low", "high", "max"]],
  ["glm-5.3", "GLM-5.3", ["low", "high", "max"]],
  ["glm-5.3-flash", "GLM-5.3-Flash", ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", ["high", "xhigh"]],
  ["glm-5.1", "GLM-5.1"],
  ["glm-5v-turbo", "GLM-5v-Turbo"],
  ["minimax-m3", "MiniMax-M3"],
  ["kimi-k3-1", "Kimi-K3", ["low", "high", "xhigh"]],
  ["kimi-k2.7", "Kimi-K2.7-Code"],
  ["kimi-k2.6", "Kimi-K2.6"],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", ["none", "high", "xhigh"]],
];

const AI_MODELS = [
  ["default-model", "Default"],
  ["fast-model", "Fast"],
  ["balanced-model", "Balanced"],
  ["primary-model", "Primary"],
  ["deep-model", "Deep"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.4", "GPT-5.4"],
  ["gpt-5.3-codex", "GPT-5.3-Codex"],
  ["gemini-3.1-pro", "Gemini-3.1-Pro"],
  ["gemini-3.5-flash", "Gemini-3.5-Flash"],
  ["glm-5.3", "GLM-5.3", ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", ["high", "xhigh"]],
  ["hy3", "Hy3", ["low", "high"]],
  ["kimi-k3", "Kimi-K3"],
  ["kimi-k2.6", "Kimi-K2.6"],
  ["minimax-m3", "MiniMax-M3"],
];

// ChatLink src/main/providers/builtin/codebuddy.ts:49-66 的模型映射（wire id 为准）。
const CODEBUDDY_MODELS = [
  ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro"],
  ["deepseek-v4-flash", "DeepSeek-V4-Flash"],
  ["hy4-preview", "Hy4-Preview"],
  ["hy3", "Hy3"],
  ["hy3-x", "Hy3-X"],
  ["glm-5.3", "GLM-5.3"],
  ["glm-5.3-flash", "GLM-5.3-Flash"],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5.1", "GLM-5.1"],
  ["glm-5v-turbo", "GLM-5V-Turbo"],
  ["kimi-k3-1", "Kimi-K3-1"],
  ["kimi-k2.8-preview", "Kimi-K2.8-Preview"],
  ["kimi-k2.7", "Kimi-K2.7"],
  ["kimi-k2.6", "Kimi-K2.6"],
  ["minimax-m3", "MiniMax-M3"],
];

// 国际模型线（gpt-/gemini-/claude-）→ intl 档；国内模型线（glm-/hy/kimi-/minimax-）
// → cn 档；未命中 → uaDefault。出处：
// ChatLink src/main/providers/builtin/workbuddy.ts:66-79。
const UA_TIERS = [
  ["gpt-", "intl"],
  ["gemini-", "intl"],
  ["claude-", "intl"],
  ["glm-", "cn"],
  ["hy", "cn"],
  ["kimi-", "cn"],
  ["minimax-", "cn"],
];

export const PRODUCTS = {
  "workbuddy-ai": {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    // 站点 = API（与登录页同域）。opencode-workbuddy-auth/index.mjs:93-110
    site: "https://www.workbuddy.ai",
    endpoint: "https://www.workbuddy.ai",
    platform: "workbuddy-ai",
    // 桌面客户端形态：WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0
    app: "5.9.3",
    cli: "2.165.0",
    appName: "workbuddy-ai",
    product: "SaaS",
    productCode: "workbuddy",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    runtime: "local-agent",
    // WorkBuddy 头族（sign/chatHeaders）附加项 + 会话身份头 + gzip 请求体。
    agentIntent: true,
    requestedWith: true,
    agentType: true,
    conversation: true,
    cacheKey: true,
    gzip: true,
    keysUrl: "https://www.workbuddy.ai/profile/keys",
    appendSessionParams: true,
    maxConcurrency: 3,
    ua: {
      intl: "WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0",
      cn: "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
    },
    uaTiers: UA_TIERS,
    uaDefault: "intl",
    models: AI_MODELS,
  },

  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    // 中国版站点是 www.workbuddy.cn（keys 页在此），API 却与 CodeBuddy 同域：
    // opencode-workbuddy-auth/index.mjs:72（endpoint copilot.tencent.com）、
    // :87（keys www.workbuddy.cn）、:416-419（CLI 的中国版前端门 = copilot.tencent.com）。
    site: "https://www.workbuddy.cn",
    endpoint: "https://copilot.tencent.com",
    platform: "workbuddy",
    app: "5.9.3",
    cli: "2.165.0",
    appName: "WorkBuddy",
    product: "SaaS",
    productCode: "workbuddy",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    runtime: "local-agent",
    agentIntent: true,
    requestedWith: true,
    agentType: true,
    conversation: true,
    cacheKey: false,
    gzip: true,
    keysUrl: "https://www.workbuddy.cn/profile/keys",
    appendSessionParams: true,
    maxConcurrency: 3,
    // 中国版只有国内客户端形态一档（opencode-workbuddy-auth/README.md:141-143），
    // 但表结构与国际版一致：uaTiers 留空，任何模型都落到 uaDefault。
    ua: {
      intl: "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
      cn: "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
    },
    uaTiers: [],
    uaDefault: "cn",
    models: CN_MODELS,
  },

  codebuddy: {
    id: "codebuddy",
    name: "CodeBuddy",
    // 站点 = API。ChatLink builtin/codebuddy.ts:28-45。
    site: "https://copilot.tencent.com",
    endpoint: "https://copilot.tencent.com",
    platform: "ide",
    app: "1.106.1",
    cli: "",
    appName: "CodeBuddyIDE",
    product: "CodeBuddy",
    productCode: "codebuddy",
    ideName: "CodeBuddy",
    ideType: "CodeBuddy",
    runtime: "",
    agentIntent: false,
    requestedWith: false,
    agentType: false,
    conversation: false,
    cacheKey: false,
    gzip: false,
    keysUrl: "",
    appendSessionParams: false,
    maxConcurrency: 3,
    ua: {
      intl: "CodeBuddyIDE/1.106.1",
      cn: "CodeBuddyIDE/1.106.1",
    },
    uaTiers: [],
    uaDefault: "intl",
    models: CODEBUDDY_MODELS,
  },
};

export function productOf(id) {
  return PRODUCTS[id] ?? null;
}

/** 模型行 → OpenCode/magpie 模型表。未知名会在 loader 里被 404 拦下。 */
export function modelRows(product) {
  const out = {};
  for (const [id, name, efforts] of product.models) {
    out[id] = {
      name,
      tool_call: true,
      ...(Array.isArray(efforts) && efforts.length ? { reasoning: true, variants: efforts } : {}),
    };
  }
  return out;
}

/** magpie 可能把模型叫 "workbuddy-ai/gpt-5.5"；上游要裸 id。 */
export function stripModelFor(product, value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(product.id + "/") ? id.slice(product.id.length + 1) : id;
}

/** 按模型族选 UA 档：国际线 intl、国内线 cn，未命中用产品默认档。 */
export function uaForModel(product, model) {
  const id = String(model ?? "");
  for (const [match, tier] of product.uaTiers ?? []) {
    if (id.startsWith(match)) return product.ua[tier];
  }
  return product.ua[product.uaDefault];
}

/** 授权 / 元数据请求用的默认 UA（不按模型分档）。 */
export function uaDefault(product) {
  return product.ua[product.uaDefault];
}
