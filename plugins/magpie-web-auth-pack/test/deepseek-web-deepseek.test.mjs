import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { newState, foldEvent, completionBody } from "../lib/deepseek-web/stream.mjs";
import { promptOf, modelRows, stripModel, isThinkingModel, ID } from "../lib/deepseek-web/constants.mjs";

const append = (type, content) => ({ p: "response/fragments", o: "APPEND", v: { type, content } });

test("an appended answer fragment is the reply", () => {
  const state = newState();
  assert.equal(foldEvent(state, append("RESPONSE", "你")).text, "你");
  assert.equal(foldEvent(state, append("RESPONSE", "好")).text, "好");
  assert.equal(state.text, "你好");
});

test("an appended thinking fragment is reasoning", () => {
  const state = newState();
  const grew = foldEvent(state, append("THINK", "想"));
  assert.equal(grew.reasoning, "想");
  assert.equal(grew.text, "");
  assert.equal(state.reasoning, "想");
});

test("-1/content grows the last fragment", () => {
  const state = newState();
  foldEvent(state, append("RESPONSE", "a"));
  const grew = foldEvent(state, { p: "response/fragments/-1/content", v: "b" });
  assert.equal(grew.text, "b");
  assert.equal(state.text, "ab");
  assert.equal(state.fragments[0].content, "ab");
});

test("the older direct shapes are read too", () => {
  const state = newState();
  assert.equal(foldEvent(state, { p: "response/thinking_content", v: "想" }).reasoning, "想");
  assert.equal(foldEvent(state, { p: "response/content", v: "答" }).text, "答");
});

test("a bare continuation follows the channel that established it", () => {
  const state = newState();
  // established as thinking
  foldEvent(state, { p: "response/thinking_content", v: "想" });
  const thinking = foldEvent(state, { v: "继续想" });
  assert.equal(thinking.reasoning, "继续想");
  assert.equal(thinking.text, "");

  // established as the answer
  foldEvent(state, { p: "response/content", v: "答" });
  const answer = foldEvent(state, { v: "继续答" });
  assert.equal(answer.text, "继续答");
  assert.equal(state.reasoning, "想继续想");
  assert.equal(state.text, "答继续答");
});

test("a snapshot sets the baseline without repeating it", () => {
  const state = newState();
  foldEvent(state, append("RESPONSE", "a"));
  const grew = foldEvent(state, { v: { response: { fragments: [{ type: "RESPONSE", content: "a" }] } } });
  assert.equal(grew.text, "");
  assert.equal(state.text, "a");
});

test("the transcript is flattened with roles", () => {
  const text = promptOf([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]);
  assert.match(text, /^be brief/);
  assert.match(text, /User: hi/);
  assert.match(text, /Assistant: hello/);
});

test("the thinking switch is the model", () => {
  assert.equal(isThinkingModel("deepseek-reasoner"), true);
  assert.equal(isThinkingModel("deepseek-chat"), false);
});

test("two models, and a qualified name is stripped", () => {
  assert.equal(ID, "deepseek-web");
  assert.equal(Object.keys(modelRows()).length, 2);
  assert.equal(stripModel(ID + "/deepseek-chat"), "deepseek-chat");
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, "deepseek-chat").choices[0].message.content, "hi");
});

test("the shipped PoW wasm instantiates with the exports the solver calls", async () => {
  const path = fileURLToPath(new URL("../assets/sha3_wasm_bg.wasm", import.meta.url));
  const bytes = await readFile(path);
  assert.ok(bytes.length > 1000, "the wasm asset is bundled");
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes), { wbg: {} });
  const exports = instance.exports;
  assert.equal(typeof exports.wasm_solve, "function");
  assert.equal(typeof exports.__wbindgen_export_0, "function");
  assert.equal(typeof exports.__wbindgen_add_to_stack_pointer, "function");
  assert.ok(exports.memory);
});
