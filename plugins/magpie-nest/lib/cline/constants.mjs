// Cline（cline.bot）渠道协议事实与静态兜底模型表。
//
// 参考实现（按可信度）：
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\cline-product.ts
//     —— 端点、WorkOS 客户端 id、头族、思考档位实测表
//   - ...\cline-oauth.ts —— 设备码三步（device → 轮询 authenticate → 平台 register）
//   - ...\cline.ts       —— 凭据形态（workos: 前缀、refresh 驼峰表单、信封判定）
//   - ...\cline-models.ts / cline-adapter.ts —— 免费集合、模型顺序、工具 schema 清洗
//   - F:\maple\ChatLink\src\main\providers\builtin\cline.ts —— 头族与 reasoning 增量
//
// 端点实测（2026-11-17，假 token 探针：404=路由不存在，401=仅凭证假）：
//   - POST https://api.cline.bot/api/v1/chat/completions  → 401 Unauthorized（路由存在）
//   - GET  https://api.cline.bot/api/v1/models            → 200（455 条，无需认证）
//   - GET  https://api.cline.bot/api/v1/ai/cline/recommended-models → 200（free/recommended/clinePass）
//   - POST https://api.workos.com/user_management/authorize/device  → 200（客户端 id 全对）
//   - POST https://api.workos.com/user_management/authenticate      → 400 invalid_grant（假 device_code）
//   - POST https://api.cline.bot/api/v1/auth/refresh       → 400 failed to refresh token（信封 success:false）
//   - POST https://api.cline.bot/api/v1/auth/register      → 500 failed to refresh tokens（会真去刷一次）
//   ⚠️ 没有 404 类客户端错误；Bearer 必须先过鉴权层，被拒就说明只是凭证假。

export const ID = "cline";
export const NAME = "Cline";
// 上游本来就是 OpenAI Chat Completions + 标准 SSE，本插件只做透传与两处补丁
// （reasoning → reasoning_content、工具 schema 空 enum 清洗）。
export const NPM = "@ai-sdk/openai-compatible";

export const API_BASE = "https://api.cline.bot";
export const CHAT_PATH = "/api/v1/chat/completions";
export const MODELS_PATH = "/api/v1/models";
/** 推荐目录：{recommended, free, clinePass, clineCloud}。免费集合的唯一权威来源。 */
export const RECOMMENDED_PATH = "/api/v1/ai/cline/recommended-models";
export const REGISTER_PATH = "/api/v1/auth/register";
export const REFRESH_PATH = "/api/v1/auth/refresh";
export const ME_PATH = "/api/v1/users/me";

export const WORKOS_BASE = "https://api.workos.com";
export const WORKOS_DEVICE_PATH = "/user_management/authorize/device";
export const WORKOS_AUTHENTICATE_PATH = "/user_management/authenticate";
export const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** access_token 以它开头，**剥掉即 401**（只有解 JWT 取用户信息时才去掉）。 */
export const TOKEN_PREFIX = "workos:";

export const CLINE_REQUEST_TIMEOUT_MS = 30_000;
export const CLINE_OAUTH_TIMEOUT_MS = 20_000;
export const CLINE_MODEL_TTL_MS = 300_000;
export const SIGN_IN_TIMEOUT = 15 * 60 * 1000;

/** Cline 客户端头族（OFM cline-product.ts clientHeaders）。 */
export const CLIENT_HEADERS = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
  "X-IS-MULTIROOT": "false",
  "X-CLIENT-TYPE": "cline-sdk",
};

/**
 * 思考档位：**远端不下发档位，所有模型共用这一张表**（OFM cline-product.ts）。
 * wire id → 显示名，附 OFM 实测 thinking 字符数：
 *   none 0 / low 67 / medium 379 / high 294 / max 1192
 * 所以「不传 reasoning_effort」= 不思考，而不是 none。
 * ⚠️ 请求侧绝不做白名单校验：上游对不认识的档位静默忽略（'banana' → 200 且 0 思考）。
 */
export const EFFORTS = [
  ["none", "None"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["max", "Extra"],
];

/** OFM 明确声明默认 High（代价是思考 token 计入 completion_tokens）。 */
export const DEFAULT_REASONING_EFFORT = "high";

/** 共用的档位对象：键是显示名，值是 wire id（magpie 据此生成 reasoningEfforts 映射）。 */
export const VARIANTS = Object.fromEntries(
  EFFORTS.map(([wire, label]) => [label, { reasoningEffort: wire }]),
);

/** 档位 id 列表（wire 顺序）。 */
export const EFFORT_IDS = EFFORTS.map(([wire]) => wire);

// ========== 兜底模型表 ==========
// 只放**实测免费**的三条（2026-11-17 /api/v1/ai/cline/recommended-models 的 free[]）。
// ⚠️ 免费集合每天都在轮换，远端可用时以 free[] 为准，本表只在远端失败时顶上。
// ⚠️ 窗口未知时填 200k/0 而不是编造：编造的窗口会让 DSH 在错误的位置截断上下文。

const FALLBACK_MODELS = [
  {
    id: "cline-free/nemotron-3.5-super-vl",
    name: "Nemotron 3.5 Super VL",
    contextWindow: 200_000,
    maxTokens: 0,
    supportsImage: true,
  },
  {
    id: "cline-free/solar-mini4",
    name: "Solar Mini 4",
    contextWindow: 200_000,
    maxTokens: 0,
    supportsImage: false,
  },
  {
    id: "nvidia/nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning",
    contextWindow: 200_000,
    maxTokens: 0,
    supportsImage: false,
  },
];

/** 由 id 派生一个够用的显示名（远端只给 id 时用）。 */
export function nameFromId(id) {
  const bare = String(id ?? "").replace(/^cline-free\//, "").replace(/:free$/, "");
  const tail = bare.split("/").pop() ?? bare;
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** 单条模型 → magpie 模型目录项。 */
export function toModelRow(model) {
  const image = model.supportsImage === true;
  const variants = { ...VARIANTS };
  return {
    name: model.name || nameFromId(model.id),
    limit: { context: model.contextWindow ?? 200_000, output: model.maxTokens ?? 0 },
    attachment: image,
    modalities: image
      ? { input: ["text", "image"], output: ["text"] }
      : { input: ["text"], output: ["text"] },
    reasoning: true,
    variants,
    defaultEffort: DEFAULT_REASONING_EFFORT,
    tool_call: true,
    key: model.id,
    source: "system",
    format: "openai",
    isVl: image,
    isReasoning: true,
    efforts: [...EFFORT_IDS],
    maxInput: model.contextWindow ?? 200_000,
  };
}

/** 兜底模型行（数组，顺序即兜底表的顺序）。 */
export const MODEL_ROWS = FALLBACK_MODELS.map(toModelRow);

/** 兜底模型目录（**按 id 键控的对象** —— magpie 的 models 约定）。 */
export function modelRows() {
  return Object.fromEntries(MODEL_ROWS.map((row) => [row.key, row]));
}

/** 按 id 找兜底行；未枚举的模型给中性目录项（让上游自己判断）。 */
export function modelEntry(id) {
  return MODEL_ROWS.find((row) => row.key === id) ?? fallbackEntry(id);
}

/** 兜底表未枚举的模型：中性项，档位仍按共用表给（远端对所有模型都认这张表）。 */
export function fallbackEntry(id) {
  const row = toModelRow({ id, name: nameFromId(id) });
  return { ...row, name: nameFromId(id) };
}

/** magpie 可能把模型写成 "cline/xxx"；上游只要裸 id。 */
export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(`${ID}/`) ? id.slice(ID.length + 1) : id;
}

/** 站点配置（单版本，无 region 分裂）。 */
export const SITE = {
  id: ID,
  name: NAME,
  api: API_BASE,
  workOsBase: WORKOS_BASE,
  clientId: WORKOS_CLIENT_ID,
};
