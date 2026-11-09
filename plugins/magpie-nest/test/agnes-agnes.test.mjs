import { test } from "node:test";
import assert from "node:assert/strict";
import { modelRows, stripModel, ID, API_BASE } from "../lib/agnes/constants.mjs";

test("only the text models are listed", () => {
  const rows = modelRows();
  assert.equal(Object.keys(rows).length, 5);
  assert.equal(Boolean(rows["agnes-3.0-flash"]), true);
  // the media models are a different surface and must not be offered
  assert.equal(rows["agnes-image-2.1-flash"], undefined);
  assert.equal(rows["agnes-video-2.5"], undefined);
});

test("the base keeps its /v1 prefix", () => {
  // without the prefix the bare host answers a Cloudflare 403 page
  assert.equal(API_BASE, "https://api.agnes-ai.cn/v1");
});

test("a provider-qualified model name is stripped", () => {
  assert.equal(ID, "agnes");
  assert.equal(stripModel(ID + "/agnes-2.5-flash"), "agnes-2.5-flash");
});
