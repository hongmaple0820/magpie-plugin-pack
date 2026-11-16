// 价格快照（v7 §4.3）：核心是「换价后旧会话成本不变」。
// 所有用例都在临时目录里跑——真机 ~/.cache/magpie/pricing.json 不许被测试写。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// pricing.mjs 按 env 定路径，所以每条用例先指到一个新的临时目录再 import。
async function freshPricing() {
  const dir = mkdtempSync(join(tmpdir(), "magpie-pricing-"));
  process.env.MAGPIE_PRICING_JSON = join(dir, "pricing.json");
  process.env.MAGPIE_MODELS_JSON = join(dir, "models.json");
  delete process.env.MAGPIE_AGENTS_HOME;
  const mod = await import("../lib/usage/pricing.mjs");
  mod.resetPricingCache();
  return { dir, mod };
}

const rates = (input, output, cacheRead = input / 10) => ({ input, output, cacheRead });

test("换价后旧会话成本不变，新时刻按新价", async () => {
  const { mod } = await freshPricing();
  const oct = "2026-10-01T00:00:00.000Z";
  const nov = "2026-11-01T00:00:00.000Z";
  assert.equal(mod.appendSnapshot({ effectiveFrom: oct, models: { "anthropic/claude-sonnet-4-5": rates(3, 15, 0.3) }, source: "test" }).ok, true);

  const row = { served: "claude-sonnet-4-5", in: 1_000_000, out: 0, cacheRead: 0 };
  const before = mod.costOf(row, Date.parse("2026-10-02T12:00:00Z"));
  assert.equal(before.usd, 3);
  assert.equal(before.quality, "backfilled");
  assert.equal(before.snapshotEffectiveFrom, oct);

  // 十一月翻倍
  assert.equal(mod.appendSnapshot({ effectiveFrom: nov, models: { "anthropic/claude-sonnet-4-5": rates(6, 30, 0.6) }, source: "test" }).ok, true);

  const after = mod.costOf(row, Date.parse("2026-10-02T12:00:00Z"));
  assert.equal(after.usd, 3, "十月的请求仍在十月那一档上算");
  assert.equal(after.snapshotEffectiveFrom, oct, "追加新档不改旧账");

  const later = mod.costOf(row, Date.parse("2026-11-02T12:00:00Z"));
  assert.equal(later.usd, 6);
  assert.equal(later.snapshotEffectiveFrom, nov);
});

test("同一生效时刻不能覆盖；也不能往更早的时刻追加", async () => {
  const { mod } = await freshPricing();
  mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { m: rates(1, 2) } });
  const dup = mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { m: rates(9, 9) } });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "duplicate-effectiveFrom");
  const older = mod.appendSnapshot({ effectiveFrom: "2026-09-01T00:00:00.000Z", models: { m: rates(9, 9) } });
  assert.equal(older.ok, false);
  assert.equal(older.reason, "not-newer");
  assert.equal(mod.snapshots().length, 1);
  assert.equal(mod.priceAt("m", Date.parse("2026-10-02T00:00:00Z")).rates.input, 1);
});

test("事件早于所有快照：标 approximate，不是当成精确值", async () => {
  const { mod } = await freshPricing();
  mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { m: rates(2, 4) } });
  const out = mod.costOf({ served: "m", in: 1_000_000 }, Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(out.usd, 2);
  assert.equal(out.quality, "approximate");
});

test("没有快照 / 模型没价：usd 是 null，不是 0", async () => {
  const { mod } = await freshPricing();
  const none = mod.costOf({ served: "m", in: 1000 }, Date.now());
  assert.equal(none.usd, null);
  assert.equal(none.quality, "unknown");

  mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { known: rates(1, 2) } });
  const miss = mod.costOf({ served: "另一个模型", in: 1000 }, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(miss.usd, null);
  assert.equal(miss.quality, "unknown");
});

test("上游自带金额：exact，不自己重算", async () => {
  const { mod } = await freshPricing();
  mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { m: rates(3, 15) } });
  const out = mod.costOf({ served: "m", in: 1_000_000, amount: 0.42 }, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(out.usd, 0.42);
  assert.equal(out.quality, "exact");
  assert.equal(out.snapshotEffectiveFrom, null);
});

test("缓存读按 cacheRead 价，没有就回落 input 价", async () => {
  const { mod } = await freshPricing();
  mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { m: { input: 10, output: 20 } } });
  const out = mod.costOf({ served: "m", in: 0, out: 0, cacheRead: 1_000_000 }, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(out.usd, 10);
});

test("models.json 建第一档：生效时刻取缓存文件时间，不是现在", async () => {
  const { dir, mod } = await freshPricing();
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    anthropic: { models: { "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", cost: { input: 3, output: 15, cache_read: 0.3 } } } },
  }));
  const res = mod.bootstrapFromModels();
  assert.equal(res.ok, true);
  const snaps = mod.snapshots();
  assert.equal(snaps.length, 1);
  // 用文件 mtime：这些价格只能证明「从这个时刻起」，不能假装更早
  const mtime = Math.round(statSync(join(dir, "models.json")).mtimeMs / 1000) * 1000;
  assert.equal(snaps[0].at, mtime);
  const hit = mod.priceAt("claude-sonnet-4-5", mtime + 1000);
  assert.equal(hit.rates.input, 3);
  // 第二次调用不该再写一档
  assert.equal(mod.bootstrapFromModels().reason, "already-present");
  assert.equal(mod.snapshots().length, 1);
  assert.ok(readFileSync(join(dir, "pricing.json"), "utf8").includes("claude-sonnet-4-5"));
});

test("账本按事件时刻取价：同一份账簿，换价后重算结果不变", async () => {
  const { dir, mod } = await freshPricing();
  mod.appendSnapshot({ effectiveFrom: "2026-10-01T00:00:00.000Z", models: { "openai/gpt-x": rates(2, 8, 0.2) } });
  const ledger = join(dir, "usage.jsonl");
  writeFileSync(ledger, JSON.stringify({ t: "2026-10-05T00:00:00Z", agent: "magpie", provider: "openai", model: "gpt-x", in: 1_000_000, out: 0 }) + "\n");
  process.env.MAGPIE_USAGE_LEDGER = ledger;
  const { ledgerRows } = await import("../lib/usage/ledger.mjs");
  const first = ledgerRows(0);
  assert.equal(Math.round(first.rows[0].cost * 100) / 100, 2);
  assert.equal(first.rows[0].costQuality, "backfilled");

  // 十一月涨价一倍，再读同一份账簿
  mod.appendSnapshot({ effectiveFrom: "2026-11-01T00:00:00.000Z", models: { "openai/gpt-x": rates(4, 16, 0.4) } });
  const second = ledgerRows(0);
  assert.equal(second.rows[0].cost, first.rows[0].cost, "旧行成本不随新快照变");
  delete process.env.MAGPIE_USAGE_LEDGER;
  delete process.env.MAGPIE_PRICING_JSON;
  delete process.env.MAGPIE_MODELS_JSON;
});
