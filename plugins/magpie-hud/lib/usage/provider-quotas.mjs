// 各 provider 的额度：读 magpie 自己收集的 ~/.config/magpie/quotas.json。
//
// 为什么用它而不是 spawn 各家的 CLI：magpie 已经在后台把**所有 provider**
// 的额度读好并落了盘（本机实测 15 个 provider / 21 个账号），窗口对象带
// {name, used, amount, limit, unit, balance, display, resetsAt, runsOut,
// runsOutAt}。插件自己去 spawn claude/codex 只能覆盖两家，而且要求那两个
// CLI 装在 PATH 里（本机就没有）。用 magpie 的账，广度与准确度都更好。
//
// 归一化后的窗口：
//   percent    amount/limit 的百分比（两者都在才算，否则 null——不猜）
//   left       balance 形式的剩余量
//   display    厂商/ magpie 给的现成文案
//   runsOut / runsOutAt  magpie 已算好的耗尽时间，直接透传
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_MS = 30_000;
let cache = null; // {at, key, value}

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function configDirs() {
  const home = homeDir();
  const out = [];
  if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, "magpie"));
  out.push(join(home, ".config", "magpie"));
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, "magpie"));
  return out;
}

export function quotasPath() {
  if (process.env.MAGPIE_QUOTAS_JSON) return process.env.MAGPIE_QUOTAS_JSON;
  for (const d of configDirs()) {
    const p = join(d, "quotas.json");
    if (existsSync(p)) return p;
  }
  return null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function normalizeWindow(w) {
  const amount = num(w?.amount);
  const limit = num(w?.limit);
  let percent = null;
  if (amount != null && limit != null && limit > 0) percent = Math.max(0, Math.min(100, (amount / limit) * 100));
  else if (typeof w?.used === "number" && num(w?.limit) == null && w.used > 0 && w.used <= 100) percent = w.used;
  return {
    name: typeof w?.name === "string" ? w.name : "额度",
    percent,
    amount,
    limit,
    left: num(w?.balance),
    unit: typeof w?.unit === "string" ? w.unit : null,
    display: typeof w?.display === "string" ? w.display : typeof w?.text === "string" ? w.text : null,
    resetsAt: typeof w?.resetsAt === "string" ? w.resetsAt : null,
    runsOut: typeof w?.runsOut === "string" ? w.runsOut : null,
    runsOutAt: typeof w?.runsOutAt === "string" ? w.runsOutAt : null,
  };
}

/**
 * 全部 provider 的额度快照。
 * @returns {{providers: Array, totals: object, path: string|null, at: number|null}}
 */
export function providerQuotas() {
  const path = quotasPath();
  if (!path) return { providers: [], totals: { providers: 0, accounts: 0, windows: 0 }, path: null, at: null };
  let st;
  try { st = statSync(path); } catch { return { providers: [], totals: { providers: 0, accounts: 0, windows: 0 }, path, at: null }; }
  const key = path + ":" + st.size + ":" + Math.round(st.mtimeMs);
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { raw = {}; }

  const providers = [];
  let accounts = 0;
  let windows = 0;
  let at = 0;
  for (const [id, entry] of Object.entries(raw)) {
    const q = entry?.quota;
    if (!q) continue;
    accounts++;
    const readAt = typeof q.readAt === "string" ? q.readAt : typeof entry?.at === "string" ? entry.at : null;
    const ts = readAt ? Date.parse(readAt) : NaN;
    if (Number.isFinite(ts) && ts > at) at = ts;
    // 结构不符（windows 不是数组）不能安静地变成「没有额度」：记进 drift，
    // 让仲裁层与面板能说「这个源读不出来」，而不是「你没有额度」（v7 §4.2 规则 4）。
    const drift = q.windows != null && !Array.isArray(q.windows) ? "windows-not-array" : null;
    const ws = (Array.isArray(q.windows) ? q.windows : []).map(normalizeWindow);
    windows += ws.length;
    providers.push({
      id,
      provider: q.provider ?? id.split("/")[0],
      name: q.name ?? q.provider ?? id,
      plan: q.plan ?? null,
      user: q.user ?? null,
      readAt,
      drift,
      windows: ws,
    });
  }
  // 同 provider 多账号排在一起，缺数据的排后
  providers.sort((a, b) => (a.provider === b.provider ? String(a.user).localeCompare(String(b.user)) : a.provider.localeCompare(b.provider)));

  const value = {
    providers,
    totals: { providers: new Set(providers.map((p) => p.provider)).size, accounts, windows },
    path,
    at: at || null,
  };
  cache = { at: Date.now(), key, value };
  return value;
}

export function resetProviderQuotaCache() {
  cache = null;
}
