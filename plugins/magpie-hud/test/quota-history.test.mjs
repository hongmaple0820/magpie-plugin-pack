import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hud-qh-"));
const cfg = join(home, ".config", "magpie");
mkdirSync(cfg, { recursive: true });
process.env.MAGPIE_AGENTS_HOME = home;
process.env.XDG_CONFIG_HOME = "";

const now = Date.now();
const h = (n) => new Date(now - n * 3_600_000).toISOString();
writeFileSync(join(cfg, "quota-history.json"), JSON.stringify({
  "acme/u1": {
    "5h": [
      { at: h(10), left: 80 },
      { at: h(6), left: 60 },
      { at: h(2), left: 40 },
      { at: h(0.1), left: 38 },
      { at: h(20), left: 99 }, // 窗口外
    ],
    "7d": [{ at: h(6), left: 90 }], // 只有一个点 → 不算曲线
  },
  "beta/u2": { Credits: [{ at: h(5), left: 100 }, { at: h(1), left: 50 }] },
}));

const { quotaHistory, quotaHistoryPath } = await import("../lib/usage/quota-history.mjs");

test("finds the history file", () => {
  assert.equal(quotaHistoryPath(), join(cfg, "quota-history.json"));
});

test("returns one series per window with at least two in-window points", () => {
  const out = quotaHistory(now - 12 * 3_600_000);
  const keys = out.series.map((s) => s.account + "\u0000" + s.window);
  assert.ok(keys.includes("acme/u1\u00005h"), "5h 有 4 个窗口内点");
  assert.ok(!keys.includes("acme/u1\u00007d"), "只有一个点的不成曲线");
  assert.ok(keys.includes("beta/u2\u0000Credits"));
});

test("computes drop and per-hour rate", () => {
  const out = quotaHistory(now - 12 * 3_600_000);
  const five = out.series.find((s) => s.account === "acme/u1" && s.window === "5h");
  // 12h 窗口把 20 小时前那个 99 排除在外：首点 80、末点 38 → 掉 42
  assert.equal(five.dropped, 42);
  assert.ok(five.dropPerHour > 0 && five.dropPerHour < 10, "速率应在合理区间，得到 " + five.dropPerHour);
  const beta = out.series.find((s) => s.account === "beta/u2");
  assert.equal(beta.dropped, 50);
});

test("sorts the fastest burners first", () => {
  const out = quotaHistory(now - 12 * 3_600_000);
  const rates = out.series.map((s) => s.dropPerHour ?? -1);
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i - 1] >= rates[i], "应按掉速降序");
});

test("missing file is empty, not a crash", () => {
  const other = mkdtempSync(join(tmpdir(), "hud-qh-none-"));
  const was = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = other;
  process.env.MAGPIE_QUOTA_HISTORY = join(other, "nope.json");
  try {
    const out = quotaHistory(0);
    assert.deepEqual(out.series, []);
  } finally {
    delete process.env.MAGPIE_QUOTA_HISTORY;
    process.env.MAGPIE_AGENTS_HOME = was;
    rmSync(other, { recursive: true, force: true });
  }
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
