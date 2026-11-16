import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 空 HOME：listSessions 扫不到任何东西，唯一能让 sessionDetail 找到会话的途径
// 就是调用方传进来的 hint——这也正是它存在的理由（别在点击路径上全量扫描）。
const home = mkdtempSync(join(tmpdir(), "hud-detail-hint-"));
process.env.MAGPIE_AGENTS_HOME = home;
process.env.XDG_CONFIG_HOME = "";

const { sessionDetail } = await import("../lib/session-detail.mjs");

test("a session hint avoids the full scan", async () => {
  const hint = { id: "hinted-1", client: "dsh", title: "来自缓存的会话", project: "/x", state: "idle", reachable: false, file: null };
  const d = await sessionDetail("hinted-1", 24, hint);
  assert.ok(d, "有 hint 时应直接命中，不必扫描");
  assert.equal(d.session.title, "来自缓存的会话");
  assert.deepEqual(d.messages, []);
  assert.equal(d.tokens, null, "没有文件就没有 token，不编造");
});

test("without a hint and without transcripts it is null", async () => {
  assert.equal(await sessionDetail("nothing-here", 24), null);
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
