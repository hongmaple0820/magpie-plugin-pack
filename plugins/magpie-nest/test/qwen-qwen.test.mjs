import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, foldEvent, completionBody, sseData } from "../lib/qwen/stream.mjs";
import { flatten, requestBody, queryString, modelRows, stripModel, generateNonce, ID } from "../lib/qwen/constants.mjs";

const answerEvent = (content, status) => ({
  data: { messages: [{ mime_type: "text/plain", content, status }] },
});

test("cumulative content emits only the growth", () => {
  const state = newState();
  assert.equal(foldEvent(state, answerEvent("你")).text, "你");
  assert.equal(foldEvent(state, answerEvent("你好")).text, "好");
  assert.equal(foldEvent(state, answerEvent("你好")).text, "");
  assert.equal(state.text, "你好");
});

test("thinking is emitted before the answer and then stops", () => {
  const state = newState();
  const withThinking = (text) => ({
    data: { messages: [{ mime_type: "text/plain", content: "", meta_data: { multi_load: [{ type: "deep_think", content: { think_content: text } }] } }] },
  });
  assert.equal(foldEvent(state, withThinking("想")).reasoning, "想");
  assert.equal(foldEvent(state, withThinking("想想")).reasoning, "想");
  // once the answer has started thinking is no longer emitted
  foldEvent(state, answerEvent("答"));
  assert.equal(foldEvent(state, withThinking("想想想")).reasoning, "");
});

test("the deep_think marker is stripped from content", () => {
  const state = newState();
  const grew = foldEvent(state, answerEvent("[(deep_think)]正文"));
  assert.equal(grew.text, "正文");
});

test("a finished multi_load/iframe message stops the turn", () => {
  const state = newState();
  foldEvent(state, { data: { messages: [{ mime_type: "multi_load/iframe", status: "finished" }] } });
  assert.equal(state.stop, true);
});

test("an error code is recorded", () => {
  const state = newState();
  foldEvent(state, { data: { error_code: 500, error_msg: "bad" } });
  assert.deepEqual(state.error, { code: 500, message: "bad" });
});

test("the transcript keeps the system prompt in front of the user turn", () => {
  assert.equal(flatten([{ role: "user", content: "hi" }]), "hi");
  assert.equal(flatten([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]), "be brief\n\nUser: hi");
});

test("the request body carries the model, the message and the session", () => {
  const body = requestBody({ model: "qwen3-flash", content: "hi", thinking: false, search: true, reqId: "r1", sessionId: "s1" });
  assert.equal(body.model, "qwen3-flash");
  assert.equal(body.messages[0].content, "hi");
  assert.equal(body.session_id, "s1");
  assert.equal(body.req_id, "r1");
  assert.equal(body.enable_search, true);
  assert.equal(body.deep_search, "1");
  assert.equal(body.protocol_version, "v2");
});

test("the query string carries the fixed parameters and a nonce", () => {
  const query = new URLSearchParams(queryString(1700000000000));
  assert.equal(query.get("biz_id"), "ai_qwen");
  assert.equal(query.get("chat_client"), "h5");
  assert.equal(query.get("pr"), "qwen");
  assert.equal(query.get("timestamp"), "1700000000000");
  assert.match(query.get("nonce"), /^[a-z0-9]{12}$/);
});

test("the nonce is twelve lowercase alphanumerics", () => {
  assert.match(generateNonce(), /^[a-z0-9]{12}$/);
});

test("models are known and qualified names stripped", () => {
  assert.equal(ID, "qwen-web");
  assert.equal(stripModel(ID + "/qwen3-flash"), "qwen3-flash");
  assert.equal(Boolean(modelRows()["qwen3-flash"]), true);
  assert.equal(Boolean(modelRows()["nope"]), false);
});

test("payload lines skip the terminator", () => {
  assert.deepEqual(sseData('data: {"a":1}\ndata: [DONE]\n'), ['{"a":1}']);
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, "qwen3-flash").choices[0].message.content, "hi");
});
