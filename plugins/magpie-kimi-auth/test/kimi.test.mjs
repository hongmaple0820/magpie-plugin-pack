import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "../lib/frame.mjs";
import { newState, foldMessage, completionBody } from "../lib/stream.mjs";
import { flatten, requestBody, modelRows, stripModel, SCENARIO } from "../lib/constants.mjs";

test("a frame is a flag, a big-endian length and the JSON", () => {
  const frame = encodeFrame('{"a":1}');
  assert.equal(frame[0], 0);
  assert.equal(new DataView(frame.buffer).getUint32(1, false), 7);
  assert.equal(new TextDecoder().decode(frame.slice(5)), '{"a":1}');
});

test("the decoder answers whole frames and carries the remainder", () => {
  const one = encodeFrame('{"n":1}');
  const two = encodeFrame('{"n":2}');
  const both = new Uint8Array(one.length + two.length);
  both.set(one, 0);
  both.set(two, one.length);

  const decoder = new FrameDecoder();
  // a split inside the second frame's header must not lose it
  const first = decoder.push(both.slice(0, one.length + 3));
  assert.deepEqual(first, ['{"n":1}']);
  const rest = decoder.push(both.slice(one.length + 3));
  assert.deepEqual(rest, ['{"n":2}']);
});

test("a heartbeat carries nothing", () => {
  const state = newState();
  const grew = foldMessage(state, { heartbeat: true });
  assert.equal(grew.text, "");
  assert.equal(state.text, "");
});

test("answer and thinking are told apart by flags", () => {
  const state = newState();
  assert.equal(foldMessage(state, { op: "append", block: { text: { content: "想", flags: "thinking" } } }).reasoning, "想");
  assert.equal(foldMessage(state, { op: "append", block: { text: { content: "答", flags: "answer" } } }).text, "答");
  assert.equal(state.text, "答");
  assert.equal(state.reasoning, "想");
});

test("an error frame is recorded rather than emitted as text", () => {
  const state = newState();
  foldMessage(state, { error: { message: "nope" } });
  assert.deepEqual(state.error, { message: "nope" });
  assert.equal(state.text, "");
});

test("the chat id is remembered for a resumed turn", () => {
  const state = newState();
  foldMessage(state, { chat: { id: "c-1" } });
  assert.equal(state.chatId, "c-1");
});

test("the transcript is flattened with roles", () => {
  const text = flatten([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert.match(text, /^be brief/);
  assert.match(text, /User: hi/);
  assert.match(text, /Assistant: hello/);
});

test("the request body is this scenario with one user block", () => {
  const body = requestBody("hi", { thinking: true, search: false });
  assert.equal(body.scenario, SCENARIO);
  assert.equal(body.message.blocks[0].text.content, "hi");
  assert.equal(body.options.thinking, true);
  assert.deepEqual(body.tools, []);
});

test("model names are known and qualified names stripped", () => {
  assert.equal(stripModel("kimi-web/kimi-k3"), "kimi-k3");
  assert.equal(Boolean(modelRows()["kimi-k3"]), true);
  assert.equal(Boolean(modelRows()["nope"]), false);
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, "kimi-k3").choices[0].message.content, "hi");
});
