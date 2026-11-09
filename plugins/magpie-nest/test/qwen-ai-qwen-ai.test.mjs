import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, foldChunk, completionBody, ssePayloads } from "../lib/qwen-ai/stream.mjs";
import { flatten, messageBody } from "../lib/qwen-ai/chat.mjs";
import { modelRows, stripModel, ID } from "../lib/qwen-ai/constants.mjs";

test("the answer phase is the reply and thinking is kept apart", () => {
  const state = newState();
  assert.equal(foldChunk(state, { choices: [{ delta: { phase: "think", status: "typing", content: "想" } }] }).reasoning, "想");
  assert.equal(foldChunk(state, { choices: [{ delta: { phase: "answer", status: "typing", content: "答" } }] }).text, "答");
  assert.equal(state.text, "答");
  assert.equal(state.reasoning, "想");
});

test("finished marks the turn done", () => {
  const state = newState();
  foldChunk(state, { choices: [{ delta: { phase: "answer", status: "finished", content: "" } }] });
  assert.equal(state.finished, true);
});

test("a null phase with content is still the answer", () => {
  const state = newState();
  const grew = foldChunk(state, { choices: [{ delta: { phase: null, content: "hi" } }] });
  assert.equal(grew.text, "hi");
});

test("think content while finished is not reasoning", () => {
  const state = newState();
  const grew = foldChunk(state, { choices: [{ delta: { phase: "think", status: "finished", content: "尾" } }] });
  assert.equal(grew.reasoning, "");
});

test("the transcript is flattened with roles", () => {
  const text = flatten([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]);
  assert.match(text, /^be brief/);
  assert.match(text, /User: hi/);
  assert.match(text, /Assistant: hello/);
  assert.equal(text.includes("again"), true);
});

test("the message body names the chat and the model", () => {
  const body = messageBody({ chatId: "c1", model: "qwen3-max", content: "hi", thinking: false });
  assert.equal(body.chat_id, "c1");
  assert.equal(body.model, "qwen3-max");
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].feature_config.thinking_enabled, false);
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  const body = completionBody(state, "qwen3-max");
  assert.equal(body.choices[0].message.content, "hi");
  assert.equal(body.model, "qwen3-max");
});

test("named models are known and qualified names are stripped", () => {
  assert.equal(ID, "qwen-ai");
  assert.equal(stripModel(ID + "/qwen3-max-2026-01-23"), "qwen3-max-2026-01-23");
  assert.equal(Boolean(modelRows()["qwen3-max-2026-01-23"]), true);
  assert.equal(Boolean(modelRows()["nope"]), false);
});

test("payload lines are read in order", () => {
  assert.deepEqual(ssePayloads('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}']);
});
