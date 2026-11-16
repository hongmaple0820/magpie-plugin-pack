// DSH 侧通道插件：用假 ctx 跑真协议。它是本包唯一会被装进别人进程的
// 代码，所以每一条边界都必须在这里按住——崩了会把用户的 harness 带走。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../dsh/magpie-hud.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCtx() {
  const handlers = new Map();
  const prompts = [];
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(fn) {
      ctx.__dispose = fn();
    },
    get(name) {
      if (name !== "sessionController") return null;
      return {
        prompt(request) {
          prompts.push(request);
          return { accepted: true };
        },
      };
    },
  };
  return { ctx, handlers, prompts };
}

function channel() {
  const dir = mkdtempSync(join(tmpdir(), "magpie-hud-ch-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const rootAgent = (id) => ({ id });

test("审批：写卡、由鹊楼回答、卡被收走", async () => {
  const ch = channel();
  const { ctx, handlers } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 50 });
  try {
    let released = null;
    const next = () =>
      new Promise((resolve) => {
        released = resolve;
      });
    const pending = handlers.get("approval/request")(
      { agent: rootAgent("s1"), toolName: "bash", callId: "c1", reason: "rm -rf build", arguments: "{}", signal: new AbortController().signal },
      next,
    );
    const asks = readdirSync(join(ch.dir, "asks")).filter((f) => f.endsWith(".json"));
    assert.equal(asks.length, 1);
    const id = asks[0].replace(/\.json$/, "");
    const card = JSON.parse(readFileSync(join(ch.dir, "asks", id + ".json"), "utf8"));
    assert.equal(card.kind, "approval");
    assert.equal(card.toolName, "bash");
    assert.equal(card.sessionId, "s1");

    writeFileSync(join(ch.dir, "asks", id + ".answer"), JSON.stringify({ value: "allowed-once" }));
    assert.equal(await pending, "allowed-once");
    assert.equal(existsSync(join(ch.dir, "asks", id + ".json")), false, "答完卡要收走");
    released?.(undefined);
    assert.equal(plugin.stats().asks, 0);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("审批：DSH 自己的卡先答，就走 DSH 的答案", async () => {
  const ch = channel();
  const { ctx, handlers } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 50 });
  try {
    const value = await handlers.get("approval/request")(
      { agent: rootAgent("s2"), toolName: "bash", callId: "c2", displayReason: { zh: "要写文件" } },
      async () => "rejected",
    );
    assert.equal(value, "rejected");
    assert.equal(readdirSync(join(ch.dir, "asks")).filter((f) => f.endsWith(".json")).length, 0);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("提问：答案必须条数与 id 都对得上，不合格继续等", async () => {
  const ch = channel();
  const { ctx, handlers } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 50 });
  try {
    const done = handlers.get("user-questions/request")(
      {
        agent: rootAgent("s3"),
        questions: [{ id: "q1", label: "选哪个？", options: [{ value: "a", label: "A" }, "b"] }],
      },
      () => new Promise(() => {}),
    );
    const askFile = () => {
      const f = readdirSync(join(ch.dir, "asks")).find((x) => x.endsWith(".json"));
      return join(ch.dir, "asks", f);
    };
    const id = JSON.parse(readFileSync(askFile(), "utf8")).id;

    // 条数不对
    writeFileSync(join(ch.dir, "asks", id + ".answer"), JSON.stringify({ value: { answers: [] } }));
    await wait(60);
    assert.equal(existsSync(join(ch.dir, "asks", id + ".json")), true, "不合格的答案不能让卡消失");

    // id 对不上
    writeFileSync(join(ch.dir, "asks", id + ".answer"), JSON.stringify({ value: { answers: [{ id: "zzz", selected: [] }] } }));
    await wait(60);
    assert.equal(existsSync(join(ch.dir, "asks", id + ".json")), true);

    // 这一份合格：b 选项是纯字符串，页面按 value=label 记
    writeFileSync(
      join(ch.dir, "asks", id + ".answer"),
      JSON.stringify({ value: { answers: [{ id: "q1", selected: ["b"], custom: "我自己写的" }] } }),
    );
    const answer = await done;
    assert.deepEqual(answer, { answers: [{ id: "q1", selected: ["b"], custom: "我自己写的" }] });

    const card = JSON.parse(readFileSync(join(ch.dir, "asks.log.jsonl"), "utf8").trim().split("\n").pop());
    assert.equal(card.by, "hud");
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("子 agent 的事不归我们管：直接放行，不写卡", async () => {
  const ch = channel();
  const { ctx, handlers } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 50 });
  try {
    let called = 0;
    const out = await handlers.get("approval/request")({ agent: { id: "s4", parent: { id: "s1" } } }, async () => {
      called += 1;
      return "allowed-once";
    });
    assert.equal(out, "allowed-once");
    assert.equal(called, 1);
    const asks = existsSync(join(ch.dir, "asks")) ? readdirSync(join(ch.dir, "asks")) : [];
    assert.deepEqual(asks, []);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("会话开与关写进 sessions/", async () => {
  const ch = channel();
  const { ctx, handlers } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 50 });
  try {
    handlers.get("agent/created")({ agent: rootAgent("s5") });
    const opened = JSON.parse(readFileSync(join(ch.dir, "sessions", "s5.json"), "utf8"));
    assert.equal(opened.id, "s5");
    assert.ok(opened.at > 0);
    await wait(120); // 续签一拍
    assert.ok(JSON.parse(readFileSync(join(ch.dir, "sessions", "s5.json"), "utf8")).at >= opened.at);

    handlers.get("agent/disposed")({ agent: rootAgent("s5") });
    const closed = JSON.parse(readFileSync(join(ch.dir, "sessions", "s5.json"), "utf8"));
    assert.ok(closed.ended > 0);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("面板下发的话经 sessionController.prompt 进会话，不重复投递", async () => {
  const ch = channel();
  const { ctx, prompts } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 20, checkInMs: 50 });
  try {
    mkdirSync(join(ch.dir, "prompts", "s6"), { recursive: true });
    writeFileSync(
      join(ch.dir, "prompts", "s6", "0001.json"),
      JSON.stringify({ id: "0001", text: "帮我把测试跑一遍", at: Date.now() }),
    );
    await wait(120);
    assert.equal(prompts.length, 1, "只投递一次");
    assert.equal(prompts[0].sessionId, "s6");
    assert.equal(prompts[0].mode, "queue");
    assert.deepEqual(prompts[0].content, [{ type: "text", text: "帮我把测试跑一遍" }]);
    const stored = JSON.parse(readFileSync(join(ch.dir, "prompts", "s6", "0001.json"), "utf8"));
    assert.ok(stored.takenAt > 0);

    writeFileSync(join(ch.dir, "prompts", "s6", "0002.json"), JSON.stringify({ id: "0002", text: "第二句" }));
    await wait(120);
    assert.equal(prompts.length, 2);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("过期与撤回的话不投递", async () => {
  const ch = channel();
  const { ctx, prompts } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 20, checkInMs: 50 });
  try {
    mkdirSync(join(ch.dir, "prompts", "s7"), { recursive: true });
    writeFileSync(join(ch.dir, "prompts", "s7", "0001.json"), JSON.stringify({ id: "0001", text: "过期了", expiresAt: Date.now() - 1 }));
    writeFileSync(join(ch.dir, "prompts", "s7", "0002.json"), JSON.stringify({ id: "0002", text: "撤回了" }));
    writeFileSync(join(ch.dir, "prompts", "s7", "0002.cancel"), "");
    await wait(120);
    assert.equal(prompts.length, 0);
    assert.ok(JSON.parse(readFileSync(join(ch.dir, "prompts", "s7", "0001.json"), "utf8")).expiredAt > 0);
    assert.ok(JSON.parse(readFileSync(join(ch.dir, "prompts", "s7", "0002.json"), "utf8")).cancelledAt > 0);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("宿主没有 sessionController 时写 refused，不抛出", async () => {
  const ch = channel();
  const handlers = new Map();
  const ctx = { on: (e, h) => (handlers.set(e, h), () => {}), effect: () => () => {}, get: () => null };
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 20, checkInMs: 50 });
  try {
    mkdirSync(join(ch.dir, "prompts", "s8"), { recursive: true });
    writeFileSync(join(ch.dir, "prompts", "s8", "0001.json"), JSON.stringify({ id: "0001", text: "在吗" }));
    await wait(120);
    const stored = JSON.parse(readFileSync(join(ch.dir, "prompts", "s8", "0001.json"), "utf8"));
    assert.ok(stored.refused > 0);
    assert.match(stored.reason, /sessionController/);
  } finally {
    plugin.stop();
    ch.done();
  }
});

test("stop() 清干净：心跳文件删掉、卡收掉", async () => {
  const ch = channel();
  const { ctx, handlers } = fakeCtx();
  const plugin = start(ctx, ch.dir, { answerPollMs: 10, promptPollMs: 20, checkInMs: 50 });
  handlers
    .get("approval/request")({ agent: rootAgent("s9"), toolName: "bash" }, () => new Promise(() => {}));
  await wait(60);
  assert.ok(existsSync(join(ch.dir, "plugin.json")));
  assert.equal(readdirSync(join(ch.dir, "asks")).filter((f) => f.endsWith(".json")).length, 1);
  plugin.stop();
  assert.equal(existsSync(join(ch.dir, "plugin.json")), false);
  ch.done();
});

test("apply 遇到垃圾配置一声不响", async () => {
  const mod = await import("../dsh/magpie-hud.mjs");
  const ctx = { on: () => () => {}, effect: () => () => {}, get: () => null };
  assert.equal(mod.apply(ctx, undefined), undefined);
  assert.equal(mod.apply(ctx, { channel: 42 }), undefined);
  assert.equal(mod.apply({}, { channel: "x" }), undefined); // 相对路径直接不启动
  assert.equal(mod.name, "magpie-hud");
  assert.deepEqual(mod.inject, ["agents"]);
});
