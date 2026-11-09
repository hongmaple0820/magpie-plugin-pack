// The web client's request signature.
//
// The timestamp is the millisecond clock with its second-to-last digit
// replaced by a checksum digit, and the signature is the md5 of
// "<timestamp>-<nonce>-<secret>". The edge refuses anything else, so this is
// reproduced exactly rather than approximated.

import { createHash, randomUUID } from "node:crypto";
import { SIGN_SECRET } from "./client-constants.mjs";

export function md5(input) {
  return createHash("md5").update(input).digest("hex");
}

export function generateSign(nowMs = Date.now(), nonce = randomUUID()) {
  const stamp = String(nowMs);
  const digits = stamp.split("").map(Number);
  if (digits.length < 2) throw new Error("glm: the clock is too short to sign with");
  const sum = digits.reduce((acc, value) => acc + value, 0);
  const check = (sum - digits[digits.length - 2]) % 10;
  const timestamp = stamp.slice(0, stamp.length - 2) + check + stamp.slice(stamp.length - 1);
  return { timestamp, nonce, sign: md5(timestamp + "-" + nonce + "-" + SIGN_SECRET) };
}
