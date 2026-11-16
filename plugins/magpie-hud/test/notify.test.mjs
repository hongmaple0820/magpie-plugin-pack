import test from "node:test";
import assert from "node:assert/strict";
import { pendingReplies, TERMINAL, STATE_TEXT } from "../webapp/notify.mjs";

test("first round builds the baseline and stays silent", () => {
  const messages = [
    { id: "m3", state: "refused" },
    { id: "m2", state: "done" },
    { id: "m1", state: "queued" },
  ];
  const r = pendingReplies(new Set(), messages, false);
  assert.equal(r.baselineDone, true);
  assert.deepEqual(r.fresh, [], "打开面板不轰炸历史消息");
  assert.deepEqual([...r.seen].sort(), ["m2", "m3"], "已终态的历史记为见过，排队中的不记");
});

test("a message reaching a terminal state later is announced once", () => {
  const base = pendingReplies(new Set(), [{ id: "m1", state: "queued" }], false);
  // m1 变 done
  const step = pendingReplies(base.seen, [{ id: "m1", state: "done" }], base.baselineDone);
  assert.equal(step.fresh.length, 1);
  assert.equal(step.fresh[0].id, "m1");
  // 再来一轮同样的数据：不重复
  const again = pendingReplies(step.seen, [{ id: "m1", state: "done" }], step.baselineDone);
  assert.deepEqual(again.fresh, []);
});

test("non-terminal states never announce", () => {
  const base = pendingReplies(new Set(), [], false);
  for (const state of ["queued", "taken", "started", "unknown"]) {
    const r = pendingReplies(base.seen, [{ id: "x", state }], base.baselineDone);
    assert.deepEqual(r.fresh, [], state + " 不该提醒");
  }
});

test("every terminal state announces", () => {
  for (const state of TERMINAL) {
    const base = pendingReplies(new Set(), [], false);
    const r = pendingReplies(base.seen, [{ id: "x", state }], base.baselineDone);
    assert.equal(r.fresh.length, 1, state + " 应提醒");
    assert.ok(STATE_TEXT[state], state + " 有人话标签");
  }
});

test("several at once are all announced, in the order given", () => {
  const base = pendingReplies(new Set(), [], false);
  const r = pendingReplies(base.seen, [{ id: "b", state: "done" }, { id: "a", state: "replied" }], base.baselineDone);
  assert.deepEqual(r.fresh.map((m) => m.id), ["b", "a"]);
});

test("malformed input is tolerated", () => {
  assert.deepEqual(pendingReplies(new Set(), null, true).fresh, []);
  assert.deepEqual(pendingReplies(new Set(), [null, undefined], true).fresh, []);
  assert.equal(pendingReplies(new Set(), [], false).baselineDone, true);
});
