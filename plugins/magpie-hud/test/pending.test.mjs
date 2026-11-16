import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hud-pending-"));
process.env.MAGPIE_AGENTS_HOME = home;
process.env.XDG_CONFIG_HOME = "";
process.env.MAGPIE_HUD_SESSIONS_CACHE = join(home, "sessions-cache.json");
delete process.env.DSH_HOME; // 夹具必须落在临时 HOME 里，不能扫到真机转录

// 三个 DSH 会话：卡片上屏等人 / 人已回答 / 普通在跑。
// 等待的语义是「卡片 tool/result 已上屏、之后没有真人消息」，
// 而不是「有一个没结果的 tool/call」——后者只是工具还在跑。
const root = join(home, ".dsh", "sessions", "--proj--");
const mk = (id, lines) => {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const head = (id) => ({ type: "session", version: 4, id, cwd: "/p" });
// working 的时效判定（stale-working）要求事件时间在 now 的 10 分钟窗口内；
// 夹具事件的时间戳统一用「现在」，否则整组会话会被判 stale 而显示 idle。
const NOW = Date.now();
const call = (seq, id, name) => ({ type: "tool/call", seq, time: NOW + seq, data: { callId: id, name } });
const result = (seq, id, isError = false) => ({
  type: "tool/result",
  seq,
  time: NOW + seq,
  data: { message: { role: "tool", source: { kind: "tool", callId: id }, content: [], isError } },
});
const userNow = (seq, text) => ({ type: "user/message", seq, time: NOW + seq, data: { source: { kind: "user" }, content: [{ type: "text", text }] } });

mk("s-waiting", [head("s-waiting"), userNow(1, "help me with the panel"), call(2, "c1", "ask_user"), result(3, "c1")]);
mk("s-answered", [head("s-answered"), userNow(1, "help me with the ledger"), call(2, "c2", "ask_user"), result(3, "c2"), userNow(4, "yes, do it")]);
mk("s-plain", [head("s-plain"), userNow(1, "just work")]);

const { listSessions } = await import("../lib/sessions.mjs");

test("a question card on screen with no answer means waiting for the user", async () => {
  const out = await listSessions();
  const byId = new Map(out.sessions.map((s) => [s.id, s]));
  const w = byId.get("s-waiting");
  assert.equal(w?.pending?.kind, "question");
  assert.equal(w?.pending?.toolName, "ask_user");
  assert.equal(w?.pending?.since, NOW + 2, "等待起点是卡片上屏那一刻");
  assert.equal(w?.state, "running");
  assert.equal(byId.get("s-answered")?.pending, null, "人已回答就不再等待");
  assert.equal(byId.get("s-plain")?.pending, null, "没有提问就没有等待");
  assert.equal(byId.get("s-plain")?.state, "running", "用户刚说完话、还没 turn/start，也是在跑");
});

test("every row carries evidence for what it claims", async () => {
  const out = await listSessions();
  for (const s of out.sessions.filter((x) => x.client === "dsh")) {
    assert.ok(s.evidence, `${s.id} 没有证据`);
    assert.equal(s.evidence.mode, "events");
    assert.equal(typeof s.evidence.bytes.size, "number");
    assert.ok(s.truth?.rule, `${s.id} 没有规则名`);
  }
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
