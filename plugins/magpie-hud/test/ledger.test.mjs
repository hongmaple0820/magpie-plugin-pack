import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 自制一个 magpie 配置目录：usage.jsonl + models.json
const home = mkdtempSync(join(tmpdir(), "hud-ledger-"));
const cfg = join(home, ".config", "magpie");
mkdirSync(cfg, { recursive: true });
mkdirSync(join(home, ".cache", "magpie"), { recursive: true });
process.env.MAGPIE_AGENTS_HOME = home;

const now = Date.now();
const row = (over) => JSON.stringify({ t: new Date(now - 60_000).toISOString(), agent: "dsh", provider: "acme", model: "glm-5.3", served: "glm-5.3", in: 1_000_000, out: 1_000_000, cache_read: 0, status: 200, ...over });
writeFileSync(join(cfg, "usage.jsonl"), [
  row({}),
  row({ served: "mystery-model", model: "mystery-model" }),   // 未定价
  row({ served: "acme-prefixed/glm-5.3" }),                    // 带前缀也要能对上
  JSON.stringify({ t: new Date(now - 40 * 86_400_000).toISOString(), agent: "dsh", served: "glm-5.3", in: 1, out: 1 }), // 窗口外
].join("\n") + "\n");

writeFileSync(join(home, ".cache", "magpie", "models.json"), JSON.stringify({
  acme: { models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3", cost: { input: 2, output: 8 } } } },
}));

const { ledgerRows, ledgerPath } = await import("../lib/usage/ledger.mjs");
const { tokenUsage, resetTokenCache } = await import("../lib/usage/tokens.mjs");

test("ledgerPath finds the config folder's usage.jsonl", () => {
  assert.equal(ledgerPath(), join(cfg, "usage.jsonl"));
});

test("ledgerRows prices what it can and reports what it cannot", () => {
  const out = ledgerRows(Date.now() - 86_400_000);
  assert.equal(out.rows.length, 3, "窗口外的行不算");
  assert.equal(out.priced, 2, "两行能对上价格（含带前缀的写法）");
  assert.equal(out.unpriced, 1);
  assert.equal(out.unpricedModels[0][0], "mystery-model");
  const priced = out.rows.find((r) => r.cost != null);
  // 1M input × $2/M + 1M output × $8/M = $10
  assert.ok(Math.abs(priced.cost - 10) < 1e-6, "成本应为 $10，得到 " + priced.cost);
});

test("tokenUsage prefers the ledger and reports cost", () => {
  resetTokenCache();
  const u = tokenUsage("24h");
  assert.equal(u.source, "ledger");
  assert.equal(u.totals.events, 3);
  assert.equal(u.totals.in, 3_000_000);
  assert.ok(Math.abs(u.cost.usd - 20) < 1e-6, "两行各 $10，得到 " + u.cost.usd);
  assert.equal(u.cost.unpriced, 1);
  assert.ok(Array.isArray(u.byModel) && u.byModel.length >= 1);
  assert.equal(u.scanning, false, "账簿路径不需要后台扫描");
});

test("without a ledger it falls back to transcripts (and says so)", () => {
  const other = mkdtempSync(join(tmpdir(), "hud-ledger-none-"));
  const was = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = other;
  process.env.MAGPIE_USAGE_LEDGER = join(other, "nope.jsonl");
  resetTokenCache();
  try {
    const u = tokenUsage("24h");
    assert.equal(u.source, "transcripts");
    assert.equal(u.cost, null, "转录算不了钱，不编造");
  } finally {
    delete process.env.MAGPIE_USAGE_LEDGER;
    process.env.MAGPIE_AGENTS_HOME = was;
    rmSync(other, { recursive: true, force: true });
  }
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
