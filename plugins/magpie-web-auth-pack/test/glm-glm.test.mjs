import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSign } from "../lib/glm/sign.mjs";
import { newState, foldEvent, completionBody } from "../lib/glm/stream.mjs";

const flattenModule = await import("../index.mjs").catch(() => ({}));

test("the signature is an md5 over the stamped timestamp and the nonce", () => {
  const { timestamp, nonce, sign } = generateSign(1700000000000, "nonce-1");
  assert.equal(timestamp.length, 13);
  assert.equal(nonce, "nonce-1");
  assert.match(sign, /^[0-9a-f]{32}$/);
  // The secret is not read here on purpose: what the test can hold is that the
  // signature covers the timestamp and the nonce, which is what makes it a
  // signature rather than a constant.
  const other = generateSign(1700000000000, "nonce-2");
  assert.notEqual(other.sign, sign);
  assert.equal(other.timestamp, timestamp);
  // the second-to-last digit is a checksum, so the stamp is not the clock as-is
  assert.notEqual(timestamp, "1700000000000");
});

test("the checksum digit is stable for one clock reading", () => {
  const a = generateSign(1700000000123, "n");
  const b = generateSign(1700000000123, "n");
  assert.equal(a.timestamp, b.timestamp);
  assert.equal(a.sign, b.sign);
});

test("cumulative parts emit only what grew", () => {
  const state = newState();
  const first = foldEvent(state, {
    conversation_id: "c1",
    parts: [{ logic_id: "p1", content: [{ type: "text", text: "你" }] }],
  });
  assert.equal(first.text, "你");
  assert.equal(state.conversationId, "c1");

  const second = foldEvent(state, {
    parts: [{ logic_id: "p1", content: [{ type: "text", text: "你好" }] }],
  });
  assert.equal(second.text, "好");

  // an event that repeats the same state adds nothing
  const third = foldEvent(state, {
    parts: [{ logic_id: "p1", content: [{ type: "text", text: "你好" }] }],
  });
  assert.equal(third.text, "");
});

test("thinking is kept apart from the answer", () => {
  const state = newState();
  const grew = foldEvent(state, {
    parts: [
      { logic_id: "p1", content: [{ type: "think", think: "想想" }] },
      { logic_id: "p2", content: [{ type: "text", text: "答案" }] },
    ],
  });
  assert.equal(grew.reasoning, "想想");
  assert.equal(grew.text, "答案");
  assert.equal(state.text, "答案");
  assert.equal(state.reasoning, "想想");
});

test("the finish status is recorded", () => {
  const state = newState();
  foldEvent(state, { status: "finish", parts: [] });
  assert.equal(state.finished, true);
});

test("a completion body carries the answer and the thinking", () => {
  const state = newState();
  state.text = "hi";
  state.reasoning = "why";
  const body = completionBody(state, "glm-5");
  assert.equal(body.choices[0].message.content, "hi");
  assert.equal(body.choices[0].message.reasoning_content, "why");
  assert.equal(body.model, "glm-5");
});
