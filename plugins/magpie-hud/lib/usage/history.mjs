// 额度时序：把 list_quotas 的读数按固定间隔落盘，面板画 24h 走势与烧录率。
// 读额度要 spawn claude -p / codex app-server（30s/25s 上限），采样不能密：
// 10 分钟一次。保留 7 天（照 journal 的 KEPT_MS），原子整文件写。
// 只记 status ok 的读数——failed/no_plan_limits 的值没有意义，记下来只会
// 污染斜率。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsRoot, atomicWriteJson } from "../delivery/claude.mjs";

const KEPT_MS = 7 * 86_400_000;
export const SAMPLE_MS = 10 * 60_000;

function historyPath() {
  return process.env.MAGPIE_AGENTS_HISTORY || join(agentsRoot(), "usage-history.json");
}

export class QuotaHistory {
  constructor() {
    this.path = historyPath();
    this.samples = [];
    try {
      if (existsSync(this.path)) {
        this.samples = JSON.parse(readFileSync(this.path, "utf8")).samples ?? [];
      }
    } catch {
      this.samples = []; // 读不动当空的：宁可图短也不炸
    }
    this.prune();
  }

  save() {
    atomicWriteJson(this.path, { samples: this.samples });
  }

  prune(now = Date.now()) {
    const before = this.samples.length;
    this.samples = this.samples.filter((s) => now - s.at < KEPT_MS);
    if (this.samples.length !== before) this.save();
  }

  // 记一次读数：quotas 是 list_quotas 的返回。同一采样桶（SAMPLE_MS）只留
  // 最新一条——采样器重跑不翻倍。
  record(quotas, now = Date.now()) {
    const bucket = Math.floor(now / SAMPLE_MS) * SAMPLE_MS;
    const rows = [];
    for (const c of Array.isArray(quotas?.clients) ? quotas.clients : []) {
      if (c?.status !== "ok" || !Array.isArray(c.quotas)) continue;
      const items = c.quotas
        .filter((q) => typeof q?.usedPercent === "number" && Number.isFinite(q.usedPercent))
        .map((q) => ({
          id: q.id,
          usedPercent: q.usedPercent,
          resetAt: q.resetAt ?? null,
          windowDurationSeconds: q.windowDurationSeconds ?? null,
        }));
      if (items.length) rows.push({ client: c.client, quotas: items });
    }
    if (!rows.length) return false;
    const slot = this.samples.find((s) => s.at === bucket);
    if (slot) slot.clients = rows;
    else this.samples.push({ at: bucket, clients: rows });
    this.samples.sort((a, b) => a.at - b.at);
    this.save();
    return true;
  }

  // 窗口查询：[since, now] 的每条 quota 曲线，每条 ≤ maxPoints 点（均匀
  // 步进抽样）。resetAt / windowDurationSeconds 取该曲线最新样本的——烧录
  // 率要它们定「当前窗口」。
  window(since, now = Date.now(), maxPoints = 120) {
    const raw = this.samples.filter((s) => s.at >= since && s.at <= now);
    const series = new Map();
    for (const s of raw) {
      for (const c of s.clients ?? []) {
        for (const q of c.quotas ?? []) {
          const key = c.client + "/" + q.id;
          if (!series.has(key)) series.set(key, { client: c.client, id: q.id, points: [], resetAt: null, windowDurationSeconds: null });
          const row = series.get(key);
          row.points.push({ at: s.at, v: q.usedPercent });
          row.resetAt = q.resetAt ?? row.resetAt;
          row.windowDurationSeconds = q.windowDurationSeconds ?? row.windowDurationSeconds;
        }
      }
    }
    const out = [];
    for (const row of series.values()) {
      const step = Math.max(1, Math.ceil(row.points.length / maxPoints));
      out.push({
        client: row.client,
        id: row.id,
        resetAt: row.resetAt,
        windowDurationSeconds: row.windowDurationSeconds,
        points: step > 1 ? row.points.filter((_, i) => i % step === 0) : row.points,
      });
    }
    return out;
  }
}

// 烧录率：当前窗口（resetAt 在未来）内样本的最小二乘斜率，%/h。
// 样本 <2、跨度 <30 分钟、窗口不在进行中、或斜率非正（重置后回落）都
// 返回 null——烧录率只描述「正在烧」。
export function burnRate(series, now = Date.now()) {
  const resetMs = series.resetAt ? Date.parse(series.resetAt) : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  const spanMs = (series.windowDurationSeconds ?? 0) * 1000;
  const startMs = spanMs > 0 ? resetMs - spanMs : -Infinity;
  const points = series.points.filter((p) => p.at >= startMs);
  if (points.length < 2) return null;
  const span = points[points.length - 1].at - points[0].at;
  if (span < 30 * 60_000) return null;
  const xs = points.map((p) => (p.at - points[0].at) / 3_600_000);
  const ys = points.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den; // %/h
  if (!(slope > 0)) return null;
  const last = ys[ys.length - 1];
  const fullInMs = last < 100 ? ((100 - last) / slope) * 3_600_000 : 0;
  return { percentPerHour: slope, fullInMs };
}
