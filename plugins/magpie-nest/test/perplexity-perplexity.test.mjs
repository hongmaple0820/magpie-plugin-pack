import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, foldEvent, completionBody, ssePayloads } from "../lib/perplexity/stream.mjs";
import { queryOf, requestBody, modelRows, stripModel, ID } from "../lib/perplexity/constants.mjs";

const markdownEvent = (patchPath, value, extra = {}) => ({
  blocks: [{ diff_block: { field: "markdown_block", patches: [{ path: patchPath, value }] } }],
  ...extra,
});

test("cumulative chunks emit only the growth", () => {
  const state = newState();
  const a = foldEvent(state, markdownEvent("/0", { chunks: ["Hel"] }));
  assert.equal(a.text, "Hel");
  const b = foldEvent(state, markdownEvent("/0", { chunks: ["Hel", "lo"] }));
  assert.equal(b.text, "lo");
  const c = foldEvent(state, markdownEvent("/0", { chunks: ["Hel", "lo"] }));
  assert.equal(c.text, "");
  assert.equal(state.text, "Hello");
});

test("an answer value is read as well as chunks", () => {
  const state = newState();
  const grew = foldEvent(state, markdownEvent("/1", { answer: "答" }));
  assert.equal(grew.text, "答");
});

test("goals patches are reasoning, not the answer", () => {
  const state = newState();
  const grew = foldEvent(state, markdownEvent("/goals/0", "想"));
  assert.equal(grew.text, "");
  assert.equal(grew.reasoning, "想");
  assert.equal(state.text, "");
});

test("non-markdown blocks and progress patches are ignored", () => {
  const state = newState();
  const ignored = foldEvent(state, {
    blocks: [
      { diff_block: { field: "other", patches: [{ path: "/0", value: "x" }] } },
      { diff_block: { field: "markdown_block", patches: [{ path: "/progress", value: "x" }] } },
      { intended_usage: "media_items" },
    ],
  });
  assert.equal(ignored.text, "");
  assert.equal(state.text, "");
});

test("the question is the last user turn, earlier turns become context", () => {
  assert.equal(queryOf([{ role: "user", content: "hi" }]), "hi");
  assert.match(queryOf([
    { role: "system", content: "be brief" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ]), /User: second$/);
});

test("the request body names the model and the question", () => {
  const body = requestBody("hi", "sonar");
  assert.equal(body.query_str, "hi");
  assert.equal(body.params.model_preference, "sonar");
  assert.equal(body.params.dsl_query, "hi");
  assert.equal(body.params.version, "2.18");
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, "auto").choices[0].message.content, "hi");
});

test("model names are known and qualified names are stripped", () => {
  assert.equal(ID, "perplexity");
  assert.equal(stripModel(ID + "/pplx_pro"), "pplx_pro");
  assert.equal(Boolean(modelRows()["pplx_pro"]), true);
  assert.equal(Boolean(modelRows()["nope"]), false);
});

test("payload lines are read in order", () => {
  assert.deepEqual(ssePayloads('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}']);
});
