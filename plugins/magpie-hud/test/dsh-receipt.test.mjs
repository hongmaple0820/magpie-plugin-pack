// 回执状态机：accepted 只代表宿主收下请求，delivered 必须由会话事件证明
// 「这句话真的出现了」，effective 必须由那一轮的 assistant 输出证明。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../dsh/magpie-hud.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-receipt-"));
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect() {},
    get(name) {
      if (name !== "sessionController") return null;
      return { prompt: async () => ({ accepted: true }) };
    },
  };
  const plugin = start(ctx, dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 20, ...options });
  return { dir, handlers, plugin, done: () => { plugin.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

function writePrompt(dir, session, id, text) {
  writeFileSync(join(dir, "prompts", session, id + ".json"), JSON.stringify({ id, text, at: Date.now() }));
  const file = join(dir, "prompts", session, id + ".json");
  return () => JSON.parse(readFileSync(file, "utf8"));
}

test("accepted → delivered（会话事件里出现）→ effective（assistant 输出）", async () => {
  const h2 = harness();
  try {
    const session = "s-receipt";
    // prompts/<session>/ 由 promptSession 建；这里直接 mkdir 再写。
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(h2.dir, "prompts", session), { recursive: true });
    const read = writePrompt(h2.dir, session, "p1", "请把 300 行拆成两半");
    await wait(60);
    assert.equal(read().state, "accepted", "宿主收下请求后是 accepted，不是 delivered");

    const onEvent = h2.handlers.get("session/event");
    onEvent({ header: { id: session } }, { type: "user/message", seq: 7, time: Date.now(), data: { source: { kind: "user" }, message: { content: [{ type: "text", text: "请把 300 行拆成两半" }] } } });
    assert.equal(read().state, "delivered");
    assert.equal(read().deliveredSeq, 7);

    onEvent({ header: { id: session } }, { type: "assistant/message", seq: 8, time: Date.now(), data: { turn: 1, message: { content: [{ type: "text", text: "好" }] } } });
    assert.equal(read().state, "effective");
  } finally {
    h2.done();
  }
});

test("60 秒内没在会话里出现 → timeout，而不是假装送达", async () => {
  const h = harness({ deliverTimeoutMs: 30 });
  try {
    const session = "s-timeout";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(h.dir, "prompts", session), { recursive: true });
    const read = writePrompt(h.dir, session, "p2", "这条不会出现");
    await wait(120);
    assert.equal(read().state, "timeout");
    assert.match(read().reason, /超时/);
  } finally {
    h.done();
  }
});

test("宿主拒收 → failed，且不进 deliveries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-receipt-"));
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect() {},
    get(name) {
      if (name !== "sessionController") return null;
      return { prompt: async () => ({ accepted: false, reason: "忙" }) };
    },
  };
  const plugin = start(ctx, dir, { answerPollMs: 10, promptPollMs: 10, checkInMs: 1000 });
  try {
    const session = "s-refuse";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "prompts", session), { recursive: true });
    const read = writePrompt(dir, session, "p3", "hi");
    await wait(60);
    assert.equal(read().state, "failed");
    assert.match(read().reason, /忙/);
  } finally {
    plugin.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
