import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeSession, isCanonicalSession, mintSessionId, SESSION_RE } from "../lib/session.mjs";
import { baseModelId, isKnownModel, modelRows } from "../lib/constants.mjs";
import { applyFingerprint, withNote } from "../lib/fingerprint.mjs";

test("a canonical session has the shape and the descending stamp the gate wants", () => {
  const id = canonicalizeSession("conversation-1");
  assert.match(id, SESSION_RE);
  assert.equal(isCanonicalSession(id), true);
});

test("one seed always yields one session", () => {
  assert.equal(canonicalizeSession("a"), canonicalizeSession("a"));
  assert.notEqual(canonicalizeSession("a"), canonicalizeSession("b"));
});

test("a fresh id is canonical too", () => {
  assert.equal(isCanonicalSession(mintSessionId()), true);
});

test("a random uuid is not a canonical session", () => {
  assert.equal(isCanonicalSession("11111111-2222-3333-4444-555555555555"), false);
});

test("model names are reduced to their bare id", () => {
  assert.equal(baseModelId("opencode-free/big-pickle"), "big-pickle");
  assert.equal(baseModelId("Big Pickle (Free)"), "Big Pickle");
  assert.equal(baseModelId(undefined), "");
});

test("only the nine free ids are accepted", () => {
  assert.equal(Object.keys(modelRows()).length, 9);
  assert.equal(isKnownModel("big-pickle"), true);
  assert.equal(isKnownModel("opencode-free/glm-5.3-flash-free"), true);
  assert.equal(isKnownModel("gpt-5.4"), false);
});

test("the fingerprint tools are added when missing and never duplicated", () => {
  const once = applyFingerprint([], undefined);
  assert.equal(once.injected, true);
  assert.deepEqual(once.tools.map((t) => t.function.name), ["read", "shell"]);

  const twice = applyFingerprint(once.tools, undefined);
  assert.equal(twice.injected, false);
  assert.equal(twice.tools.length, 2);
});

test("the caller's own read tool is kept, not replaced", () => {
  const mine = { type: "function", function: { name: "read", description: "mine" } };
  const result = applyFingerprint([mine], undefined);
  assert.equal(result.tools.find((t) => t.function.name === "read").function.description, "mine");
});

test("tool_choice none is stripped, any other value kept", () => {
  assert.equal(applyFingerprint([], "none").toolChoice, undefined);
  assert.equal(applyFingerprint([], "auto").toolChoice, "auto");
});

test("the placeholder note lands after leading system messages", () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "system", content: "and kind" },
    { role: "user", content: "hi" },
  ];
  const out = withNote(messages, true);
  assert.equal(out.length, 4);
  assert.equal(out[2].role, "system");
  assert.match(out[2].content, /placeholders that do nothing/);
  // the caller's array is untouched
  assert.equal(messages.length, 3);
  assert.equal(withNote(messages, false), messages);
});
