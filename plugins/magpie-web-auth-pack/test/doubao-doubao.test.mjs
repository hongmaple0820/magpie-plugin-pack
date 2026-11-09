import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, foldEvent, textOfMessage, completionBody } from "../lib/doubao/stream.mjs";
import { conversationText, requestBody, queryParams, modelRows, stripModel, ID } from "../lib/doubao/constants.mjs";

const wrap = (payload) => ({ event_type: 2001, event_data: JSON.stringify(payload) });

test("2001 events carry text and accumulate it", () => {
  const state = newState();
  assert.equal(foldEvent(state, wrap({ message: { content: JSON.stringify({ text: "你" }) } })), "你");
  assert.equal(foldEvent(state, wrap({ message: { content: JSON.stringify({ text: "好" }) } })), "好");
  assert.equal(state.text, "你好");
});

test("the conversation id is remembered", () => {
  const state = newState();
  foldEvent(state, wrap({ conversation_id: "c-9", message: { content: JSON.stringify({ text: "x" }) } }));
  assert.equal(state.conversationId, "c-9");
});

test("2003 ends the turn", () => {
  const state = newState();
  foldEvent(state, { event_type: 2003 });
  assert.equal(state.finished, true);
});

test("is_finish ends the turn as well", () => {
  const state = newState();
  foldEvent(state, wrap({ is_finish: true }));
  assert.equal(state.finished, true);
});

test("other event types are ignored", () => {
  const state = newState();
  assert.equal(foldEvent(state, { event_type: 1999, event_data: "{}" }), "");
  assert.equal(state.text, "");
});

test("a code is an error", () => {
  const state = newState();
  foldEvent(state, { code: 710022002, message: "bad" });
  assert.equal(state.error.code, 710022002);
  assert.equal(state.error.message, "bad");
});

test("the text is read from whichever shape the message takes", () => {
  assert.equal(textOfMessage({ content: JSON.stringify({ text: "a" }) }), "a");
  assert.equal(textOfMessage({ content: JSON.stringify({ delta: { text: "b" } }) }), "b");
  assert.equal(textOfMessage({ content: JSON.stringify({ content: "c" }) }), "c");
  assert.equal(textOfMessage({ content: JSON.stringify("d") }), "d");
  assert.equal(textOfMessage({ content: "plain" }), "plain");
  assert.equal(textOfMessage({}), "");
});

test("a single message passes through, a conversation gets the template markers", () => {
  assert.equal(conversationText([{ role: "user", content: "hi" }]), "hi");
  const multi = conversationText([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert.match(multi, /user\nhi/);
  assert.match(multi, /assistant\nhello/);
  assert.match(multi, /<\|im_end\|>/);
});

test("the body carries the text, the section and the conversation seeds", () => {
  const body = requestBody("hi");
  assert.equal(JSON.parse(body.messages[0].content).text, "hi");
  assert.equal(body.messages[0].content_type, 2001);
  assert.equal(body.conversation_id, "0");
  assert.match(body.section_id, /^26\d{16}$/);
  assert.match(body.local_conversation_id, /^local_16\d{14}$/);
});

test("the query carries the fixed client identity", () => {
  const query = queryParams();
  assert.equal(query.device_platform, "web");
  assert.equal(query.aid, "497858");
  assert.equal(query.web_id, query.tea_uuid);
  assert.match(query.device_id, /^7\d{18}$/);
});

test("one model, and a qualified name is stripped", () => {
  assert.equal(ID, "doubao");
  assert.equal(stripModel(ID + "/doubao"), "doubao");
  assert.equal(Boolean(modelRows().doubao), true);
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, "doubao").choices[0].message.content, "hi");
});
