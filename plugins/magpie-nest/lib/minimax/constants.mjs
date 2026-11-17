// MiniMax Code（中国版）渠道协议事实与静态模型行。
//
// 参考实现（按可信度）：
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-product.ts
//     —— asar 实测：PRESET_BASE_URLS['cn-prod']、endpoint-config.js、auth.json
//   - F:\maple\ChatLink\src\main\oauth\adapters\minimax.ts
//     —— 设备码流与常量配置
//
// 端点实测定论（2026-11-17，假 token 探针：404=路由不存在，401=仅凭证假）：
//   - POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages → 401 auth failed（路由存在）
//   - GET  https://agent.minimax.cn/mavis/api/v1/models?...          → 401 auth failed（目录路由存在）
//   - POST https://account.minimax.cn/oauth2/device/code            → 200（客户端常量全对）
//   ⚠️ 不要改成 api.minimaxi.com —— 那是开放平台 API-key 产品，返回的是
//      `Please carry the API secret key in the 'X-Api-Key' field`，与本渠道无关。

// ⚠️ 必须是 openai-compatible（与 qoder/trae/lobsterai 一致）：
// 本插件把入站的 /chat/completions 转成 Anthropic Messages 再转回 Chat Completions
// 形态返回。若声明 @ai-sdk/anthropic，入站请求会变成 /v1/messages，被 index.mjs
// 的路径闸门本地 404，且响应形态也对不上。
export const CHAT = "@ai-sdk/openai-compatible";

export const MINIMAX_DEVICE_CODE_PATH = "/oauth2/device/code";
export const MINIMAX_TOKEN_PATH = "/oauth2/token"; // 真实值被哈工大 secret-scrubber 遮蔽，标准 OAuth2 token endpoint
export const MINIMAX_REVOKE_PATH = "/oauth2/revoke";
export const MINIMAX_MODELS_PATH = "/mavis/api/v1/models";
export const MINIMAX_INFER_PATH = "/mavis/api/v1/llm/v1/messages";
export const MINIMAX_SIGNIN_STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
export const MINIMAX_SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";
export const MINIMAX_CREDIT_DETAILS_PATH = "/minimax-cloud/api/v1/credit/details";

export const MINIMAX_REQUEST_TIMEOUT_MS = 30_000;
export const MINIMAX_OAUTH_TIMEOUT_MS = 20_000;
export const MINIMAX_MODEL_TTL_MS = 300_000;

export const SIGN_IN_TIMEOUT = 15 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;
export const DAY = 24 * 60 * 60 * 1000;

// ========== 兜底模型表（4 条，顺序照远端 model_order）==========
// ⚠️ 必须镜像远端实测值 —— 两处不一致会让「远端失败降级到兜底表」时
// 档位或窗口**凭空变化**，且极难排查。

const FALLBACK_MODELS = [
  {
    id: "MiniMax-M3.1-Flash-Preview",
    name: "M3.1-Flash-Preview",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    effortOptions: ["default", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "default",
    thinkingMode: "forced_on",
  },
  {
    id: "MiniMax-M3",
    name: "M3",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    effortOptions: undefined,
    defaultEffort: undefined,
    thinkingMode: "switchable",
  },
  {
    id: "MiniMax-M2.7-highspeed",
    name: "M2.7-highspeed",
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    effortOptions: undefined,
    defaultEffort: undefined,
    thinkingMode: "forced_on",
  },
  {
    id: "MiniMax-M2.7",
    name: "M2.7",
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    effortOptions: undefined,
    defaultEffort: undefined,
    thinkingMode: "forced_on",
  },
];

/**
 * magpie/dsh 认得的档位词（catalog.EffortRank + EffortAliases）。
 *
 * ⚠️ 插件声明的 `variants` 只有**键**会被 magpie 读走当档位名
 * （internal/plugin/host.js:2357 `variants: Object.keys(...)`，值整块丢弃），
 * 且键必须是这里的词之一，否则 catalog.Model.Efforts 为空 → DSH 里没有档位可选。
 * 所以「开启思考 on」这种上游私有值不能当键，只能映射到梯队词（用 high 代表开）。
 */
const DSH_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "light", "extra_high"]);

/** 远端 effort_options 里 DSH 真的能表达的档位（丢掉 default 这类私有值）。 */
export function effortOptionsOf(m) {
  return (m.effortOptions ?? []).filter((e) => DSH_LEVELS.has(e));
}

/**
 * DSH 里这个模型能选的思考档位（照 OFM minimaxReasoningInfo，但按 magpie 的规矩改键）：
 *   - 远端档位在前（过滤掉 DSH 表达不了的）；
 *   - switchable 且**没有可用档位**的（M3）只给「关 none / 开 high」两态 ——
 *     OFM 原本给 on/none，但 "on" 不是梯队词，会被 magpie 丢掉，只剩 off，
 *     而 dshModelLevels 对「只有一个 off」的模型直接返回 nil，等于一个档位都没有。
 *   - forced_on 的模型绝不追加 none —— M3.1 会硬 400，M2.7 会被静默忽略
 *     （那会让用户以为关掉了、实际没关，比不给选项更糟）。
 */
export function effortIds(m) {
  const ids = effortOptionsOf(m);
  if (m.thinkingMode === "switchable") {
    if (ids.length === 0) return ["high", "none"];
    if (!ids.includes("none")) ids.push("none");
  }
  return ids;
}

/** 单条模型行 → magpie 模型目录项。 */
export function toModelRow(m) {
  const modalities = m.supportsImage
    ? { input: ["text", "image"], output: ["text"] }
    : { input: ["text"], output: ["text"] };
  const ids = effortIds(m);
  const variants = ids.length > 0
    ? Object.fromEntries(ids.map((e) => [e, { reasoningEffort: e }]))
    : undefined;
  // ⚠️ 只有「真的有可选项」才声明 reasoning（照 OFM：options 空且非 switchable → 不声明）。
  // M2.7 系 forced_on 但远端没档位 —— 声明 reasoning 会让 UI 出现一个空选择器。
  const thinks = ids.length > 0;
  return {
    name: m.name,
    limit: { context: m.contextWindow, output: m.maxTokens },
    attachment: m.supportsImage,
    modalities,
    reasoning: thinks,
    variants,
    tool_call: true,
    key: m.id,
    source: "system",
    format: "openai",
    isVl: m.supportsImage,
    isReasoning: thinks,
    efforts: ids,
    // 远端真正下发的档位（可能为空）：chat.mjs 据此决定「关/开两态」还是「带档位的 adaptive」。
    vendorEfforts: effortOptionsOf(m),
    defaultEffort: m.defaultEffort ?? "",
    alwaysThinks: m.thinkingMode === "forced_on",
    maxInput: m.contextWindow,
    thinkingMode: m.thinkingMode,
  };
}

/** 兜底模型行（数组，顺序即远端 model_order）。 */
export const MODEL_ROWS = FALLBACK_MODELS.map(toModelRow);

/** 兜底模型目录（**按 id 键控的对象** —— magpie 的 models 约定）。 */
export function modelRows() {
  return Object.fromEntries(MODEL_ROWS.map((row) => [row.key, row]));
}

/** 按 id 找静态行；未枚举的模型给中性条目（让上游自己判断）。 */
export function modelEntry(id) {
  return MODEL_ROWS.find((row) => row.key === id) ?? fallbackEntry(id);
}

/** 静态表未枚举的模型：给一个中性目录项，让上游自己判断支持与否。 */
export function fallbackEntry(id) {
  return {
    name: id,
    limit: { context: 200_000, output: 0 },
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    reasoning: false,
    tool_call: true,
    key: id,
    source: "system",
    format: "openai",
    isVl: false,
    isReasoning: false,
    efforts: [],
    vendorEfforts: [],
    defaultEffort: "",
    alwaysThinks: false,
    maxInput: 200_000,
  };
}

/** magpie 可能把模型写成 "minimax/MiniMax-M3"；上游只要裸 key。 */
export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith("minimax/") ? id.slice("minimax/".length) : id;
}

/** 站点配置（单版本，无 region 分裂）。 */
export const SITE = {
  id: "minimax",
  name: "MiniMax Code",
  authBase: "https://account.minimax.cn",
  api: "https://agent.minimax.cn",
  clientId: "mcode-public",
  audience: "agent-backend",
  scope: "agent.default",
  region: "cn",
  buildEnv: "prod",
};
