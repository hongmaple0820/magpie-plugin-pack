import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hud-settings-"));
process.env.MAGPIE_AGENTS_HOME = home;

const { readSettings, writeSettings, sanitize, DEFAULTS, settingsPath, POSITIONS } = await import("../lib/settings.mjs");

test("defaults when nothing is saved", () => {
  const s = readSettings();
  assert.equal(s.position, "top-center");
  assert.equal(s.autoShape, true, "默认跟随吸附边决定形状");
  assert.equal(s.width, 560, "顶部形状的参考宽度");
  assert.equal(s.height, 160, "顶部形状的参考高度（比初版矮 20%）");
  assert.equal(s.theme, "auto", "主题默认跟随 magpie");
  assert.equal(s.showAllProviders, false, "额度区默认只显示在用的 provider");
  assert.equal(s.notch, false);
  assert.equal(s.opacity, DEFAULTS.opacity);
  assert.deepEqual(s.sections, DEFAULTS.sections);
});

test("sanitize clamps and rejects bad values", () => {
  const s = sanitize({ position: "nope", width: 5, height: 99999, opacity: 3, x: "abc", sections: { quotas: false } });
  assert.equal(s.position, "top-center", "未知位置回默认");
  assert.equal(s.width, 240, "宽度夹到下限");
  assert.equal(s.height, 900, "高度夹到上限");
  assert.equal(s.opacity, 1, "透明度夹到 1");
  assert.equal(s.x, DEFAULTS.x, "非数字回默认");
  assert.equal(s.sections.quotas, false, "显式 false 保留");
  assert.equal(s.sections.tokens, true, "未提的沿用默认");
});

test("writeSettings merges and persists", () => {
  const a = writeSettings({ position: "left", opacity: 0.5 });
  assert.equal(a.position, "left");
  assert.equal(a.opacity, 0.5);
  assert.equal(a.width, DEFAULTS.width, "没传的字段保持默认");
  const b = writeSettings({ notch: true });
  assert.equal(b.position, "left", "上一次的写入还在");
  assert.equal(b.notch, true);
  const again = readSettings();
  assert.equal(again.position, "left");
  assert.equal(again.notch, true);
  assert.equal(settingsPath(), join(home, ".magpie-agents", "hud-settings.json"));
});

test("a corrupt file falls back to defaults instead of throwing", () => {
  writeFileSync(settingsPath(), "{not json");
  const s = readSettings();
  assert.equal(s.position, "top-center");
});

test("screen id is kept and bounded", () => {
  const s = sanitize({ screen: "DISPLAY2" });
  assert.equal(s.screen, "DISPLAY2");
  assert.equal(sanitize({ screen: 42 }).screen, "", "非字符串回空（主屏）");
  assert.equal(sanitize({ screen: "x".repeat(500) }).screen.length, 128, "超长截断");
});

test("agents filter keeps known-shaped ids only", () => {
  assert.deepEqual(sanitize({ agents: ["dsh", "claude", "dsh"] }).agents, ["dsh", "claude"], "去重");
  assert.deepEqual(sanitize({ agents: ["bad id!", "", 42] }).agents, [], "非法值被丢弃");
  assert.deepEqual(sanitize({ agents: "dsh" }).agents, [], "非数组回空（= 全部）");
  assert.ok(sanitize({ agents: Array.from({ length: 40 }, (_, i) => "a" + i) }).agents.length <= 24, "限长 24");
});

test("hudAgents keeps a clean, deduped, bounded order", () => {
  assert.deepEqual(sanitize({ hudAgents: ["codex", "dsh", "codex"] }).hudAgents, ["codex", "dsh"], "去重保序");
  assert.deepEqual(sanitize({ hudAgents: ["bad id!", "", 7] }).hudAgents, [], "非法值丢弃");
  assert.deepEqual(sanitize({ hudAgents: "codex" }).hudAgents, [], "非数组回空");
  assert.ok(sanitize({ hudAgents: Array.from({ length: 40 }, (_, i) => "a" + i) }).hudAgents.length <= 24, "限长 24");
});

test("every documented position is accepted", () => {
  for (const p of POSITIONS) {
    const s = sanitize({ position: p });
    assert.equal(s.position, p, p + " 应被接受");
  }
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
