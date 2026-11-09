import { test } from "node:test";
import assert from "node:assert/strict";
import { modelRows, stripModel, ID } from "../lib/constants.mjs";

test("the model list is the four GLM chat models", () => {
  assert.deepEqual(Object.keys(modelRows()), ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5"]);
  assert.equal(modelRows()["glm-5.3"].name, "GLM-5.3");
});

test("a provider-qualified model name is stripped", () => {
  assert.equal(ID, "zai-web");
  assert.equal(stripModel(ID + "/glm-5.3"), "glm-5.3");
  assert.equal(stripModel("glm-5.3"), "glm-5.3");
  assert.equal(stripModel(" other/glm-5.3 "), " other/glm-5.3 ".trim());
  assert.equal(stripModel(undefined), "");
});
