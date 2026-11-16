// 价格快照：按「生效时刻」分档，**历史成本不随价格变动而变**。
//
// 为什么需要它：账簿（usage.jsonl）里只有 token 数，没有金额；现在的算法是
// 每次查询都用 `~/.cache/magpie/models.json` 的**当前**价格现算，于是厂商一改价，
// 上个月的成本跟着变——既不真，也无法解释「昨天这个数是多少」。
//
// 这里的规矩（v7 §4.3）：
//   - 快照文件里按 `effectiveFrom` 递增存多档，每档是一份「模型 → 单价」；
//   - 计价时取「生效时刻 ≤ 事件时刻」的最新那一档，用它算——过去的事件永远
//     落在过去那一档上，新增一档不会改写它；
//   - 同一 `effectiveFrom` 不允许覆盖（改写历史 = 让过去的成本变得不可复现）；
//   - 没有覆盖该时刻的快照时，不给 0，交 `quality: "unknown"`。
//
// 三档质量：
//   exact       行里自带金额（上游回的账）。当前账簿没有这个字段，留着给以后的源。
//   backfilled  用「事件时刻生效」的快照算出来的——可复现，价格改了也不动。
//   approximate 事件早于所有快照，只能用最早一档倒推——能算，但那一刻的价格没据。
//
// 快照从哪来：`models.dev` 的缓存（`~/.cache/magpie/models.json`）是唯一现成的
// 价格源，第一次用到时按它的 mtime 建第一档；以后想记一次改价，调
// `appendSnapshot()` 追加一档（工具/面板将来可以调它，这一轮不加按钮）。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// 快照文件很少变（只有追加新档才写一次），但每次计价都要读它。30s 是取舍：
// 追加快照后最多 30 秒生效，够用；短于此没有意义（没人在秒级改价），长了则
// 刚追加的一档在面板上迟迟看不到，用户会以为没生效。
// 注意这个数同时是 stat 的限频：Windows 上 statSync 这个路径实测 15ms/次，
// 每条账簿行都 stat 一次会让 30 天汇总从毫秒变一分钟，所以一次 stat 管 30 秒。
const CACHE_MS = 30_000;
let cache = null; // {path, snapshots, statAt}

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

/** 快照文件位置：`MAGPIE_PRICING_JSON` 优先，否则 `<home>/.cache/magpie/pricing.json`。 */
export function pricingPath() {
  if (process.env.MAGPIE_PRICING_JSON) return process.env.MAGPIE_PRICING_JSON;
  const home = homeDir();
  const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  // 和 models.json 的缓存目录保持一致，用户不会多一个要认的路径
  for (const base of [join(home, ".cache", "magpie"), join(local, "magpie")]) {
    const p = join(base, "pricing.json");
    if (existsSync(p)) return p;
  }
  return join(home, ".cache", "magpie", "pricing.json");
}

function modelsCachePath() {
  if (process.env.MAGPIE_MODELS_JSON) return process.env.MAGPIE_MODELS_JSON;
  const home = homeDir();
  for (const p of [join(home, ".cache", "magpie", "models.json"), join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "magpie", "models.json")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 读快照文件（带 30s 缓存）。文件不存在 = 还没有任何快照，不是错误。
 * @returns {Array<{effectiveFrom: string, at: number, source: string, models: Record<string, object>}>} 按 at 升序
 */
export function snapshots() {
  const path = pricingPath();
  const now = Date.now();
  if (cache && cache.path === path && now - cache.statAt < CACHE_MS) return cache.snapshots;
  let st = null;
  try { st = statSync(path); } catch { cache = { path, snapshots: [], statAt: now }; return []; }
  let raw = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { raw = {}; }
  const list = (Array.isArray(raw?.snapshots) ? raw.snapshots : [])
    .map((s) => ({ ...s, at: Date.parse(s?.effectiveFrom ?? "") }))
    .filter((s) => Number.isFinite(s.at) && s.models && typeof s.models === "object")
    .sort((a, b) => a.at - b.at);
  cache = { path, snapshots: list, statAt: now, size: st.size };
  return list;
}

export function resetPricingCache() {
  cache = null;
}

/**
 * 追加一档快照。只允许更晚的生效时刻，且同一时刻不能重复——历史不可改写。
 * @param {{effectiveFrom: string, models: Record<string, object>, source?: string}} snapshot
 * @returns {{ok: boolean, reason?: string, path: string, snapshots: number}}
 */
export function appendSnapshot(snapshot) {
  const path = pricingPath();
  const at = Date.parse(snapshot?.effectiveFrom ?? "");
  if (!Number.isFinite(at)) return { ok: false, reason: "bad-effectiveFrom", path, snapshots: snapshots().length };
  if (!snapshot?.models || typeof snapshot.models !== "object" || !Object.keys(snapshot.models).length) {
    return { ok: false, reason: "empty-models", path, snapshots: snapshots().length };
  }
  const list = snapshots();
  if (list.some((s) => s.at === at)) return { ok: false, reason: "duplicate-effectiveFrom", path, snapshots: list.length };
  if (list.length && at <= list[list.length - 1].at) return { ok: false, reason: "not-newer", path, snapshots: list.length };

  const next = [...list, { effectiveFrom: new Date(at).toISOString(), source: snapshot.source ?? "manual", models: snapshot.models }]
    .map(({ at: _drop, ...rest }) => rest);
  mkdirSync(dirname(path), { recursive: true });
  // 先写临时文件再改名：半个文件被读到等于没有价格
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: 1, snapshots: next }, null, 2));
  renameSync(tmp, path);
  cache = null;
  return { ok: true, path, snapshots: next.length };
}

/** 从 models.dev 缓存建一档快照（只有在快照文件里还没有任何一档时才会动手）。 */
export function bootstrapFromModels() {
  if (snapshots().length) return { ok: true, reason: "already-present", path: pricingPath(), snapshots: snapshots().length };
  const src = modelsCachePath();
  if (!src) return { ok: false, reason: "no-models-cache", path: pricingPath(), snapshots: 0 };
  let st;
  try { st = statSync(src); } catch { return { ok: false, reason: "no-models-cache", path: pricingPath(), snapshots: 0 }; }
  let raw;
  try { raw = JSON.parse(readFileSync(src, "utf8")); } catch { return { ok: false, reason: "bad-models-cache", path: pricingPath(), snapshots: 0 }; }
  const models = {};
  for (const [pid, pv] of Object.entries(raw)) {
    for (const [mid, mv] of Object.entries(pv?.models ?? {})) {
      const c = mv?.cost;
      if (!c || num(c.input) == null) continue;
      models[pid + "/" + mid] = {
        input: num(c.input),
        output: num(c.output),
        cacheRead: num(c.cache_read) ?? num(c.cache_write) ?? num(c.input),
      };
    }
  }
  // 生效时刻取缓存文件的写入时间：那是我们**最早看到这组价格**的时刻，
  // 不能假装这些价格比它更早就是对的。
  return appendSnapshot({ effectiveFrom: new Date(Math.round(st.mtimeMs / 1000) * 1000).toISOString(), models, source: "models.dev" });
}

// 价格表的索引：一个快照里有上万个模型（models.dev 缓存 6.6MB），
// 每行都遍历一次全表会让 30 天账簿的汇总从毫秒变成分钟——实测卡到 180s 没跑完。
// 所以索引在快照对象上一次构建、跟着缓存走（WeakMap，对象被回收就一起走）。
const INDEX_CACHE = new WeakMap();

function indexOf(snapshot) {
  const hit = INDEX_CACHE.get(snapshot);
  if (hit) return hit;
  // 两种键：完整 "provider/model" 优先；裸模型名在多个供应商下取 input 中位
  const exact = new Map();   // "provider/model" → rates
  const bare = new Map();    // "model" → rates[]（同名多供应商，取 input 中位）
  for (const [k, v] of Object.entries(snapshot?.models ?? {})) {
    const key = k.toLowerCase();
    exact.set(key, v);
    const tail = key.split("/").pop();
    let list = bare.get(tail);
    if (!list) bare.set(tail, (list = []));
    list.push(v);
  }
  for (const list of bare.values()) list.sort((a, b) => (a.input ?? 0) - (b.input ?? 0));
  const idx = { exact, bare };
  INDEX_CACHE.set(snapshot, idx);
  return idx;
}

function lookup(snapshot, model) {
  const raw = String(model ?? "").toLowerCase();
  if (!raw) return null;
  const { exact, bare } = indexOf(snapshot);
  const direct = exact.get(raw);
  if (direct) return direct;
  const list = bare.get(raw.split("/").pop());
  return list?.length ? list[Math.floor(list.length / 2)] : null;
}

/**
 * 一个模型在某一时刻的单价与质量。
 * @param {string} model served 名或 "provider/model"
 * @param {number} ts 事件时刻（毫秒）
 * @returns {{rates: object|null, quality: "backfilled"|"approximate"|"unknown", effectiveFrom: string|null}}
 */
export function priceAt(model, ts) {
  const list = snapshots();
  if (!list.length) return { rates: null, quality: "unknown", effectiveFrom: null };
  const at = Number.isFinite(ts) ? ts : Date.now();
  let chosen = null;
  for (const s of list) if (s.at <= at) chosen = s;
  if (!chosen) {
    // 事件早于所有快照：用最早一档倒推，并明确标 approximate。
    const rates = lookup(list[0], model);
    return rates ? { rates, quality: "approximate", effectiveFrom: list[0].effectiveFrom } : { rates: null, quality: "unknown", effectiveFrom: null };
  }
  const rates = lookup(chosen, model);
  return rates ? { rates, quality: "backfilled", effectiveFrom: chosen.effectiveFrom } : { rates: null, quality: "unknown", effectiveFrom: null };
}

/**
 * 按事件时刻给一条用量算钱。
 * @param {{model?: string, served?: string, in?: number, out?: number, cacheRead?: number, cacheWrite?: number, amount?: number}} row
 * @param {number} ts 事件时刻
 * @returns {{usd: number|null, quality: "exact"|"backfilled"|"approximate"|"unknown", snapshotEffectiveFrom: string|null}}
 */
export function costOf(row, ts) {
  // 上游自己回了金额：以账为准，不自己重算。
  if (num(row?.amount) != null) {
    return { usd: row.amount, quality: "exact", snapshotEffectiveFrom: null };
  }
  const hit = priceAt(row?.served ?? row?.model, ts);
  if (!hit.rates) return { usd: null, quality: "unknown", snapshotEffectiveFrom: null };
  const per = 1e6;
  const usd =
    ((row?.in ?? 0) / per) * (hit.rates.input ?? 0) +
    ((row?.out ?? 0) / per) * (hit.rates.output ?? 0) +
    ((row?.cacheRead ?? 0) / per) * (hit.rates.cacheRead ?? hit.rates.input ?? 0) +
    ((row?.cacheWrite ?? 0) / per) * (hit.rates.cacheWrite ?? hit.rates.input ?? 0);
  return { usd, quality: hit.quality, snapshotEffectiveFrom: hit.effectiveFrom };
}
