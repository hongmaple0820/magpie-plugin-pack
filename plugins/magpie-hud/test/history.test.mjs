import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaHistory, burnRate, SAMPLE_MS } from "../lib/usage/history.mjs";

// 每个测试自己的临时 HOME：QuotaHistory 构造即读磁盘，共享目录会互相污染。
const homes = [];
const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), "hud-history-"));
  homes.push(home);
  process.env.MAGPIE_AGENTS_HOME = home;
  return home;
};
process.on("exit", () => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

test("record writes to disk, same bucket overwrites instead of doubling", () => {
  const home = freshHome();
  const h = new QuotaHistory();
  const quotas = { clients: [{ client: "claude", status: "ok", quotas: [{ id: "claude-session", usedPercent: 10, resetAt: "2026-01-01T00:00:00.000Z", windowDurationSeconds: 18000 }] }] };
  // 同桶覆盖：取当前桶起点 +1s 与 +59s——都在同一个 10 分钟桶内，
  // 不会像「相隔 60 秒」那样有 1/10 概率跨桶（那会让这条测试偶发失败）。
  const t = Math.floor(Date.now() / SAMPLE_MS) * SAMPLE_MS + 1_000;
  assert.equal(h.record(quotas, t), true);
  assert.equal(h.record({ clients: [{ client: "claude", status: "ok", quotas: [{ id: "claude-session", usedPercent: 12 }] }] }, t + 58_000), true);
  assert.equal(h.samples.length, 1);
  assert.equal(h.samples[0].clients[0].quotas[0].usedPercent, 12);
  assert.ok(existsSync(join(home, ".magpie-agents", "usage-history.json")));
  const again = new QuotaHistory();
  assert.equal(again.samples.length, 1);
});

test("record skips non-ok clients and non-finite percents", () => {
  freshHome();
  const h = new QuotaHistory();
  assert.equal(h.record({ clients: [{ client: "claude", status: "failed", notice: "x" }] }), false);
  assert.equal(h.record({ clients: [{ client: "claude", status: "ok", quotas: [{ id: "q", usedPercent: "abc" }] }] }), false);
  assert.equal(h.record({ clients: [] }), false);
});

test("window filters by since and downsamples to maxPoints", () => {
  freshHome();
  const h = new QuotaHistory();
  const base = Date.now() - 5 * 3_600_000;
  for (let i = 0; i < 30; i++) {
    h.record({ clients: [{ client: "claude", status: "ok", quotas: [{ id: "q", usedPercent: i }] }] }, base + i * 10 * 60_000);
  }
  const series = h.window(base - 15 * 60_000); // 桶起点比 base 早最多 10 分钟
  assert.equal(series.length, 1);
  assert.equal(series[0].points.length, 30);
  const capped = h.window(base - 15 * 60_000, Date.now(), 10);
  assert.ok(capped[0].points.length <= 10);
  const late = h.window(base + 100 * 60_000);
  assert.ok(late[0].points.every((p) => p.at >= base + 10 * 60_000));
});

test("burnRate: rising series gives slope, sparse/flat/falling give null", () => {
  const now = Date.now();
  const resetAt = new Date(now + 2 * 3_600_000).toISOString();
  const points = [];
  for (let i = 0; i < 6; i++) points.push({ at: now - (6 - i) * 3_600_000, v: 3 + i * 6.5 });
  const burn = burnRate({ resetAt, windowDurationSeconds: 5 * 3600, points }, now);
  assert.ok(burn, "上升序列应有烧录率");
  assert.ok(Math.abs(burn.percentPerHour - 6.5) < 0.01, "斜率应约 6.5%/h，得到 " + burn.percentPerHour);
  assert.ok(burn.fullInMs > 0);
  assert.equal(burnRate({ resetAt, windowDurationSeconds: 5 * 3600, points: points.slice(0, 1) }, now), null);
  const tight = [{ at: now - 20 * 60_000, v: 10 }, { at: now - 5 * 60_000, v: 12 }];
  assert.equal(burnRate({ resetAt, windowDurationSeconds: 5 * 3600, points: tight }, now), null);
  const falling = points.map((p, i) => ({ at: p.at, v: 90 - i * 10 }));
  assert.equal(burnRate({ resetAt, windowDurationSeconds: 5 * 3600, points: falling }, now), null);
  assert.equal(burnRate({ resetAt: new Date(now - 1000).toISOString(), windowDurationSeconds: 5 * 3600, points }, now), null);
});

test("prune drops samples older than 7 days", () => {
  freshHome();
  const h = new QuotaHistory();
  const old = Date.now() - 8 * 86_400_000;
  h.record({ clients: [{ client: "claude", status: "ok", quotas: [{ id: "q", usedPercent: 1 }] }] }, old);
  h.record({ clients: [{ client: "claude", status: "ok", quotas: [{ id: "q", usedPercent: 2 }] }] }, Date.now());
  const fresh = new QuotaHistory();
  assert.equal(fresh.samples.length, 1);
  assert.ok(fresh.samples[0].at > old);
});
