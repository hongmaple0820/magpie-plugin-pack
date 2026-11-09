import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapEnvelope, readString, readNumber, looksLikeQuota } from "../lib/http.mjs";

test("a success envelope yields its data", () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapEnvelope({ data: { a: 1 } }), { a: 1 });
});

test("a non-zero code yields nothing, even on HTTP 200", () => {
  assert.equal(unwrapEnvelope({ code: 40003, msg: "bad" }), undefined);
  assert.equal(unwrapEnvelope({ code: "1" }), undefined);
});

test("a body with no envelope is its own payload", () => {
  assert.deepEqual(unwrapEnvelope({ accessToken: "x" }), { accessToken: "x" });
  assert.equal(unwrapEnvelope(null), undefined);
  assert.equal(unwrapEnvelope([1]), undefined);
});

test("readString and readNumber tolerate the shapes a vendor sends", () => {
  assert.equal(readString({ a: "x" }, "a"), "x");
  assert.equal(readString({ a: 7 }, "a"), "7");
  assert.equal(readString({ a: {} }, "a"), "");
  assert.equal(readNumber({ a: "12" }, "a"), 12);
  assert.equal(readNumber({ a: 1.5 }, "a"), 1.5);
  assert.equal(readNumber({ a: "x" }, "a"), undefined);
});

test("quota wording is told apart from an ordinary fault", () => {
  assert.equal(looksLikeQuota("您的余额不足"), true);
  assert.equal(looksLikeQuota('{"message":"insufficient credits"}'), true);
  assert.equal(looksLikeQuota("internal error"), false);
});
