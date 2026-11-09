import { test } from "node:test";
import assert from "node:assert/strict";
import { modelRows, stripModel, ID } from "../lib/loomy/constants.mjs";

test("the eight models keep their billing multiplier in the name", () => {
  const rows = modelRows();
  assert.equal(Object.keys(rows).length, 8);
  assert.equal(rows["qwen-3.8-max"].name, "Qwen 3.8 Max · x12.0");
  assert.equal(rows["spark-x"].name, "Spark X2.5 · x0.1");
});

test("a provider-qualified model name is stripped", () => {
  assert.equal(ID, "loomy");
  assert.equal(stripModel(ID + "/MiniMax-M3"), "MiniMax-M3");
  assert.equal(stripModel("MiniMax-M3"), "MiniMax-M3");
  assert.equal(stripModel(undefined), "");
});
