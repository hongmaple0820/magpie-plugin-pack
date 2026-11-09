// The session id the v2 gate fingerprints.
//
// Four headers must carry one id shaped ses_ + 12 hex + 14 base62, and the
// hex half must read as a descending timestamp. Anything else is refused, so
// a random uuid will not do. One conversation is pinned to one id: minting a
// fresh one per request burns the per-session quota for no reason.

import { createHash, randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62Fixed(bytes, width) {
  let n = 0n;
  const base = 62n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62[Number(n % base)];
    n /= base;
  }
  return out.join("");
}

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;

export function isCanonicalSession(id) {
  const value = String(id ?? "").trim();
  return SESSION_RE.test(value) && SESSION_DESCENDING_RE.test(value.slice(4, 16));
}

/** Re-encode any seed into a stable canonical session id. */
export function canonicalizeSession(seed) {
  const digest = createHash("sha256").update("ses\u0000" + String(seed ?? "")).digest();
  const current =
    (((BigInt(digest[0]) << 28n) |
      (BigInt(digest[1]) << 20n) |
      (BigInt(digest[2]) << 12n) |
      (BigInt(digest[3]) << 4n) |
      (BigInt(digest[4]) >> 4n)) << 12n) |
    1n;
  const inverted = ~current & 0xffffffffffffn;
  return "ses_" + inverted.toString(16).padStart(12, "0") + base62Fixed(digest.subarray(6, 16), 14);
}

/** A fresh id, for a caller that has no conversation to pin one to. */
export function mintSessionId(timestamp = Date.now()) {
  const value = ~(BigInt(timestamp) * 0x1000n + 1n);
  let hex = "";
  for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  return "ses_" + hex + base62Fixed(randomBytes(14), 14);
}
