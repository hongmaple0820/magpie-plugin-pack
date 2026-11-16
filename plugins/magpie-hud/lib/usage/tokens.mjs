// 令牌用量：从本机转录里统计各客户端 / 各时间桶的 token 消耗。
//
// 数据来源（各家字段不同，按实测形状解析，不猜）：
//   - DeepSeek Harness（~/.dsh/sessions/<项目>/<会话>/session.v4.jsonl.zstd）：
//     {type:"assistant/message", time, data:{usage:{inputTokens,outputTokens,
//     cacheReadTokens}}}——驼峰。
//   - Claude Code（~/.claude/projects/<项目>/<会话>.jsonl）：
//     {type:"assistant", timestamp, message:{model, usage:{input_tokens,
//     output_tokens, cache_read_input_tokens, cache_creation_input_tokens}}}——蛇形。
//   - Codex（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）：
//     {type:"event_msg", payload:{type:"token_count", info:{last_token_usage}}}。
//
// 为什么不是「每次请求全量扫」：本机 155 个 DSH 转录、124MB，zstd 解压单文件
// 1–34 秒（实测）。所以：
//   1. 只考虑 mtime 落在窗口内的文件（窗口外的文件不可能有窗口内的消息）；
//   2. 超过 MAX_BYTES 的单个文件跳过并计数（partial 里报出来，不假装完整）；
//   3. 每个文件的解析结果按 (mtimeMs, size) 落盘缓存，改过才重解；
//   4. 文件之间用 setImmediate 让出事件循环，别把页面服务卡死。
//
// 成本：本机没有可靠的每模型价格源（magpie 的目录不对外暴露单价），所以只报
// token，不编造金额。
import { existsSync, readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { agentsRoot, atomicWriteJson } from "../delivery/claude.mjs";
import { ledgerRows } from "./ledger.mjs";

const zstd = await import("fzstd").then((m) => m.decompress, () => null);
const HOUR = 3_600_000;
// 单个转录超过这个（压缩后）就跳过：34 秒的解压换一次性统计不值，宁可报 partial。
const MAX_BYTES = Number(process.env.MAGPIE_HUD_TOKEN_MAX_BYTES || 2 * 1024 * 1024);

export const PERIODS = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function cachePath() {
  return process.env.MAGPIE_AGENTS_TOKEN_CACHE || join(agentsRoot(), "tokens-cache.json");
}

// ── 磁盘缓存：{version, files: {<path>: {mtimeMs, size, hours: {"<at>": [i,o,c]}}}}
let cache = null;
const pendingSaves = new Set();

function loadCache() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8"));
    cache = raw && raw.version === 1 && raw.files ? raw : { version: 1, files: {} };
  } catch {
    cache = { version: 1, files: {} };
  }
  return cache;
}

function saveCache() {
  if (!cache) return;
  try { atomicWriteJson(cachePath(), cache); } catch { /* 写不动不影响读数 */ }
}

function readText(file) {
  const raw = readFileSync(file);
  if (!file.endsWith(".zstd")) return raw.toString("utf8");
  if (!zstd) return "";
  try { return new TextDecoder().decode(zstd(new Uint8Array(raw))); } catch { return ""; }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bucketOf = (ms) => Math.floor(ms / HOUR) * HOUR;

// 一个文件里所有 token 事件按小时桶聚合：{"<bucketAt>": [in, out, cacheRead]}
function hoursOf(file, client) {
  const hours = Object.create(null);
  const add = (at, i, o, c, model) => {
    if (!at) return;
    const k = String(bucketOf(at));
    const row = hours[k] ?? (hours[k] = [0, 0, 0, Object.create(null)]);
    row[0] += i; row[1] += o; row[2] += c;
    if (model) row[3][model] = (row[3][model] ?? 0) + i + o;
  };
  const text = readText(file);
  if (!text) return hours;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (client === "dsh") {
      if (j?.type !== "assistant/message" || !j?.data?.usage) continue;
      const u = j.data.usage;
      add(num(j.time), num(u.inputTokens), num(u.outputTokens), num(u.cacheReadTokens), j.data?.model ?? null);
    } else if (client === "claude") {
      if (j?.type !== "assistant" || !j?.message?.usage) continue;
      const at = Date.parse(j.timestamp ?? "");
      if (!Number.isFinite(at)) continue;
      const u = j.message.usage;
      add(at, num(u.input_tokens) + num(u.cache_creation_input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), j.message?.model ?? null);
    } else if (client === "codex") {
      const payload = j?.payload;
      if (j?.type !== "event_msg" || payload?.type !== "token_count") continue;
      const at = Date.parse(j.timestamp ?? "");
      if (!Number.isFinite(at)) continue;
      const u = payload?.info?.last_token_usage ?? payload?.info?.total_token_usage;
      if (!u) continue;
      add(at, num(u.input_tokens), num(u.output_tokens), num(u.cached_input_tokens), payload?.info?.model ?? null);
    }
  }
  return hours;
}

// DSH_HOME 指向的是 DSH 的家目录（里面才有 sessions/），不是 sessions 本身
function dshSessionsRoot() {
  const given = process.env.DSH_HOME;
  if (given && isAbsolute(given)) {
    const nested = join(given, "sessions");
    return existsSync(nested) || !existsSync(given) ? nested : given;
  }
  return join(homeDir(), ".dsh", "sessions");
}

function roots() {
  const home = homeDir();
  return [
    ["dsh", dshSessionsRoot()],
    ["claude", process.env.CLAUDE_CONFIG_DIR || join(home, ".claude", "projects")],
    ["codex", process.env.CODEX_HOME || join(home, ".codex", "sessions")],
  ];
}

// 窗口内可能有关的文件（mtime >= from），连同体积。
function candidates(fromMs) {
  const out = [];
  const walk = (dir, client, level) => {
    if (level > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, client, level + 1); continue; }
      if (!/\.jsonl(\.zstd)?$/.test(e.name)) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs >= fromMs) out.push({ path: p, client, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  for (const [client, root] of roots()) if (existsSync(root)) walk(root, client, 0);
  return out;
}

const inflight = new Set(); // 正在后台暖的 period
const results = new Map();   // period -> 上次算好的快照

function aggregate(period, files) {
  const span = PERIODS[period] ?? PERIODS["24h"];
  const now = Date.now();
  const from = now - span;
  const bucketMs = period === "24h" ? HOUR : period === "7d" ? 6 * HOUR : 24 * HOUR;
  const buckets = new Map();
  const byClient = Object.create(null);
  const byModel = new Map();
  const totals = { in: 0, out: 0, cacheRead: 0, total: 0, events: 0 };
  const fromBucket = Math.floor(from / bucketMs) * bucketMs;

  for (const f of files) {
    if (!f.hours) continue;
    for (const [k, [i, o, c, models]] of Object.entries(f.hours)) {
      const at = Number(k);
      if (!(at >= fromBucket - bucketMs && at <= now)) continue;
      const b = Math.floor(at / bucketMs) * bucketMs;
      if (!buckets.has(b)) buckets.set(b, { at: b, in: 0, out: 0, cacheRead: 0 });
      const row = buckets.get(b);
      row.in += i; row.out += o; row.cacheRead += c;

      const cl = byClient[f.client] ?? (byClient[f.client] = { in: 0, out: 0, cacheRead: 0, total: 0 });
      cl.in += i; cl.out += o; cl.cacheRead += c; cl.total += i + o;

      for (const [model, sum] of Object.entries(models ?? {})) {
        const m = byModel.get(model) ?? (byModel.set(model, { model, client: f.client, in: 0, out: 0 }), byModel.get(model));
        m.in += sum; m.out += 0;
      }
      totals.in += i; totals.out += o; totals.cacheRead += c; totals.total += i + o; totals.events++;
    }
  }

  const list = [];
  for (let at = fromBucket; at <= now; at += bucketMs) list.push(buckets.get(at) ?? { at, in: 0, out: 0, cacheRead: 0 });

  return {
    period,
    from,
    to: now,
    bucketMs,
    buckets: list,
    byClient,
    byModel: [...byModel.values()].sort((a, b) => b.in - a.in).slice(0, 8),
    totals,
  };
}

// 从 magpie 的请求账簿聚合：快（纯 JSONL）、准（上游回报的 token）、能算钱。
// 只覆盖经 magpie 的流量；调用方用 rows.length 判断要不要回落到转录。
function fromLedger(period) {
  const span = PERIODS[period] ?? PERIODS["24h"];
  const now = Date.now();
  const from = now - span;
  const { rows, priced, unpriced, unpricedModels, path } = ledgerRows(from);
  const bucketMs = period === "24h" ? HOUR : period === "7d" ? 6 * HOUR : 24 * HOUR;
  const fromBucket = Math.floor(from / bucketMs) * bucketMs;

  const buckets = new Map();
  const byClient = Object.create(null);
  const byModel = new Map();
  const byProvider = Object.create(null);
  const totals = { in: 0, out: 0, cacheRead: 0, total: 0, events: 0 };
  let cost = 0;
  let internal = 0;
  // 三档质量各自一个桶：将来接上带金额的源，面板就能把「上游的账」与
  // 「本地按快照折算」分栏显示，不相加（§4.3）。
  const costQuality = { exact: 0, backfilled: 0, approximate: 0, unknown: 0 };

  for (const r of rows) {
    // magpie 自己发起的调用（压缩、masking 等走自家网关）不算用户的 agent 用量：
    // 只计数，不混进按 agent / 按 provider 的统计。
    if (r.agent === "magpie") { internal++; continue; }
    const b = Math.floor(r.at / bucketMs) * bucketMs;
    if (!buckets.has(b)) buckets.set(b, { at: b, in: 0, out: 0, cacheRead: 0 });
    const row = buckets.get(b);
    row.in += r.in; row.out += r.out; row.cacheRead += r.cacheRead;

    const cl = byClient[r.agent] ?? (byClient[r.agent] = { in: 0, out: 0, cacheRead: 0, total: 0, cost: 0, requests: 0 });
    cl.in += r.in; cl.out += r.out; cl.cacheRead += r.cacheRead; cl.total += r.in + r.out; cl.requests++;
    if (r.cost != null) cl.cost += r.cost;

    const key = r.model;
    const m = byModel.get(key) ?? (byModel.set(key, { model: key, client: r.agent, provider: r.provider, in: 0, out: 0, cost: 0 }), byModel.get(key));
    m.in += r.in; m.out += r.out;
    if (r.cost != null) m.cost += r.cost;

    const pk = r.provider || "unknown";
    const pv = byProvider[pk] ?? (byProvider[pk] = { provider: pk, in: 0, out: 0, cacheRead: 0, total: 0, requests: 0, cost: 0 });
    pv.in += r.in; pv.out += r.out; pv.cacheRead += r.cacheRead; pv.total += r.in + r.out; pv.requests++;
    if (r.cost != null) pv.cost += r.cost;

    totals.in += r.in; totals.out += r.out; totals.cacheRead += r.cacheRead;
    totals.total += r.in + r.out; totals.events++;
    if (r.cost != null) cost += r.cost;
    if (r.costQuality in costQuality) costQuality[r.costQuality]++;
  }

  const list = [];
  for (let at = fromBucket; at <= now; at += bucketMs) list.push(buckets.get(at) ?? { at, in: 0, out: 0, cacheRead: 0 });

  return {
    period, from, to: now, bucketMs,
    buckets: list,
    byClient,
    byModel: [...byModel.values()].sort((a, b) => b.in + b.out - (a.in + a.out)).slice(0, 8),
    totals,
    byProvider,
    internal,
    source: "ledger",
    ledger: path,
    scanning: false,
    parsed: rows.length,
    total: rows.length,
    skipped: 0,
    cost: { usd: cost, priced, unpriced, unpricedModels, currency: "USD", quality: costQuality, basis: "价格快照（按事件时刻生效）；models.dev 每百万 token 单价" },
  };
}

/**
 * 立刻返回当前能算出来的快照；没算过的文件在后台依次解析并落盘。
 * 优先用 magpie 的请求账簿（快且能算钱），没有账簿才回落到转录扫描。
 * @returns {{...aggregate, scanning: boolean, parsed: number, total: number, skipped: number}}
 */
export function tokenUsage(period = "24h") {
  const viaLedger = fromLedger(period);
  if (viaLedger.ledger && viaLedger.totals.events > 0) {
    results.set(period, viaLedger);
    return viaLedger;
  }
  const viaTranscripts = fromTranscripts(period);
  return { ...viaTranscripts, source: "transcripts" };
}

function fromTranscripts(period = "24h") {
  const span = PERIODS[period] ?? PERIODS["24h"];
  const from = Date.now() - span;
  const files = candidates(from);
  const store = loadCache();

  const usable = [];
  let skipped = 0;
  let missing = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) { skipped++; continue; }
    const hit = store.files[f.path];
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) usable.push({ ...f, hours: hit.hours });
    else missing.push(f);
  }

  const snapshot = {
    ...aggregate(period, usable),
    cost: null, // 转录里没有 provider/model，无法对价，不编造
    scanning: missing.length > 0 || inflight.has(period),
    parsed: usable.length,
    total: usable.length + missing.length,
    skipped,
  };
  results.set(period, snapshot);

  if (missing.length && !inflight.has(period)) {
    inflight.add(period);
    // 后台逐个解析：每个文件之间让出事件循环，页面服务照常响应。
    const step = () => {
      const next = missing.shift();
      if (!next) { inflight.delete(period); saveCache(); return; }
      try {
        const hours = hoursOf(next.path, next.client);
        store.files[next.path] = { mtimeMs: next.mtimeMs, size: next.size, hours };
      } catch { /* 坏文件跳过 */ }
      setImmediate(step);
    };
    setImmediate(step);
  }
  return snapshot;
}

// 测试用：清掉内存里的缓存引用
export function resetTokenCache() {
  cache = null;
  results.clear();
  inflight.clear();
}
