// Qoder 双版本渠道协议事实与静态模型行。
//
// 参考实现（按可信度）：
//   - @magpie-community/opencode-qoder-auth (index.mjs)  —— 已装可用的社区实现
//   - F:/maple/ChatLink/src/main/oauth/adapters/qoder.ts —— 设备码流与 region 配置
//   - F:/maple/dsh-our-free-model/vendor/channel-pack/src/qoder-product.ts
//     —— CN asar 实测：authClientIds.prod 佐证 client_id 归属
//
// 注意：社区插件 index.mjs:3050-3077 的 SITES 表把两个 client_id 写反了
// （intl 用了 CN 的、CN 用了 intl 的）；ChatLink qoder.ts:50-62 与
// dsh-our-free-model qoder-product.ts:446,609 的归属一致，且 CN 侧有
// asar 实测证据，本文件以 ChatLink 为准。见 README「坑 2」。

export const CHAT = "@ai-sdk/openai-compatible";
export const COSY_VERSION = "1.1.69";

export const CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
export const MODELS_PATH = "/algo/api/v2/model/list?Encode=1";

export const POLL_PATH = "/api/v1/deviceToken/poll";
export const DEVICE_REFRESH_PATH = "/api/v1/deviceToken/refresh";
export const JOB_TOKEN_PATH = "/api/v1/me/jobToken";
export const JOB_EXCHANGE_PATH = "/api/v1/jobToken/exchange";
export const JOB_REFRESH_PATH = "/api/v1/jobToken/refresh";
export const USERINFO_PATH = "/api/v1/userinfo";
export const DEVICE_SELECT_PATH = "/device/selectAccounts";

export const SIGN_IN_TIMEOUT = 15 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const DAY = 24 * 60 * 60 * 1000;

// Qoder 内嵌的 1024-bit RSA 公钥：包装每个请求 COSY 信封里的 AES key。
// 来源：社区 index.mjs:65-70（客户端 cosy 源码提取）。
export const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

// 国际版模型行（社区 index.mjs:818-836，2026-09-30 目录快照 + 10-12 的 Fast）。
// 字段即 Qoder 目录语义：id 是目录 key（请求里写的名字），name 是展示名。
const INTL_ROWS = [
  ["ultimate", "Ultimate", 1_000_000, true, ["low", "medium", "high", "xhigh", "max"], "high"],
  ["fast", "Fast", 1_000_000, true, [], ""],
  ["performance", "Performance", 1_000_000, true, ["low", "medium", "high", "xhigh", "max"], "high"],
  ["efficient", "Efficient", 200_000, true, [], ""],
  ["smodel", "Sonus", 180_000, true, ["low", "medium", "high", "xhigh", "max"], "high"],
  ["cmodel", "Cantus", 180_000, true, ["low", "medium", "high", "xhigh", "max"], "high"],
  ["qmodel_38max", "Qwen3.8-Max", 180_000, true, ["low", "medium", "xhigh"], "medium"],
  ["qfmodel", "Qwen3.8-Flash", 180_000, true, ["low", "medium", "xhigh"], "medium"],
  ["qmodel_latest", "Qwen3.7-Max", 1_000_000, true, [], ""],
  ["qmodel", "Qwen3.7-Plus", 1_000_000, true, [], ""],
  ["kmodel_latest", "Kimi-K3", 180_000, true, ["low", "high", "max"], "max"],
  ["kmodel", "Kimi-K2.8-Preview", 180_000, true, ["low", "high", "max"], "max"],
  ["gmodel", "GLM-5.3", 180_000, true, ["low", "high", "max"], "max"],
  ["gfmodel", "GLM-5.3-Flash", 1_000_000, true, ["high", "max"], "max"],
  ["dmodel", "DeepSeek-V4-Pro", 1_000_000, true, ["high", "max"], "max"],
  ["dfmodel", "DeepSeek-Flash", 1_000_000, true, ["low", "high", "max"], "max"],
  ["mmodel", "MiniMax-M3", 180_000, true, [], ""],
];

// 中国版静态模型行。实测（2026-11-10，qoder-cn 账号 199****8156）：
// 国际版的档位名 ultimate/performance/efficient/lite 在中国版网关全部 400
// "Unsupported model"，能用的是目录 key 家族（qmodel_*/kmodel_*/dmodel…）。
// 已联网验证通过：qmodel_latest、qmodel_38max、qmodel、qfmodel、
// kmodel_latest、dmodel、cmodel、mmodel；其余照社区目录补入。
const CN_ROWS = INTL_ROWS.filter(([id]) =>
  [
    "qmodel_latest",
    "qmodel_38max",
    "qmodel",
    "qfmodel",
    "kmodel_latest",
    "kmodel",
    "dmodel",
    "dfmodel",
    "mmodel",
    "cmodel",
    "smodel",
  ].includes(id),
);

function rowsOf(rows) {
  const out = {};
  for (const [id, name, context, images, efforts, defaultEffort] of rows) {
    out[id] = {
      name,
      limit: { context, output: 0 },
      attachment: images,
      modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
      ...(efforts.length ? { reasoning: true, variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])) } : { reasoning: false }),
      tool_call: true,
      // 私有元数据：请求构造直接读目录语义，不写进 models.dev 可见字段。
      key: id,
      source: "system",
      format: "openai",
      isVl: images,
      isReasoning: efforts.length > 0,
      efforts,
      defaultEffort,
      alwaysThinks: efforts.length > 0,
      maxInput: context,
    };
  }
  return out;
}

// REGIONS：两个 provider 的 host 表与各自模型行。
// client_id 归属以 ChatLink qoder.ts:50-62 为准（CN asar 实测佐证）。
export const REGIONS = {
  qoder: {
    id: "qoder",
    name: "Qoder",
    authBase: "https://qoder.com",
    openApi: "https://openapi.qoder.sh",
    api: "https://api3.qoder.sh",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    // 国际版：设备码换 job token（社区 index.mjs:664 /api/v1/me/jobToken）。
    deviceChat: false,
    models: rowsOf(INTL_ROWS),
  },
  "qoder-cn": {
    id: "qoder-cn",
    name: "Qoder CN",
    authBase: "https://qoder.cn",
    openApi: "https://openapi.qoder.com.cn",
    api: "https://gateway.qoder.com.cn",
    clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    // 中国版：CLI 直接用设备码 token 聊天；job token 换不到（4xx）就退回
    // 设备 token（社区 index.mjs:3072, 672-677）。
    deviceChat: true,
    models: rowsOf(CN_ROWS),
  },
};

/** 静态表未枚举的模型：给一个中性目录项，让上游自己判断支持与否。 */
export function fallbackEntry(id) {
  return {
    name: id,
    limit: { context: 200000, output: 0 },
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
    defaultEffort: "",
    alwaysThinks: false,
    maxInput: 200000,
  };
}

export function regionOf(id) {
  return REGIONS[id] ?? null;
}

export function modelRows(regionId = "qoder") {
  return (REGIONS[regionId] ?? REGIONS.qoder).models;
}

/** magpie 可能把模型写成 "qoder/qfmodel"；上游只要裸 key。 */
export function stripModel(regionId, value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(regionId + "/") ? id.slice(regionId.length + 1) : id;
}
