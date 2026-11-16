// 鹊桥 M-U2 验收：list_quotas 经假引擎走真实协议——Claude 的
// control_request/get_usage 与 Codex 的 app-server JSON-RPC；外加缺引擎时的
// 降级报告。命令经 MAGPIE_AGENTS_*_CMD 覆盖（空格分词），HOME 经
// MAGPIE_AGENTS_HOME 覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { listQuotas } = await import(pathToFileURL(join(here, "..", "lib", "usage", "index.mjs")).href);

const MISSING = "definitely-not-a-command-xyz";

test("list_quotas reads Claude windows through the engine protocol", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-agents-quota-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    oauthAccount: { accountUuid: "u1", organizationUuid: "o1", emailAddress: "dev@example.com", organizationType: "claude_pro" },
  }));
  process.env.MAGPIE_AGENTS_HOME = home;
  process.env.MAGPIE_AGENTS_CLAUDE_CMD = "node " + join(here, "fixtures", "fake-claude.mjs");
  process.env.MAGPIE_AGENTS_CODEX_CMD = MISSING;
  try {
    const out = await listQuotas({ client: "claude" });
    const claude = out.clients[0];
    assert.equal(claude.status, "ok");
    assert.equal(claude.account.label, "dev@example.com");
    assert.equal(claude.account.plan, "pro");
    assert.deepEqual(claude.quotas.map((q) => q.id), ["claude-session", "claude-weekly", "claude-weekly-opus"]);
    const session = claude.quotas[0];
    assert.equal(session.usedPercent, 42.5);
    assert.equal(session.status, "normal");
    assert.equal(session.windowDurationSeconds, 18000);
    assert.equal(session.resetAt, "2026-11-11T12:00:00.000Z");
    assert.equal(claude.quotas[1].usedPercent, 61);
    assert.equal(claude.quotas[2].status, "warning");
  } finally {
    delete process.env.MAGPIE_AGENTS_HOME;
    delete process.env.MAGPIE_AGENTS_CLAUDE_CMD;
    delete process.env.MAGPIE_AGENTS_CODEX_CMD;
    rmSync(home, { recursive: true, force: true });
  }
});

test("list_quotas reads Codex windows through the app-server protocol", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-agents-quota-"));
  process.env.MAGPIE_AGENTS_HOME = home;
  process.env.MAGPIE_AGENTS_CODEX_CMD = "node " + join(here, "fixtures", "fake-codex.mjs");
  process.env.MAGPIE_AGENTS_CLAUDE_CMD = MISSING;
  try {
    const out = await listQuotas({ client: "codex" });
    const codex = out.clients[0];
    assert.equal(codex.status, "ok");
    assert.equal(codex.account.label, "dev@example.com");
    assert.equal(codex.account.plan, "pro");
    assert.equal(codex.quotas.length, 2);
    const primary = codex.quotas[0];
    assert.equal(primary.id, "codex:codex:primary");
    assert.equal(primary.usedPercent, 33.3);
    assert.equal(primary.status, "normal");
    assert.equal(primary.windowDurationSeconds, 18000);
    assert.ok(primary.resetAt.endsWith("Z"));
    assert.equal(codex.quotas[1].shortLabel, "7d");
    assert.equal(codex.resetCredits.availableCount, 2);
    assert.equal(codex.resetCredits.credits[0].id, "c0");
    assert.equal(codex.resetCredits.credits.length, 2);
  } finally {
    delete process.env.MAGPIE_AGENTS_HOME;
    delete process.env.MAGPIE_AGENTS_CLAUDE_CMD;
    delete process.env.MAGPIE_AGENTS_CODEX_CMD;
    rmSync(home, { recursive: true, force: true });
  }
});

test("list_quotas reports missing engines without failing", async () => {
  process.env.MAGPIE_AGENTS_CLAUDE_CMD = MISSING;
  process.env.MAGPIE_AGENTS_CODEX_CMD = MISSING;
  try {
    const out = await listQuotas();
    assert.equal(out.clients.length, 2);
    for (const client of out.clients) {
      assert.equal(client.status, "failed");
      assert.ok(typeof client.notice === "string" && client.notice.length > 0);
      assert.deepEqual(client.quotas, undefined);
    }
  } finally {
    delete process.env.MAGPIE_AGENTS_CLAUDE_CMD;
    delete process.env.MAGPIE_AGENTS_CODEX_CMD;
  }
});
