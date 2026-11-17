// TRAE device identity: stable per account, derived when the paste did not
// carry it, and never an empty header.
import test from "node:test";
import assert from "node:assert/strict";

import { deriveDeviceId, deriveMachineId, resolveIdentity } from "../lib/trae/identity.mjs";
import { clientHeaders, REGIONS } from "../lib/trae/constants.mjs";

test("the derived device id is the 15 digits the IDE sends", () => {
  const id = deriveDeviceId("7000000000000000000");
  assert.match(id, /^[0-9]{15}$/);
});

test("the derived machine id is 32 lowercase hex", () => {
  const id = deriveMachineId("7000000000000000000");
  assert.match(id, /^[0-9a-f]{32}$/);
});

test("derivation is stable: the same account always gets the same identity", () => {
  assert.equal(deriveDeviceId("u-1"), deriveDeviceId("u-1"));
  assert.equal(deriveMachineId("u-1"), deriveMachineId("u-1"));
});

test("two accounts do not share an identity", () => {
  assert.notEqual(deriveDeviceId("u-1"), deriveDeviceId("u-2"));
  assert.notEqual(deriveMachineId("u-1"), deriveMachineId("u-2"));
});

test("an explicit identity is kept verbatim", () => {
  const identity = resolveIdentity("u-1", "0123456789abcdef0123456789abcdef", "123456789012345");
  assert.equal(identity.machineId, "0123456789abcdef0123456789abcdef");
  assert.equal(identity.deviceId, "123456789012345");
});

test("a missing identity is derived rather than left blank", () => {
  const identity = resolveIdentity("7000000000000000000", "", "");
  assert.match(identity.machineId, /^[0-9a-f]{32}$/);
  assert.match(identity.deviceId, /^[0-9]{15}$/);
});

test("no uid means no identity to invent", () => {
  assert.deepEqual(resolveIdentity("", "", ""), { machineId: "", deviceId: "" });
});

test("the identity headers carry the resolved values, not empty strings", () => {
  const identity = resolveIdentity("7000000000000000000", "", "");
  const headers = clientHeaders(REGIONS["trae-cn"], "token", {
    uid: "7000000000000000000",
    ...identity,
  });
  assert.equal(headers["X-Machine-Id"], identity.machineId);
  assert.equal(headers["X-Device-Id"], identity.deviceId);
  assert.notEqual(headers["X-Machine-Id"], "");
  assert.notEqual(headers["X-Device-Id"], "");
});
