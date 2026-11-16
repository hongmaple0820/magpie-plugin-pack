// 额度历史走势：读 magpie 的 ~/.config/magpie/quota-history.json。
//
// 形状（实测）：{ "<provider>|<user>": { "<窗口名>": [{at, left}, …] } }
// left 是该窗口当时的「剩余」（百分比或绝对量，随窗口而定），所以走势就是
// 剩余量随时间的曲线——掉得越快，烧得越快。
//
// 只做两件事：按账号+窗口取窗口内的序列（降采样到 ≤ maxPoints），以及算
// 「最近 N 小时掉了多少」——那是用户真正想知道的。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOUR = 3_600_000;
const CACHE_MS = 30_000;
let cache = null;

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function cfgDirs() {
  const home = homeDir();
  const out = [];
  if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, "magpie"));
  out.push(join(home, ".config", "magpie"));
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, "magpie"));
  return out;
}

export function quotaHistoryPath() {
  if (process.env.MAGPIE_QUOTA_HISTORY) return process.env.MAGPIE_QUOTA_HISTORY;
  for (const d of cfgDirs()) {
    const p = join(d, "quota-history.json");
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 各账号各窗口的剩余量走势。
 * @param {number} sinceMs 起点（毫秒）
 * @param {number} maxPoints 每条曲线最多点数
 * @returns {{series: Array, path: string|null}}
 *   series: [{ account: "<provider>|<user>", provider, user, window, points: [{at,left}], dropped, dropPerHour }]
 */
export function quotaHistory(sinceMs, maxPoints = 60) {
  const path = quotaHistoryPath();
  if (!path) return { series: [], path: null };
  let st;
  try { st = statSync(path); } catch { return { series: [], path: null }; }
  const key = path + ":" + st.size + ":" + Math.round(st.mtimeMs) + ":" + sinceMs + ":" + maxPoints;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { raw = {}; }
  const series = [];
  for (const [account, windows] of Object.entries(raw)) {
    if (!windows || typeof windows !== "object") continue;
    const [provider, ...rest] = account.split("|");
    const user = rest.join("|");
    for (const [windowName, rows] of Object.entries(windows)) {
      const pts = (Array.isArray(rows) ? rows : [])
        .map((r) => ({ at: Date.parse(r?.at ?? ""), left: typeof r?.left === "number" ? r.left : null }))
        .filter((r) => Number.isFinite(r.at) && r.left != null && r.at >= sinceMs)
        .sort((a, b) => a.at - b.at);
      if (pts.length < 2) continue;
      const step = Math.max(1, Math.ceil(pts.length / maxPoints));
      const sampled = step > 1 ? pts.filter((_, i) => i % step === 0 || i === pts.length - 1) : pts;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const spanH = (last.at - first.at) / HOUR;
      const dropped = first.left - last.left;
      series.push({
        account,
        provider,
        user,
        window: windowName,
        points: sampled,
        dropped: Math.round(dropped * 10) / 10,
        dropPerHour: spanH > 0.05 ? Math.round((dropped / spanH) * 100) / 100 : null,
      });
    }
  }
  series.sort((a, b) => (b.dropPerHour ?? -1e9) - (a.dropPerHour ?? -1e9));
  const value = { series, path };
  cache = { at: Date.now(), key, value };
  return value;
}
