// magpie 自己的请求账簿：~/.config/magpie/usage.jsonl。
//
// 每行一次上游请求（实测字段）：{t, agent, provider, model, req, served,
// in, out, cache_read, cache_write, ms, ttft_ms, status, stop, …}。
// 为什么用它而不是解析转录：它是纯 JSONL（不用 zstd 解压，实测 9642 行
// 5.5MB 秒读）、token 数是上游回报的真值（不是转录里的估算）、而且带了
// 真实 provider/model，能和 models.dev 的价格目录（~/.cache/magpie/
// models.json）对上算钱。
//
// 边界（必须如实说）：只覆盖经 magpie 转发的流量。直连厂商的会话不在其中，
// 所以 tokenUsage 会在账簿为空时回落到转录扫描，并在 source 里标明来源。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { bootstrapFromModels, costOf as snapshotCost, snapshots } from "./pricing.mjs";

const HOUR = 3_600_000;

export const PERIODS = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function configCandidates() {
  const home = homeDir();
  const out = [];
  if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, "magpie"));
  out.push(join(home, ".config", "magpie"));
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, "magpie"));
  return out;
}

export function ledgerPath() {
  if (process.env.MAGPIE_USAGE_LEDGER) return process.env.MAGPIE_USAGE_LEDGER;
  for (const dir of configCandidates()) {
    const p = join(dir, "usage.jsonl");
    if (existsSync(p)) return p;
  }
  return null;
}

// ── 价格：走 pricing.mjs 的「按事件时刻生效」快照（v7 §4.3）。
// 原来这里每次用 models.json 的当前价现算，厂商一改价上个月的成本跟着变；
// 现在一条请求落在哪一档快照上由它自己的时刻决定，追加新档不改旧账。
// models.json 仍然要用：第一次计价时按它的 mtime 建第一档快照。
// 账簿里没有金额字段，所以这里的成本是「本地折算」，标 backfilled/approximate，
// 不冒充上游的账。
function ensurePricing() {
  if (snapshots().length) return;
  bootstrapFromModels();
}

/**
 * 账簿在窗口内的请求，带单价解析。
 * @returns {{rows: Array, priced: number, unpriced: number, unpricedModels: Array<[string, number]>, path: string}}
 */
export function ledgerRows(fromMs) {
  const path = ledgerPath();
  if (!path) return { rows: [], priced: 0, unpriced: 0, unpricedModels: [], path: null };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return { rows: [], priced: 0, unpriced: 0, unpricedModels: [], path }; }
  ensurePricing();
  const rows = [];
  let priced = 0;
  let unpriced = 0;
  const miss = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const at = Date.parse(j.t ?? "");
    if (!Number.isFinite(at) || at < fromMs) continue;
    const pricedRow = snapshotCost(
      { model: j.model, served: j.served, in: j.in, out: j.out, cacheRead: j.cache_read, cacheWrite: j.cache_write, amount: j.amount },
      at,
    );
    const cost = pricedRow.usd;
    if (cost == null) {
      unpriced++;
      const name = j.served ?? j.model ?? "unknown";
      miss.set(name, (miss.get(name) ?? 0) + 1);
    } else priced++;
    rows.push({
      at,
      agent: j.agent ?? "unknown",
      provider: j.provider ?? "",
      model: j.served ?? j.model ?? "unknown",
      in: j.in ?? 0,
      out: j.out ?? 0,
      cacheRead: j.cache_read ?? 0,
      cost,
      costQuality: pricedRow.quality,
      costSnapshot: pricedRow.snapshotEffectiveFrom,
    });
  }
  return {
    rows,
    priced,
    unpriced,
    unpricedModels: [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    path,
  };
}
