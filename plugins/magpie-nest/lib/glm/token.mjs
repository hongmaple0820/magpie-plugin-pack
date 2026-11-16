// Turning the account's refresh token into the short-lived access token the
// assistant endpoint takes.
//
// The refresh call authenticates with the refresh token itself and answers
// data.result.{access_token, refresh_token}. The access token lives about an
// hour, so it is cached per refresh token rather than minted per request.

import { randomUUID } from "node:crypto";
import { API_BASE, REFRESH_PATH, CLIENT_HEADERS } from "./constants.mjs";
import { generateSign } from "./sign.mjs";

const TTL_MS = 55 * 60 * 1000;
const cache = new Map();

export function refreshTokenOf(auth) {
  const value = auth?.refresh ?? auth?.key ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

/** The sign headers the edge demands on every authenticated call, refresh included. */
function signHeaders() {
  const signature = generateSign();
  return {
    "X-Device-Id": randomUUID(),
    "X-Request-Id": randomUUID(),
    "X-Sign": signature.sign,
    "X-Timestamp": signature.timestamp,
    "X-Nonce": signature.nonce,
  };
}

/** Exchange a refresh token for an access token, or throw. */
export async function exchangeRefreshToken(refreshToken, fetcher = fetch) {
  const cached = cache.get(refreshToken);
  if (cached && Date.now() - cached.at < TTL_MS) return cached;

  const response = await fetcher(API_BASE + REFRESH_PATH, {
    method: "POST",
    headers: { ...CLIENT_HEADERS, ...signHeaders(), Authorization: "Bearer " + refreshToken, "Content-Type": "application/json" },
    body: "{}",
  });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("GLM refused the refresh token"), { status: 401, signIn: "expired" });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw Object.assign(new Error("GLM answered a non-JSON refresh (HTTP " + response.status + ")"), { status: 502 });
  }
  const result = body?.result ?? body?.data?.result ?? body?.data ?? body;
  const access = result?.access_token;
  if (typeof access !== "string" || !access) {
    const detail = typeof body?.message === "string" ? " (" + body.message + ")" : "";
    throw Object.assign(new Error("GLM's refresh answered no access_token" + detail), { status: 401, signIn: "expired" });
  }
  const entry = {
    access,
    refresh: typeof result.refresh_token === "string" && result.refresh_token ? result.refresh_token : refreshToken,
    at: Date.now(),
  };
  cache.set(refreshToken, entry);
  return entry;
}
