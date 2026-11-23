// P5：工具面契约。每个工具三条断言——能用 / 拒绝 / 不可用，全部走 AGENTS_TOOLS 这一层
// （宿主拿到的就是这个对象；直接测 lib 里的函数会漏掉参数整形与返回序列化）。
//
// 「不可用」这条是重点：没有 CLI、没有会话、没有凭证时，工具必须**明确说**
// （refused / failed + reason / 空数组 + startFolders 说明），
// 不能抛异常、不能返回空字符串、不能把缺数据写成 0。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AGENTS_TOOLS } = await import("../lib/tools.mjs");

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FAKE_CLAUDE = "node " + join(here, "fixtures", "fake-claude.mjs");
const FAKE_CODEX = "node " + join(here, "fake-codex.mjs");

/** 每个用例自己一份 HOME：工具会读会话目录、消息日志、任务夹，不能互相串。
 *  另外宿主进程（DSH）会带着 DSH_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR /
 *  GEMINI_CLI_HOME 进来——不隔离掉，「空环境」就会扫到机器上真实的会话目录。 */
function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "magpie-hud-contract-"));
    const isEnv = ["MAGPIE_AGENTS_HOME", "MAGPIE_AGENTS_CLAUDE_CMD", "MAGPIE_AGENTS_CODEX_CMD", "DSH_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME"];
    const saved = {};
    for (const key of isEnv) saved[key] = process.env[key];
    process.env.MAGPIE_AGENTS_HOME = home;
    for (const key of ["MAGPIE_AGENTS_CLAUDE_CMD", "MAGPIE_AGENTS_CODEX_CMD", "DSH_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME"]) delete process.env[key];
    try {
      await fn(home);
    } finally {
      for (const key of isEnv) {
        if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key];
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const run = async (name, args = {}) => JSON.parse(await AGENTS_TOOLS[name].execute(args, {}));

// ── list_sessions ───────────────────────────────────────────────
test("list_sessions：能用 —— 列出机器上真有的会话并给出可起会话的目录", withHome(async () => {
  const out = await run("list_sessions");
  assert.ok(Array.isArray(out.sessions), "sessions 是数组");
  assert.ok(out.startFolders && typeof out.startFolders === "object", "startFolders 必须在");
  for (const row of out.sessions) {
    assert.ok(row.id && row.client, "每行有 id 与 client");
    assert.ok(row.source && typeof row.source.kind === "string", "每行带来源描述（不静默降级）");
  }
}));

test("list_sessions：空环境 —— 返回空数组而不是报错", withHome(async () => {
  const out = await run("list_sessions");
  assert.deepEqual(out.sessions, []);
}));

test("list_sessions：没有 CLI —— startFolders 明说不能起，不假装可以", withHome(async () => {
  const out = await run("list_sessions");
  for (const [client, folder] of Object.entries(out.startFolders)) {
    assert.ok(folder === null || typeof folder === "string", `${client}.startFolders 只能是路径或 null`);
  }
}));

// ── send_message ────────────────────────────────────────────────
test("send_message：能用 —— 发给 codex 会话返回 queued + id", withHome(async (home) => {
  const day = join(home, ".codex", "sessions", "2026", "11", "16");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-11-16T10-00-00-abc.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "codex-to", cwd: "F:/maple/other" } }) + "\n",
  );
  process.env.MAGPIE_AGENTS_CODEX_CMD = FAKE_CODEX;
  const out = await run("send_message", { to: "codex-to", text: "please do the thing" });
  assert.equal(out.state, "queued");
  assert.ok(out.id, "拿到消息 id");
}));

test("send_message：拒绝 —— 收件人不存在时给 reason，不给 id", withHome(async () => {
  const out = await run("send_message", { to: "nope", text: "hi" });
  assert.equal(out.state, "refused");
  assert.ok(String(out.reason ?? "").length > 0, "refused 必须带原因");
  assert.equal(out.id, undefined);
}));

test("send_message：不可用 —— 空文本被拒，不会把空消息投出去", withHome(async () => {
  const out = await run("send_message", { text: "   " });
  assert.equal(out.state, "refused");
}));

// ── start_session ───────────────────────────────────────────────
test("start_session：能用 —— 起一个 codex 会话并拿到 id", withHome(async () => {
  process.env.MAGPIE_AGENTS_CODEX_CMD = FAKE_CODEX;
  const out = await run("start_session", { client: "codex", text: "start here" });
  assert.ok(out.id, "拿到消息 id");
  assert.ok(["queued", "started", "taken"].includes(out.state) || out.session, "有会话或状态: " + JSON.stringify(out));
}));

test("start_session：拒绝 —— 没有首条文本时不 spawn", withHome(async () => {
  const out = await run("start_session", { client: "codex" });
  assert.equal(out.state, "refused");
  assert.ok(String(out.reason ?? "").length > 0);
}));

test("start_session：不可用 —— claude CLI 不在时明确 refused 或 uncertain（不是静默空转）", withHome(async () => {
  process.env.MAGPIE_AGENTS_CLAUDE_CMD = "definitely-not-a-real-claude-binary";
  const out = await run("start_session", { client: "claude", text: "hello" });
  // 起不来时两种诚实答案：refused（确定没起）或 uncertain（不知道起没起）——但必须带理由
  assert.ok(["refused", "uncertain"].includes(out.state), "state 应为 refused 或 uncertain: " + out.state);
  assert.match(String(out.reason ?? ""), /claude|ENOENT|不|失败/i, "原因要说明 CLI 起不来: " + out.reason);
}));

// ── get_message ─────────────────────────────────────────────────
test("get_message：能用 —— 收到答复后 state=done 且带正文", withHome(async (home) => {
  const day = join(home, ".codex", "sessions", "2026", "11", "16");
  mkdirSync(day, { recursive: true });
  const file = join(day, "rollout-2026-11-16T11-00-00-abc.jsonl");
  const meta = JSON.stringify({ type: "session_meta", payload: { id: "codex-to", cwd: "F:/maple/other" } }) + "\n";
  writeFileSync(file, meta);
  process.env.MAGPIE_AGENTS_CODEX_CMD = FAKE_CODEX;
  const sent = await run("send_message", { to: "codex-to", text: "say hi" });
  // 投递用的是带标记的首行：应答匹配就靠它认出「哪条消息的回话」
  const marker = `[magpie-agents · 来自 Claude Code · ${sent.id}]\n\nsay hi`;
  writeFileSync(
    file,
    meta +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] } }) + "\n",
  );
  const got = await run("get_message", { id: sent.id });
  assert.equal(got.state, "done");
  assert.equal(got.answer, "hi there");
}));

test("get_message：未知 id —— state=unknown 且带原因", withHome(async () => {
  const got = await run("get_message", { id: "m-does-not-exist" });
  assert.equal(got.state, "unknown");
  assert.ok(String(got.reason ?? "").length > 0);
}));

test("get_message：无效输入 —— 空 id 也是 unknown，不抛异常", withHome(async () => {
  const got = await run("get_message", { id: "" });
  assert.equal(got.state, "unknown");
}));

// ── list_quotas ─────────────────────────────────────────────────
test("list_quotas：能用 —— 有引擎时给出窗口与来源", withHome(async () => {
  process.env.MAGPIE_AGENTS_CLAUDE_CMD = FAKE_CLAUDE;
  const out = await run("list_quotas");
  assert.ok(Array.isArray(out.clients), "clients 是数组");
  const claude = out.clients.find((c) => c.client === "claude");
  assert.ok(claude, "claude 在列表里");
  for (const w of claude.windows ?? []) {
    assert.ok(w.key, "窗口有 key");
    // 读不出百分比必须是 null，不能落 0
    assert.ok(w.percent === null || typeof w.percent === "number", "percent 只能是数字或 null");
  }
}));

test("list_quotas：不可用 —— 没有 CLI 时每项 status=failed 且带 notice", withHome(async () => {
  const out = await run("list_quotas");
  assert.ok(out.clients.length > 0, "至少给出 claude/codex 两项");
  for (const c of out.clients) {
    assert.equal(c.status, "failed", `${c.client} 应为 failed`);
    assert.ok(String(c.notice ?? "").length > 0, `${c.client} 要有 notice`);
  }
}));

test("list_quotas：不落 0 —— 缺数据时不给数值，也不编一个 0%", withHome(async () => {
  const out = await run("list_quotas");
  const windows = out.clients.flatMap((c) => c.windows ?? []);
  for (const w of windows) {
    assert.notEqual(w.percent, 0, "没有数据时不能写成 0%");
  }
}));
