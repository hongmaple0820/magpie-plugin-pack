import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyTime, pyNumber, pyJson, requirementsToken, solveProof, parseResources, REQUIREMENTS_PREFIX, PROOF_PREFIX } from "../lib/chatgpt-web/pow.mjs";
import { xorString, solveTurnstile } from "../lib/chatgpt-web/turnstile.mjs";
import { cleanText, foldEvent, newState, completionBody } from "../lib/chatgpt-web/stream.mjs";
import { conversationPayload, conversationMessages } from "../lib/chatgpt-web/payload.mjs";
import { modelRows, stripModel, ID } from "../lib/chatgpt-web/constants.mjs";

// A fixed clock: 2024-01-01T00:00:00Z, minus the fixed -05:00 the upstream stamps.
const EPOCH = 1704067200000;

test("the fingerprint clock uses the upstream's fixed -05:00 stamp", () => {
  assert.equal(legacyTime(EPOCH), "Sun Dec 31 2023 19:00:00");
});

test("python exponent formatting is reproduced", () => {
  assert.equal(pyNumber(1e-7), "1e-07");
  assert.equal(pyNumber(12), "12");
  assert.equal(pyNumber(1.5), "1.5");
});

test("the config serializes with python separators", () => {
  assert.equal(pyJson(["a", 1, "b"]), '["a",1,"b"]');
});

test("the requirements token is the prefixed base64 of the config", () => {
  const token = requirementsToken("UA", {}, { random: () => 0, now: () => 0, epoch: () => EPOCH, uuid: () => "u" });
  assert.ok(token.startsWith(REQUIREMENTS_PREFIX));
  const decoded = JSON.parse(Buffer.from(token.slice(REQUIREMENTS_PREFIX.length), "base64").toString("utf8"));
  assert.equal(decoded.length, 25);
  assert.equal(decoded[3], 1);
  assert.equal(decoded[4], "UA");
});

test("a trivially easy difficulty solves at once and is prefixed", async () => {
  // target 0xff accepts any digest, so the search ends on the first round
  const result = await solveProof("seed", "ff", "UA", {}, { random: () => 0, now: () => 0, epoch: () => EPOCH, uuid: () => "u" });
  assert.ok(result.token.startsWith(PROOF_PREFIX));
  assert.equal(result.iterations, 1);
});

test("an impossible difficulty gives up rather than hanging", async () => {
  // target 0x00 needs a digest starting at zero; a tiny limit proves the loop ends
  await assert.rejects(
    () => solveProof("seed", "00", "UA", {}, { random: () => 0, now: () => 0, epoch: () => EPOCH, uuid: () => "u" }, 3),
    /did not solve/,
  );
});

test("the page yields its scripts and data-build", () => {
  const resources = parseResources('<html data-build="abc"><script src="/c/xyz/_/_ssg.js"></script></html>');
  assert.equal(resources.dataBuild, "c/xyz/_");
  assert.deepEqual(resources.scriptSources, ["/c/xyz/_/_ssg.js"]);
});

test("the xor round-trips, which is how the program is unsealed", () => {
  assert.equal(xorString(xorString("hello world", "key"), "key"), "hello world");
});

test("the turnstile program is executed, not guessed", () => {
  // [2, 1, "hello"] assigns slot 1; [3, 1] turns slot 1 into the token
  const program = [[2, 1, "hello"], [3, 1]];
  const p = "requirements-token";
  const dx = Buffer.from(xorString(JSON.stringify(program), p), "utf8").toString("base64");
  assert.equal(solveTurnstile(dx, p), Buffer.from("hello", "utf8").toString("base64"));
});

test("an unreadable program answers null instead of throwing", () => {
  assert.equal(solveTurnstile("not-base64!!", "k"), null);
});

test("the internal annotations become readable links", () => {
  const text = "see \ue200url\ue202the label\ue202https://example.com\ue201 now";
  assert.equal(cleanText(text), "see the label (https://example.com) now");
  assert.equal(cleanText("plain"), "plain");
});

test("an append grows the answer, a bare value continues it", () => {
  const state = newState();
  assert.equal(foldEvent(state, JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "你" })), "你");
  assert.equal(foldEvent(state, JSON.stringify({ v: "好" })), "好");
  assert.equal(state.text, "你好");
});

test("a batch applies its patches in order", () => {
  const state = newState();
  const batch = { p: "", o: "patch", v: [
    { p: "/message/content/parts/0", o: "append", v: "a" },
    { p: "/message/content/parts/0", o: "append", v: "b" },
  ] };
  assert.equal(foldEvent(state, JSON.stringify(batch)), "ab");
  assert.equal(state.text, "ab");
});

test("the protocol marker and the terminator carry nothing", () => {
  const state = newState();
  assert.equal(foldEvent(state, "v1"), "");
  assert.equal(foldEvent(state, "[DONE]"), "");
});

test("the conversation payload carries the field set the upstream checks", () => {
  const payload = conversationPayload([{ role: "user", content: "hi" }], "auto", { timezone: "" });
  assert.equal(payload.action, "next");
  assert.equal(payload.force_use_sse, true);
  assert.equal(payload.conversation_mode.kind, "primary_assistant");
  assert.equal(payload.timezone, "Asia/Shanghai");
  assert.equal(payload.timezone_offset_min, -480);
  assert.equal(payload.messages[0].content.parts[0], "hi");
  assert.equal(payload.messages[0].author.role, "user");
});

test("two messages become two conversation entries", () => {
  assert.equal(conversationMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]).length, 2);
});

test("models are known and qualified names stripped", () => {
  assert.equal(ID, "chatgpt-web");
  assert.equal(Object.keys(modelRows()).length, 4);
  assert.equal(stripModel(ID + "/gpt-5"), "gpt-5");
});

test("a completion body carries the answer", () => {
  const state = newState();
  state.text = "hi";
  assert.equal(completionBody(state, "auto").choices[0].message.content, "hi");
});
