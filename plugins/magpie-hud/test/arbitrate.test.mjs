// 额度仲裁（v7 §4.2）：四条规则各钉一条测试，用的是真实来源形状——
// cli 的 clients[]（lib/usage/claude.mjs 的输出）与台账的 providers[]（provider-quotas.mjs 的输出）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { arbitrateQuotas, arbitrateWindows, cliCandidates, ledgerCandidates, sourceReport, windowKey } from "../lib/usage/arbitrate.mjs";

const cliClient = (rows) => [{ client: "claude", status: "ok", quotas: rows }];
const ledgerProvider = (readAt, windows) => [{ id: "claude/u1", provider: "claude", readAt, windows }];

test("同窗口多源：取 observedAt 最大的一条，另一条进 cross", () => {
  const at = Date.UTC(2026, 10, 16, 6, 0, 0);
  const out = arbitrateQuotas({
    at,
    clients: cliClient([{ id: "claude-session", name: "Current session", shortLabel: "5h", usedPercent: 61 }]),
    providers: ledgerProvider("2026-11-16T05:00:00Z", [{ name: "Current session", percent: 62, amount: 62, limit: 100 }]),
  });
  assert.equal(out.windows.length, 1, "同一个 5h 窗口不该出现两行");
  const w = out.windows[0];
  assert.equal(w.source, "cli", "cli 的读数更近");
  assert.equal(w.percent, 61);
  assert.equal(w.quality, "exact");
  assert.deepEqual(w.cross.map((c) => c.source), ["magpie"]);
  assert.equal(w.crossMismatch, true, "62 与 61 差 1 个点，要标出来");
});

test("同一时刻的两条：本地直连优先于聚合台账", () => {
  const at = Date.UTC(2026, 10, 16, 6, 0, 0);
  const cli = cliCandidates(cliClient([{ name: "Weekly limit", usedPercent: 20 }]), at);
  const ledger = ledgerCandidates(ledgerProvider(new Date(at).toISOString(), [{ name: "Weekly limit", percent: 80, amount: 80, limit: 100 }]));
  const out = arbitrateWindows([...ledger.candidates, ...cli.candidates]);
  assert.equal(out.windows[0].source, "cli");
  assert.equal(out.windows[0].percent, 20);
  // 台账给的是 amount/limit 算出来的比例：来源标 derived 以便界面区分
  assert.equal(out.windows[0].cross[0].percent, 80);
});

test("全部来源都缺百分比：quality unknown，percent 是 null 不是 0", () => {
  const at = Date.UTC(2026, 10, 16, 6, 0, 0);
  const out = arbitrateQuotas({
    at,
    clients: cliClient([{ name: "Current session" }]),
    providers: ledgerProvider("2026-11-16T05:00:00Z", [{ name: "Current session", display: "剩余 3 次" }]),
  });
  const w = out.windows[0];
  assert.equal(w.percent, null);
  assert.equal(w.quality, "unknown");
});

test("来源结构不符：只降级那个源，不拖累另一个", () => {
  const at = Date.UTC(2026, 10, 16, 6, 0, 0);
  const broken = ledgerCandidates({ nope: true });
  assert.equal(broken.drift, "providers-not-array");
  assert.deepEqual(broken.candidates, []);

  const cliBroken = cliCandidates([{ client: "claude", quotas: "40%" }], at);
  assert.equal(cliBroken.drift, "quotas-not-array");

  const ledger = ledgerCandidates(ledgerProvider("2026-11-16T05:00:00Z", [{ name: "Weekly limit", percent: 40, amount: 40, limit: 100 }]));
  const out = arbitrateWindows([...cliBroken.candidates, ...ledger.candidates]);
  assert.equal(out.windows.length, 1, "台账那一条照常给出");
  assert.equal(out.windows[0].source, "magpie");
  assert.equal(out.windows[0].quality, "derived");

  const report = sourceReport({ cli: cliBroken, magpie: ledger });
  assert.equal(report.find((s) => s.source === "cli").drift, "quotas-not-array");
  assert.equal(report.find((s) => s.source === "magpie").drift, null);
});

test("窗口身份归一：认得的合并，认不得的各自独立", () => {
  assert.equal(windowKey("Current session"), "5h");
  assert.equal(windowKey("5h"), "5h");
  assert.equal(windowKey("Weekly limit · All models"), "7d");
  assert.equal(windowKey("7d"), "7d");
  assert.equal(windowKey("Weekly limit · Opus"), "7d:opus");
  assert.equal(windowKey("Tokens 包"), "label:tokens 包");
  // 认不出来的两个不同窗口不能被合并成一行
  const at = Date.now();
  const out = arbitrateQuotas({ at, clients: cliClient([
    { name: "Tokens 包", usedPercent: 10 },
    { name: "Renews", usedPercent: 20 },
  ]), providers: [] });
  assert.equal(out.windows.length, 2);
});

test("同一家两个账号的同一窗口是两个窗口，不是一个", () => {
  const at = Date.UTC(2026, 10, 16, 6, 0, 0);
  const out = arbitrateQuotas({
    at,
    clients: [],
    providers: [
      { id: "claude/u1", provider: "claude", user: "a@x", readAt: "2026-11-16T05:59:00Z", windows: [{ name: "Current session", percent: 10, amount: 1, limit: 10 }] },
      { id: "claude/u2", provider: "claude", user: "b@x", readAt: "2026-11-16T05:59:00Z", windows: [{ name: "Current session", percent: 90, amount: 9, limit: 10 }] },
    ],
  });
  assert.equal(out.windows.length, 2, "两个账号各有自己的 5h 窗");
  assert.deepEqual(out.windows.map((w) => w.account).sort(), ["a@x", "b@x"]);
  assert.equal(out.conflicts, 0, "这不是冲突，是两条独立的窗口");
});

test("一边没有账号名：向唯一具名账号靠拢，不出重复行", () => {
  const at = Date.UTC(2026, 10, 16, 6, 0, 0);
  const out = arbitrateQuotas({
    at,
    // CLI 的行不带账号（readClaudeQuota 的 account 只在 status ok 时给，这里模拟缺失）
    clients: [{ client: "claude", status: "ok", quotas: [{ name: "Current session", usedPercent: 61 }] }],
    providers: [
      { id: "claude/u1", provider: "claude", user: "a@x", readAt: "2026-11-16T05:00:00Z", windows: [{ name: "Current session", percent: 62, amount: 62, limit: 100 }] },
    ],
  });
  assert.equal(out.windows.length, 1, "同一个窗口不该因为一边缺账号名就出两行");
  assert.equal(out.windows[0].account, "a@x");
  assert.equal(out.windows[0].source, "cli", "CI 的读数更近");
  assert.equal(out.windows[0].cross.length, 1);
});
