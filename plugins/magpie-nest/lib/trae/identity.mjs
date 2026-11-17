// Device identity for TRAE.
//
// TRAE binds an account to the machine it signed in on: the gateway compares
// the identity headers against what the account was issued for, and a request
// that carries no identity at all is the one case the IDE itself never
// produces. Two facts decided this module:
//
//  1. The identity must be STABLE. Regenerating machine_id on every request is
//     a device migration, and TRAE answers a device migration by asking for a
//     fresh sign-in.
//  2. A pasted token may arrive without one (the user copied the token and the
//     uid, nothing else). Sending "" for X-Machine-Id / X-Device-Id is worse
//     than sending nothing: it is a value, and the gateway reads it as an
//     identity that matches no device.
//
// So both are DERIVED from the uid: same account, same identity, forever.
// (Shapes follow ChatLink providers/checkin/trae.ts:67-85 -- a sha256 stream
// seeded with "<salt>:<uid>", 15 decimal bytes for the device id.)

import { createHash } from "node:crypto";

/** A deterministic byte stream: sha256("<salt>:<seed>" || counter). */
function seededBytes(seed, salt, count) {
  const prefix = salt + ":" + seed;
  const out = [];
  let counter = 0;
  while (out.length < count) {
    const counterBuffer = Buffer.alloc(4);
    counterBuffer.writeUInt32BE(counter, 0);
    const digest = createHash("sha256").update(prefix, "utf8").update(counterBuffer).digest();
    for (const byte of digest) {
      out.push(byte);
      if (out.length >= count) break;
    }
    counter += 1;
  }
  return out;
}

/**
 * The 15-digit device id the IDE sends as X-Device-Id.
 * ChatLink derives the same value from the same uid (trae.ts:85).
 */
export function deriveDeviceId(uid) {
  if (typeof uid !== "string" || uid.length === 0) return "";
  return seededBytes(uid, "devid", 15)
    .map((byte) => String(byte % 10))
    .join("");
}

/**
 * A 32-hex machine fingerprint. Only the shape is contractual (32 lowercase
 * hex); the value has to be stable per account, which is why it is seeded from
 * the uid rather than drawn at random.
 */
export function deriveMachineId(uid) {
  if (typeof uid !== "string" || uid.length === 0) return "";
  return seededBytes(uid, "machine", 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fill in whatever the account did not carry. An explicit value always wins:
 * someone who pasted the real device identity gets exactly that identity.
 */
export function resolveIdentity(uid, machineId, deviceId) {
  return {
    machineId: machineId || deriveMachineId(uid),
    deviceId: deviceId || deriveDeviceId(uid),
  };
}
