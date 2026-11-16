import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hud-pq-"));
const cfg = join(home, ".config", "magpie");
mkdirSync(cfg, { recursive: true });
process.env.MAGPIE_AGENTS_HOME = home;
process.env.XDG_CONFIG_HOME = "";

writeFileSync(join(cfg, "quotas.json"), JSON.stringify({
  "acme/u1": { at: "2026-11-12T02:00:00Z", quota: { provider: "acme", name: "Acme", plan: "Pro", user: "u1",
    readAt: "2026-11-12T02:00:00Z",
    windows: [
      { name: "5h", amount: 42, limit: 100, unit: "%" },
      { name: "积分", used: 0, balance: 600 },
    ] } },
  "beta/u2": { quota: { provider: "beta", name: "Beta", user: "u2",
    windows: [{ name: "Tokens", used: 0, display: "1 / 24,200 积分", amount: 1, limit: 24200, runsOut: "3h", runsOutAt: "2026-11-12T08:00:00Z" }] } },
}));

const { providerQuotas, quotasPath, resetProviderQuotaCache } = await import("../lib/usage/provider-quotas.mjs");

test("quotasPath finds the config folder's quotas.json", () => {
  assert.equal(quotasPath(), join(cfg, "quotas.json"));
});

test("providerQuotas normalizes percent, balance and passthrough fields", () => {
  resetProviderQuotaCache();
  const q = providerQuotas();
  assert.equal(q.totals.providers, 2);
  assert.equal(q.totals.accounts, 2);
  assert.equal(q.totals.windows, 3);

  const acme = q.providers.find((p) => p.provider === "acme");
  assert.equal(acme.plan, "Pro");
  const five = acme.windows.find((w) => w.name === "5h");
  assert.equal(five.percent, 42, "amount/limit 应算成百分比");
  const points = acme.windows.find((w) => w.name === "积分");
  assert.equal(points.percent, null, "纯余额不算百分比（不猜）");
  assert.equal(points.left, 600);

  const beta = q.providers.find((p) => p.provider === "beta");
  const tok = beta.windows[0];
  assert.ok(tok.percent != null && tok.percent < 0.1, "1/24200 应约 0%");
  assert.equal(tok.runsOut, "3h", "magpie 算好的耗尽时间原样透传");
  assert.equal(tok.display, "1 / 24,200 积分");
});

test("missing quotas.json is empty, not a crash", () => {
  const other = mkdtempSync(join(tmpdir(), "hud-pq-none-"));
  const was = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = other;
  process.env.MAGPIE_QUOTAS_JSON = join(other, "nope.json");
  resetProviderQuotaCache();
  try {
    const q = providerQuotas();
    assert.deepEqual(q.providers, []);
    assert.equal(q.totals.accounts, 0);
  } finally {
    delete process.env.MAGPIE_QUOTAS_JSON;
    process.env.MAGPIE_AGENTS_HOME = was;
    rmSync(other, { recursive: true, force: true });
  }
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
