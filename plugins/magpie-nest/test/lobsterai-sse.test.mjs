import { test } from "node:test";
import assert from "node:assert/strict";
import { ssePayloads, foldChunk, newState, completionBody, aggregate } from "../lib/lobsterai/sse.mjs";

const STREAM = [
  'data: {"model":"glm-5","choices":[{"delta":{"content":"你"}}]}',
  "",
  'data: {"choices":[{"delta":{"content":"好"}}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

test("payloads are read in order and the terminator kept for the caller", () => {
  assert.deepEqual(ssePayloads(STREAM), [
    '{"model":"glm-5","choices":[{"delta":{"content":"你"}}]}',
    '{"choices":[{"delta":{"content":"好"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    "[DONE]",
  ]);
});

test("CRLF and blank payloads are tolerated", () => {
  assert.deepEqual(ssePayloads("data: a\r\n\ndata:\r\n\ndata: b\r\n"), ["a", "b"]);
});

test("folding keeps the answer, the thinking and the finish reason apart", () => {
  const state = newState();
  foldChunk(state, { choices: [{ delta: { content: "答" , reasoning_content: "想" } }] });
  foldChunk(state, { choices: [{ delta: { content: "案" }, finish_reason: "length" }], model: "glm-5" });
  assert.equal(state.text, "答案");
  assert.equal(state.reasoning, "想");
  assert.equal(state.finishReason, "length");
  assert.equal(state.model, "glm-5");
});

test("a completion body carries what an OpenAI client reads", () => {
  const state = newState();
  state.text = "hi";
  state.usage = { prompt_tokens: 3, completion_tokens: 2 };
  const body = completionBody(state, "glm-5");
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "glm-5");
  assert.equal(body.choices[0].message.content, "hi");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test("aggregate drains a real response into one answer", async () => {
  const state = await aggregate(new Response(STREAM), "glm-5");
  assert.equal(state.text, "你好");
  assert.equal(state.model, "glm-5");
  assert.deepEqual(state.usage, { prompt_tokens: 3, completion_tokens: 2 });
});
