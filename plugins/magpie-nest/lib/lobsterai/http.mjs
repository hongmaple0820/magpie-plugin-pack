// Envelope, timeout and error helpers shared by every LobsterAI call.

import { TIMEOUT_MS, USER_AGENT } from "./constants.mjs";

/**
 * LobsterAI answers every API in an envelope {"code":0,"data":{...}}; a code
 * that is present and not 0 is a failure even on HTTP 200. Endpoints that
 * answer the payload bare are tolerated: the whole body is then the data.
 */
export function unwrapEnvelope(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (body.code !== undefined && Number(body.code) !== 0) return undefined;
  const data = body.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) return data;
  return body;
}

export function readString(source, key) {
  if (typeof source !== "object" || source === null) return "";
  const value = source[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function readNumber(source, key) {
  if (typeof source !== "object" || source === null) return undefined;
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

/** The envelope's own words when it has any, so a failure says why. */
export function envelopeMessage(body) {
  return readString(body, "msg") || readString(body, "message") || readString(body, "error") || "";
}

/**
 * An error a caller can turn into a Response. status is the HTTP status the
 * client should see; signIn marks the account as needing a sign-in again.
 */
export class LobsteraiError extends Error {
  constructor(message, { status = 500, signIn, retryAfter } = {}) {
    super(message);
    this.name = "LobsteraiError";
    this.status = status;
    if (signIn) this.signIn = signIn;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** Fetch JSON from an endpoint that speaks the envelope, or throw. */
export async function requestJson(fetcher, url, { method = "GET", token, body, signal, headers = {} } = {}) {
  const init = {
    method,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : { signal: AbortSignal.timeout(TIMEOUT_MS) }),
  };

  let response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new LobsteraiError("LobsterAI did not answer in time", { status: 504 });
    }
    throw new LobsteraiError("LobsterAI could not be reached: " + String(error?.message ?? error), { status: 502 });
  }

  let parsed;
  const text = await response.text();
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (response.status === 401 || response.status === 403) {
    throw new LobsteraiError("LobsterAI refused the credential", { status: 401, signIn: "expired" });
  }
  if (parsed === undefined) {
    throw new LobsteraiError("LobsterAI answered a non-JSON body (HTTP " + response.status + ")", {
      status: response.status >= 500 ? 502 : response.status,
    });
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** True when a body's words are about an exhausted allowance rather than a fault. */
const QUOTA_WORDS = /quota|insufficient|balance|credit|exhaust|limit reached|额度|余额|耗尽|不足/i;

export function looksLikeQuota(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return QUOTA_WORDS.test(text);
}
