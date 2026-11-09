import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame, foldFrame, newState, mapUsage, completionBody } from "../lib/stream.mjs";
import { modelRows, resolveModel, MODEL_BASE, TIERS, ID } from "../lib/constants.mjs";
import { contentsOf } from "../index.mjs";
import { credOf, isExpired } from "../lib/credential.mjs";

const frame = (parts, extra = {}) => JSON.stringify({ response: { candidates: [{ content: { parts }, ...extra }] } });

test("a wrapped frame is peeled to its parts", () => {
  const parsed = parseFrame(frame([{ text: "hi" }]));
  assert.deepEqual(parsed.parts, [{ text: "hi" }]);
});

test("a bare frame is read too", () => {
  const parsed = parseFrame(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }));
  assert.deepEqual(parsed.parts, [{ text: "x" }]);
});

test("a usage-only frame still carries its usage", () => {
  const parsed = parseFrame(JSON.stringify({ response: { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } }));
  assert.deepEqual(parsed.parts, []);
  assert.equal(parsed.usage.promptTokenCount, 5);
});

test("the terminator and garbage yield nothing", () => {
  assert.equal(parseFrame("[DONE]"), undefined);
  assert.equal(parseFrame("not json"), undefined);
  assert.equal(parseFrame(""), undefined);
});

test("a thought part is reasoning, not the answer", () => {
  const state = newState();
  const grew = foldFrame(state, parseFrame(frame([{ text: "想", thought: true }, { text: "答" }])));
  assert.equal(grew.reasoning, "想");
  assert.equal(grew.text, "答");
  assert.equal(state.reasoning, "想");
  assert.equal(state.text, "答");
});

test("MAX_TOKENS becomes length", () => {
  const state = newState();
  foldFrame(state, parseFrame(frame([{ text: "x" }], { finishReason: "MAX_TOKENS" })));
  assert.equal(state.finishReason, "length");
});

test("usage is mapped to OpenAI names", () => {
  assert.deepEqual(mapUsage({ promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }), {
    prompt_tokens: 5,
    completion_tokens: 2,
    total_tokens: 7,
  });
  assert.equal(mapUsage(undefined), undefined);
});

test("the provider id does not collide with the built-in gemini subscription", () => {
  assert.equal(ID, "gemini-code-assist");
});

test("only a tiered model name is accepted", () => {
  assert.equal(resolveModel(MODEL_BASE + "-high"), MODEL_BASE + "-high");
  assert.equal(resolveModel(ID + "/" + MODEL_BASE + "-low"), MODEL_BASE + "-low");
  // the bare name 404s upstream, so it is refused here rather than rerouted silently
  assert.throws(() => resolveModel(MODEL_BASE), (error) => error.status === 404);
  assert.throws(() => resolveModel("gemini-2.0-flash"), (error) => error.status === 404);
});

test("four tiers are advertised", () => {
  assert.equal(TIERS.length, 4);
  assert.deepEqual(Object.keys(modelRows()).sort(), TIERS.map((tier) => MODEL_BASE + "-" + tier).sort());
});

test("consecutive same-role turns are merged and systems pulled out", () => {
  const { contents, systems } = contentsOf([
    { role: "system", content: "be brief" },
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.deepEqual(systems, ["be brief"]);
  assert.equal(contents.length, 2);
  assert.deepEqual(contents[0].parts, [{ text: "a" }, { text: "b" }]);
  assert.equal(contents[1].role, "model");
});

test("the credential is read from the JSON string or a bare token", () => {
  const parsed = credOf({ key: JSON.stringify({ access_token: "A", refresh_token: "R", expiry: 123, cloudaicompanionProject: "p" }) });
  assert.equal(parsed.accessToken, "A");
  assert.equal(parsed.refreshToken, "R");
  assert.equal(parsed.project, "p");
  const bare = credOf({ key: "plain-token" });
  assert.equal(bare.accessToken, "plain-token");
  assert.equal(bare.refreshToken, "");
});

test("unknown expiry is not treated as expired", () => {
  assert.equal(isExpired({ expiry: 0 }), false);
  assert.equal(isExpired({ expiry: Date.now() + 10 * 60 * 1000 }), false);
  assert.equal(isExpired({ expiry: Date.now() + 1000 }), true);
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, MODEL_BASE + "-high").choices[0].message.content, "hi");
});
