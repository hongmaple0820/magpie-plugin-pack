// 通道读写 + DSH 安装器。这两块决定「用户点了按钮到底发生了什么」，
// 所以每一步都断言文件内容，而不是断言函数返回 true。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerAsk,
  beat,
  channelStatus,
  liveSessions,
  pendingAsks,
  promptResult,
  promptSession,
} from "../lib/channel.mjs";
import { blockFor, install, status, stripBlock, uninstall, START_MARK, END_MARK } from "../lib/dsh-plugin.mjs";

function tmp(prefix = "mh-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("没有插件心跳时，通道报未装、未在线", () => {
  const ch = tmp();
  try {
    const st = channelStatus(ch.dir);
    assert.equal(st.installed, false);
    assert.equal(st.online, false);
    assert.equal(st.asks, 0);
  } finally {
    ch.done();
  }
});

test("面板心跳让通道显示插件在线", () => {
  const ch = tmp();
  try {
    mkdirSync(join(ch.dir, "asks"), { recursive: true });
    writeFileSync(join(ch.dir, "plugin.json"), JSON.stringify({ at: Date.now(), host: "h", pid: 1 }));
    assert.equal(beat(ch.dir), true, "面板自己也要写心跳");
    const st = channelStatus(ch.dir);
    assert.equal(st.installed, true);
    assert.equal(st.online, true);
    assert.equal(st.plugin.host, "h");
  } finally {
    ch.done();
  }
});

test("长期没动静的会话不算活着，结束的也不算", () => {
  const ch = tmp();
  try {
    mkdirSync(join(ch.dir, "sessions"), { recursive: true });
    writeFileSync(join(ch.dir, "sessions", "a.json"), JSON.stringify({ id: "a", at: Date.now() }));
    writeFileSync(join(ch.dir, "sessions", "b.json"), JSON.stringify({ id: "b", at: Date.now() - 60_000 }));
    writeFileSync(join(ch.dir, "sessions", "c.json"), JSON.stringify({ id: "c", at: Date.now(), ended: Date.now() }));
    const rows = liveSessions(ch.dir);
    assert.deepEqual(rows.filter((r) => r.live).map((r) => r.id), ["a"]);
  } finally {
    ch.done();
  }
});

test("读卡：字段摊平给页面，超时的标 stale", () => {
  const ch = tmp();
  try {
    mkdirSync(join(ch.dir, "asks"), { recursive: true });
    writeFileSync(
      join(ch.dir, "asks", "ask_1.json"),
      JSON.stringify({ id: "ask_1", kind: "approval", sessionId: "s1", at: Date.now(), toolName: "bash", displayReason: { zh: "写文件" } }),
    );
    writeFileSync(join(ch.dir, "asks", "ask_2.json"), JSON.stringify({ id: "ask_2", kind: "question", sessionId: "s2", at: Date.now() - 3600_000, questions: [{ id: "q1", label: "?" }] }));
    writeFileSync(join(ch.dir, "asks", "ask_2.answer"), JSON.stringify({ value: "x" }));
    const rows = pendingAsks(ch.dir);
    assert.equal(rows.length, 2);
    // 等得最久的排最前：用户先看到最老的那张卡
    assert.equal(rows[0].id, "ask_2");
    assert.equal(rows[0].stale, true);
    assert.equal(rows[0].questions.length, 1);
    assert.equal(rows[1].id, "ask_1");
    assert.equal(rows[1].displayReason.zh, "写文件");
    assert.equal(rows[1].stale, false);
  } finally {
    ch.done();
  }
});

test("回答审批：写得进、写得对，插件侧读到的就是这个值", () => {
  const ch = tmp();
  try {
    mkdirSync(join(ch.dir, "asks"), { recursive: true });
    writeFileSync(join(ch.dir, "asks", "ask_9.json"), JSON.stringify({ id: "ask_9", kind: "approval", at: Date.now(), sessionId: "s" }));
    assert.deepEqual(answerAsk("ask_9", "maybe", ch.dir).ok, false, "只认两个值");
    assert.deepEqual(answerAsk("ask_404", "rejected", ch.dir).ok, false, "卡没了就别答");
    assert.equal(answerAsk("ask_9", "rejected", ch.dir).ok, true);
    const written = JSON.parse(readFileSync(join(ch.dir, "asks", "ask_9.answer"), "utf8"));
    assert.equal(written.value, "rejected");
    const log = readFileSync(join(ch.dir, "asks.log.jsonl"), "utf8").trim().split("\n").pop();
    assert.equal(JSON.parse(log).id, "ask_9");
  } finally {
    ch.done();
  }
});

test("回答问题：每题都要有答案，题号必须对得上", () => {
  const ch = tmp();
  try {
    mkdirSync(join(ch.dir, "asks"), { recursive: true });
    writeFileSync(
      join(ch.dir, "asks", "ask_q.json"),
      JSON.stringify({ id: "ask_q", kind: "question", at: Date.now(), questions: [{ id: "q1" }, { id: "q2" }] }),
    );
    assert.equal(answerAsk("ask_q", { answers: [{ id: "q1", selected: ["a"] }] }, ch.dir).ok, false);
    assert.equal(answerAsk("ask_q", { answers: [{ id: "q1", selected: ["a"] }, { id: "zz", selected: ["b"] }] }, ch.dir).ok, false);
    assert.equal(answerAsk("ask_q", { answers: [{ id: "q1", selected: ["a"] }, { id: "q2", selected: [1] }] }, ch.dir).ok, false);
    assert.equal(
      answerAsk("ask_q", { answers: [{ id: "q1", selected: ["a"] }, { id: "q2", selected: ["b"], custom: "补充" }] }, ch.dir).ok,
      true,
    );
    const written = JSON.parse(readFileSync(join(ch.dir, "asks", "ask_q.answer"), "utf8"));
    assert.equal(written.value.answers[1].custom, "补充");
  } finally {
    ch.done();
  }
});

test("下发一句话：写进 prompts/，能读回投递状态", () => {
  const ch = tmp();
  try {
    const bad = promptSession("../etc", "hi", {}, ch.dir);
    assert.equal(bad.ok, false);
    const empty = promptSession("s1", "   ", {}, ch.dir);
    assert.equal(empty.ok, false);
    const ok = promptSession("s1", "  帮我把测试跑一遍  ", {}, ch.dir);
    assert.equal(ok.ok, true);
    assert.equal(ok.text, "帮我把测试跑一遍", "首尾空白要剪掉");
    assert.equal(promptResult("s1", ok.id, ch.dir).state, "queued");

    const file = join(ch.dir, "prompts", "s1", ok.id + ".json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), takenAt: Date.now() }));
    assert.equal(promptResult("s1", ok.id, ch.dir).state, "sending");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state: "accepted", acceptedAt: Date.now() }));
    assert.equal(promptResult("s1", ok.id, ch.dir).state, "accepted", "入队不算送达");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state: "delivered", deliveredSeq: 7 }));
    assert.deepEqual(promptResult("s1", ok.id, ch.dir), { state: "delivered", seq: 7, at: null });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state: "failed", reason: "槽满了" }));
    assert.deepEqual(promptResult("s1", ok.id, ch.dir), { state: "failed", reason: "槽满了" });
  } finally {
    ch.done();
  }
});

test("托管段：只动自己那一段，别人写的内容原样保留", () => {
  const before = [
    "# dsh home patch layer",
    "",
    "# --- figma-mcp managed (auto-generated; do not edit) ---",
    "- insert:",
    "    - id: mcp-figma",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "# --- end figma-mcp managed ---",
    "",
  ].join("\n");
  const block = blockFor("C:\\Users\\x\\.dsh\\magpie-hud.mjs", "C:\\Users\\x\\.magpie-agents\\channel");
  assert.ok(block.includes(START_MARK) && block.includes(END_MARK));
  assert.ok(block.includes("name: 'C:/Users/x/.dsh/magpie-hud.mjs'"), "路径写成正斜杠的单引号串");
  const withBlock = before.replace(/\s*$/, "") + "\n\n" + block;
  const stripped = stripBlock(withBlock);
  assert.equal(stripped.found, true);
  assert.ok(!stripped.text.includes("magpie-hud"), "拆干净");
  assert.ok(stripped.text.includes("mcp-figma"), "别人的段要留着");
  // 幂等：装两次只有一段
  const twice = (stripped.text.replace(/\s*$/, "") + "\n\n" + block).replace(/\s*$/, "") + "\n\n" + block;
  assert.equal(stripBlock(twice).text.split(START_MARK).length - 1, 0);
});

test("残缺的托管段：报错而不是猜着改", () => {
  const broken = "- insert:\n" + START_MARK + "\n    - id: magpie-hud-plugin\n";
  const out = stripBlock(broken);
  assert.equal(out.truncated, true);
  assert.equal(out.text, broken, "原样退回");
});

test("安装 / 卸载：临时 DSH_HOME 里跑真的文件操作", () => {
  const home = tmp("dsh-");
  const ch = tmp("chan-");
  try {
    const env = { DSH_HOME: home.dir };
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(join(home.dir, "cordis.patch.yml"), "# dsh home patch layer\n");

    assert.equal(status(env).loaded, false);
    assert.equal(install("relative/path", env).ok, false, "通道必须是绝对路径");

    const ok = install(ch.dir, env);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.fileThere, true);
    assert.equal(ok.loaded, true);
    assert.equal(ok.upToDate, true);
    assert.equal(ok.needsRestart, true);

    const patch = readFileSync(join(home.dir, "cordis.patch.yml"), "utf8");
    assert.ok(patch.includes("id: magpie-hud-plugin"));
    assert.ok(patch.includes("# --- end magpie-hud managed ---"));
    assert.ok(patch.includes("channel: '" + ch.dir.replace(/\\/g, "/") + "'"), patch);
    assert.ok(existsSync(join(home.dir, "magpie-hud.mjs")), "插件本体要落盘");
    assert.ok(readFileSync(join(home.dir, "magpie-hud.mjs"), "utf8").includes("export const name = \"magpie-hud\""));

    // 再装一次不重复
    install(ch.dir, env);
    const second = readFileSync(join(home.dir, "cordis.patch.yml"), "utf8");
    assert.equal(second.split(START_MARK).length - 1, 1);

    const gone = uninstall(env);
    assert.equal(gone.ok, true);
    const after = readFileSync(join(home.dir, "cordis.patch.yml"), "utf8");
    assert.ok(!after.includes("magpie-hud"));
    assert.equal(existsSync(join(home.dir, "magpie-hud.mjs")), false);
    assert.equal(status(env).loaded, false);
  } finally {
    home.done();
    ch.done();
  }
});
