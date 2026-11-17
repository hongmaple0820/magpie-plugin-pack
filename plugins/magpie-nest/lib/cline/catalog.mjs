// Cline 远端模型目录：/api/v1/ai/cline/recommended-models（**无需认证**）。
//
// 参考实现：F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\cline-models.ts
//
// 契约（2026-11-17 实测）：{recommended:[], free:[], clinePass:[], clineCloud:[]}
//   - **免费集合的唯一权威来源是 free[]**：当日三条里有一条
//     （nvidia/nemotron-3.5-lightning-free）既没有 cline-free/ 前缀也没有 :free 后缀，
//     只靠 id 猜免费会漏掉它。
//   - 免费集合每天轮换（2026-11-17 已不是 OFM 表里那三条）。
//
// ⚠️ 故意**不拉** /api/v1/models 的 455 条裸 id：那会把三条免费模型挤出视野，
//    并让 magpie 写回 DSH 的模型表暴涨（每个模型一条，配置重写得又慢又吵）。

import {
  CLINE_MODEL_TTL_MS,
  CLINE_REQUEST_TIMEOUT_MS,
  MODEL_ROWS,
  RECOMMENDED_PATH,
  SITE,
  nameFromId,
  toModelRow,
} from "./constants.mjs";

/** site.api → { at, rows } */
const cache = new Map();

export function resetCatalog() {
  cache.clear();
}

function readIdList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id) out.push(id);
      continue;
    }
    if (entry && typeof entry === "object") {
      const id = [entry.id, entry.model, entry.name]
        .find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
      if (id) out.push(id.trim());
    }
  }
  return out;
}

/** 解析推荐目录；一条都没有时返回 undefined（调用方回退兜底表）。 */
export function parseRecommended(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = typeof payload.data === "object" && payload.data !== null ? payload.data : payload;
  const free = readIdList(record.free);
  const recommended = readIdList(record.recommended);
  const clinePass = readIdList(record.clinePass ?? record.cline_pass);
  if (free.length === 0 && recommended.length === 0 && clinePass.length === 0) return undefined;
  return { free, recommended, clinePass };
}

/** 三个列表 → magpie 模型目录（按 id 键控；**免费优先**，重复只留第一次出现的位置）。 */
export function toRows(lists) {
  const rows = {};
  const push = (id) => {
    if (rows[id]) return;
    const known = MODEL_ROWS.find((row) => row.key === id);
    rows[id] = known ? { ...known } : toModelRow({ id, name: nameFromId(id) });
  };
  for (const id of lists.free ?? []) push(id);
  for (const id of lists.recommended ?? []) push(id);
  for (const id of lists.clinePass ?? []) push(id);
  return rows;
}

/**
 * 拉远端目录（300s 缓存，按 site.api 分桶）。
 * 失败/解析出 0 条 → console.warn + null，调用方保留兜底表。
 */
export async function fetchCatalog(site = SITE, { now = Date.now(), signal } = {}) {
  const key = site.api;
  const hit = cache.get(key);
  if (hit && now - hit.at < CLINE_MODEL_TTL_MS) return hit.rows;

  let payload;
  try {
    const res = await fetch(`${site.api}${RECOMMENDED_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (error) {
    console.warn(`[cline] 远端推荐目录不可用，已回退兜底表: ${error?.message ?? error}`);
    return null;
  }

  const lists = parseRecommended(payload);
  if (!lists) {
    console.warn("[cline] 远端推荐目录解析出 0 条，已回退兜底表");
    return null;
  }

  const rows = toRows(lists);
  cache.set(key, { at: now, rows });
  return rows;
}
