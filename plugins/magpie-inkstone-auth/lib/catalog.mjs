/**
 * 每账号模型目录：Orbit Agent 通道 + TokenPlan API 通道的并集。
 *
 * 供应商 id 只有一个（inkstone），所以把两个通道的模型合成一张表：
 *  - 两边都有的 id：走 TokenPlan API（标准 OpenAI 兼容，无需协议桥）；
 *  - 只有 Orbit 有的 id：走 Orbit 协议桥（见 lib/bridge.mjs）。
 * 目录按账号（uid + JWT 指纹）缓存，不是按供应商缓存：多账号时互不串味。
 */
import { API_BASE, ORBIT_BASE } from "./constants.mjs";
import { isAuthFailure } from "./http.mjs";
import { listModels as orbitModels } from "./orbit.mjs";
import { listApiModels, mapApiModels } from "./tokenplan.mjs";

const NPM = "@ai-sdk/openai-compatible";
const TTL_MS = 60_000;
const CACHE = new Map();

const FALLBACK = [
  ["intern-s2", "书生-S2"],
  ["sage-a1.5", "书生-A1.5"],
  ["agents-a1", "书生-Agents-A1"],
  ["atria-dawn-preview", "书生-Atria-Dawn-Preview"],
  ["qwen3.7-plus", "Qwen3.7-Plus"],
  ["qwen3.8-flash", "Qwen3.8-Flash"],
  ["glm-5.2", "GLM-5.2"],
  ["kimi-k2.7-code", "Kimi-K2.7-Code"],
];

/** 未登录 / 拉取失败时 config 钩子展示的静态清单（来自使用说明）。 */
export function fallbackModels() {
  const out = {};
  for (const [id, name] of FALLBACK) {
    out[id] = {
      name,
      limit: { context: 128000, output: 8192 },
      tool_call: true,
      provider: { npm: NPM, api: ORBIT_BASE },
    };
  }
  return out;
}

/**
 * magpie 保存的登录信息有两种形态，统一成一个只读视图。
 * oauth: {type:"oauth", access, refresh, expires, uid, username, apiKey, ...}
 * api:   {type:"api", key, metadata:{uid, username, apiKey, ...}}
 */
export function normalizeAuth(auth) {
  const meta = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {};
  const oauth = auth?.type !== "api";
  const fields = oauth ? auth ?? {} : meta;
  const jwt = oauth ? (auth?.access ?? auth?.refresh ?? "") : (auth?.key ?? "");
  const decodedExp = Number(fields.expiresAtMs ?? (oauth ? auth?.expires : 0));
  return {
    type: oauth ? "oauth" : "api",
    token: String(jwt ?? "").trim(),
    uid: String(fields.uid ?? "").trim(),
    username: String(fields.username ?? "").trim(),
    apiKey: String(fields.apiKey ?? "").trim(),
    apiKeyId: String(fields.apiKeyId ?? "").trim(),
    apiKeyName: String(fields.apiKeyName ?? "").trim(),
    apiKeyIdempotency: String(fields.apiKeyIdempotency ?? "").trim(),
    apiKeyError: String(fields.apiKeyError ?? "").trim(),
    expiresAtMs: Number.isFinite(decodedExp) && decodedExp > 0 ? decodedExp : 0,
    raw: auth,
  };
}

function fingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** 账号级 key：uid + JWT 指纹，重新登录后自动换槽。 */
export function accountKey(cred) {
  return `${cred?.uid || "anon"}:${fingerprint(String(cred?.token ?? ""))}`;
}

/** 拉两个通道的清单并合并；任一成功即可用；全部失败时把错误抛给调用方回退。 */
export async function buildCatalog(token, uid, { signal } = {}) {
  const [orbit, api] = await Promise.allSettled([
    orbitModels(token, uid, { signal }),
    listApiModels(token, { signal }).then((data) => mapApiModels(data)),
  ]);
  if (orbit.status === "rejected" && api.status === "rejected") {
    const reasons = [orbit.reason, api.reason];
    const auth = reasons.find(isAuthFailure);
    throw auth || (reasons[0] instanceof Error ? reasons[0] : new Error("模型清单拉取失败"));
  }
  const apiRows = api.status === "fulfilled" && Array.isArray(api.value) ? api.value : [];
  const orbitRows = orbit.status === "fulfilled" && Array.isArray(orbit.value) ? orbit.value : [];

  const raw = new Map();
  // API 通道优先：标准 Chat Completions，少一次 /chat/new，也不吃协议桥的转换误差。
  for (const row of apiRows) {
    if (!row?.id) continue;
    raw.set(row.id, {
      key: row.id,
      apiId: row.id,
      name: row.name || row.id,
      channel: "api",
      contextWindow: Number(row.contextWindow) || 128000,
      maxOutput: Number(row.maxOutput) || 8192,
      supportsThinking: row.supportsThinking === true,
      supportsTools: row.supportsTools === true,
      inputModalities: Array.isArray(row.inputModalities) && row.inputModalities.length ? row.inputModalities : ["text"],
      free: row.free === true,
      pro: false,
    });
  }
  for (const row of orbitRows) {
    if (!row?.id || raw.has(row.id)) continue;
    raw.set(row.id, {
      key: row.id,
      apiId: row.canonicalId || row.id,
      name: row.name || row.id,
      channel: "orbit",
      contextWindow: Number(row.contextWindow) || 128000,
      maxOutput: Number(row.maxOutput) || 8192,
      supportsThinking: row.supportsThinking === true,
      supportsTools: true,
      inputModalities: ["text"],
      free: false,
      pro: row.pro === true,
    });
  }

  // 别名：键名、小写键名、模型的 API id（Orbit 的 canonical_id）都能路由到同一条。
  const entries = new Map();
  for (const [key, entry] of raw) {
    for (const alias of new Set([key, key.toLowerCase(), entry.apiId, String(entry.apiId).toLowerCase()])) {
      if (alias && !entries.has(alias)) entries.set(alias, entry);
    }
  }
  return { entries, list: [...raw.values()] };
}

/** 带 60s TTL 的每账号缓存；fetch 与 provider.models 共用。 */
export async function getCatalog(cred, { force = false, signal } = {}) {
  const key = accountKey(cred);
  const hit = CACHE.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit;
  const built = await buildCatalog(cred.token, cred.uid, { signal });
  const record = { at: Date.now(), entries: built.entries, list: built.list };
  CACHE.set(key, record);
  if (CACHE.size > 32) CACHE.delete(CACHE.keys().next().value);
  return record;
}

export function peekCatalog(cred) {
  const hit = CACHE.get(accountKey(cred));
  return hit && Date.now() - hit.at < TTL_MS * 5 ? hit : null;
}

/** OpenCode Model：magpie 的 models 钩子返回这个形状。 */
export function toModel(entry, base) {
  const channelBase = entry.channel === "orbit" ? ORBIT_BASE : API_BASE;
  const vision = entry.inputModalities.includes("image");
  const model = {
    ...(base && typeof base === "object" ? base : {}),
    id: entry.key,
    name: entry.name,
    api: { id: entry.key, url: `${channelBase}/chat/completions`, npm: NPM },
    limit: { context: entry.contextWindow, output: entry.maxOutput },
    capabilities: {
      reasoning: entry.supportsThinking,
      toolcall: entry.supportsTools,
      attachment: vision,
      input: { text: true, image: vision },
    },
    modalities: { input: entry.inputModalities },
    tool_call: entry.supportsTools,
    reasoning: entry.supportsThinking,
  };
  // config 钩子里的 provider:{npm,api} 与 models 钩子的 api:{...} 是两种写法，别混着留。
  delete model.provider;
  if (entry.free === true) model.free = true;
  if (entry.supportsThinking) model.variants = { off: {}, high: {} };
  return model;
}
