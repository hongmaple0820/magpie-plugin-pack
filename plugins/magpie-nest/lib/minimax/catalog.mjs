// MiniMax 远端模型目录（/mavis/api/v1/models，每账号 5 分钟缓存）。
//
// 参考实现：F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-auth.ts
//   —— fetchRawModels() + parseMinimaxModelsPayload() + normalizeMinimaxModel()
//
// 设计约束（与 lib/lobsterai/catalog.mjs 同套路）：
//   - 目录是**展示信息**：拿不到就返回 null，让调用方保留兜底表，
//     绝不因为目录失败让整个 provider 报错。
//   - 远端成功但解析出 0 条 → 同样返回 null（避免空列表让 provider 消失）。
//   - 缓存按 token 分桶，互不串号。

import {
  MINIMAX_MODELS_PATH,
  MINIMAX_MODEL_TTL_MS,
  MINIMAX_REQUEST_TIMEOUT_MS,
  SITE,
  toModelRow,
} from "./constants.mjs";

const positiveInt = (value) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
};

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const stringArray = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string" && v !== "") : undefined;

/**
 * 单条远端模型 → 归一形状（字段名照 OFM MinimaxModelEntry）。
 * ⚠️ id 与 name 是两个不同字段：对象 key 是长名（MiniMax-M3.1-Flash-Preview），
 * 条目自带 name 是短名（M3.1-Flash-Preview），官方面板显示短名。
 */
export function normalizeModel(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const id = nonEmptyString(raw.id) ?? nonEmptyString(raw.name);
  if (id === undefined) return undefined;
  const name = nonEmptyString(raw.name) ?? id;

  const limit = typeof raw.limit === "object" && raw.limit !== null ? raw.limit : {};
  const options = Array.isArray(raw.context_window_options)
    ? raw.context_window_options.filter((v) => positiveInt(v) !== undefined)
    : [];
  // 窗口取档位表最大档（照 OFM）：M3.1 的 limit.context 是 512000，
  // 但 context_window_options 有 [512000, 1000000]，填小值会让压缩提前触发。
  const contextWindow = options.length > 0 ? Math.max(...options) : positiveInt(limit.context) ?? 0;

  const modalities = typeof raw.modalities === "object" && raw.modalities !== null ? raw.modalities : {};
  const inputs = Array.isArray(modalities.input)
    ? modalities.input.filter((v) => typeof v === "string")
    : [];

  const effortOptions = stringArray(raw.effort_options);
  const rawDefault = nonEmptyString(raw.default_effort);
  // 默认档必须落在档位表内，否则不发（照 Qoder resolveModel）。
  const defaultEffort =
    rawDefault !== undefined && effortOptions?.includes(rawDefault) === true ? rawDefault : undefined;

  const thinkingConfig =
    typeof raw.thinking_config === "object" && raw.thinking_config !== null ? raw.thinking_config : undefined;
  const thinkingMode = thinkingConfig === undefined ? undefined : nonEmptyString(thinkingConfig.mode);

  return {
    id,
    name,
    contextWindow,
    maxTokens: positiveInt(limit.output),
    supportsImage: inputs.includes("image"),
    effortOptions,
    defaultEffort,
    thinkingMode,
  };
}

/** 解析 {providers:[{providerId:'minimax',config:{models,model_order}}]} → 条目数组。 */
export function parseModelsPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const providers = payload.providers;
  if (!Array.isArray(providers)) return [];
  const minimax = providers.find(
    (p) => typeof p === "object" && p !== null && p.providerId === "minimax",
  );
  if (minimax === undefined) return [];
  const config = minimax.config;
  if (typeof config !== "object" || config === null) return [];
  const models = config.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return [];

  const out = [];
  for (const [id, raw] of Object.entries(models)) {
    const withId =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw, id } : { id };
    const entry = normalizeModel(withId);
    if (entry !== undefined) out.push(entry);
  }

  // 按远端 model_order 排序（没有就保持对象插入序）。
  const order = config.model_order;
  if (Array.isArray(order)) {
    const index = new Map();
    order.forEach((id, i) => {
      if (typeof id === "string") index.set(id, i);
    });
    out.sort(
      (a, b) =>
        (index.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return out;
}

// token → { at, rows }（按 token 分桶；一个渠道可能挂多个账号）
const cache = new Map();

/** 测试用：清空缓存。 */
export function resetCatalog() {
  cache.clear();
}

/**
 * 拉远端目录，返回 **按 id 键控的 magpie 模型目录对象**；失败返回 null。
 * @param {string} token Bearer access_token
 * @param {{ site?: typeof SITE, now?: number, signal?: AbortSignal }} [opts]
 */
export async function fetchCatalog(token, opts = {}) {
  const site = opts.site ?? SITE;
  const key = `${site.api}|${token}`;
  const now = opts.now ?? Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < MINIMAX_MODEL_TTL_MS) return hit.rows;

  if (!String(token ?? "").trim()) return null;

  try {
    const url = new URL(`${site.api}${MINIMAX_MODELS_PATH}`);
    url.searchParams.set("region", site.region ?? "cn");
    url.searchParams.set("buildEnv", site.buildEnv ?? "prod");
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: opts.signal ?? AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => undefined);
    const entries = parseModelsPayload(body);
    if (entries.length === 0) {
      // 远端成功但解析出 0 条：必须留日志，否则无法区分「远端坏了」与「远端返回 0 条」。
      console.warn(`[minimax] 远端模型目录解析出 0 条，已回退兜底表`);
      return null;
    }
    const rows = Object.fromEntries(entries.map((entry) => [entry.id, toModelRow(entry)]));
    cache.set(key, { at: now, rows });
    return rows;
  } catch (error) {
    console.warn(`[minimax] 拉取远端模型目录失败，已回退兜底表: ${error?.message ?? error}`);
    return null;
  }
}
