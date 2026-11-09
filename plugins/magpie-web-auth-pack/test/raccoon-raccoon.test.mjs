import { test } from "node:test";
import assert from "node:assert/strict";
import { modelRows, stripModel, clientHeaders, ID } from "../lib/raccoon/constants.mjs";

test("six models, two of them free", () => {
  const rows = modelRows();
  assert.equal(Object.keys(rows).length, 6);
  assert.match(rows["sn-sensenova-6-8-flash"].name, /Free/);
});

test("the organisation code is sent only when the account has one", () => {
  const withCode = clientHeaders("T", "office_1");
  assert.equal(withCode["X-Org-Code"], "office_1");
  assert.equal(withCode.Authorization, "Bearer T");

  const without = clientHeaders("T", "");
  assert.equal("X-Org-Code" in without, false);
  assert.equal("X-Org-Code" in clientHeaders("T", undefined), false);
});

test("the client headers the gateway fingerprints are present", () => {
  const headers = clientHeaders("T");
  assert.equal(headers["X-Raccoon-Language"], "zh");
  assert.equal(headers["X-Client-Platform"], "desktop-windows");
  assert.match(headers["User-Agent"], /^Raccoon Work\//);
});

test("a provider-qualified model name is stripped", () => {
  assert.equal(ID, "raccoon");
  assert.equal(stripModel(ID + "/sn-glm-5-3"), "sn-glm-5-3");
});
