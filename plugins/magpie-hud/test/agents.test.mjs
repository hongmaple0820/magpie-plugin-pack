import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hud-agents-"));
process.env.MAGPIE_AGENTS_HOME = home;
process.env.XDG_CONFIG_HOME = "";

mkdirSync(join(home, ".claude", "projects"), { recursive: true });
writeFileSync(join(home, ".claude", "projects", "x.jsonl"), "{}");
mkdirSync(join(home, ".codex"), { recursive: true });

const { detectAgents, agentName, AGENTS } = await import("../lib/agents.mjs");

test("registry covers a broad set of agents", () => {
  assert.ok(Object.keys(AGENTS).length >= 25, "至少覆盖 25 个已知 agent，实际 " + Object.keys(AGENTS).length);
  assert.equal(agentName("dsh"), "DeepSeek Harness");
  assert.equal(agentName("nope"), "nope");
});

test("installed is decided by the data folder existing", () => {
  const by = new Map(detectAgents().map((a) => [a.id, a]));
  assert.equal(by.get("claude").installed, true);
  assert.equal(by.get("codex").installed, true);
  assert.equal(by.get("gemini").installed, false, "没目录就是没装");
  assert.equal(by.get("cursor").installed, false);
});

test("recent files mark an agent active, an empty folder does not", () => {
  const by = new Map(detectAgents().map((a) => [a.id, a]));
  assert.equal(by.get("claude").active, true);
  assert.equal(by.get("codex").active, false);
});

test("installed agents sort first", () => {
  const list = detectAgents();
  const firstUninstalled = list.findIndex((a) => !a.installed);
  if (firstUninstalled > 0) assert.ok(list.slice(0, firstUninstalled).every((a) => a.installed));
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
