// Sign-in: the portal's hash route, the code it hands back, and the exchange.
//
// The portal is a hash-routed SPA: the login segment lives in the fragment
// (#/login), so the query has to be appended by hand -- building the URL with
// searchParams would drop everything after the hash.
//
// The reader finishes the sign-in in their browser, lands on a loopback
// address nothing listens on, and pastes that address back. It carries the
// code; the state names which started sign-in it belongs to.

import { randomUUID } from "node:crypto";
import {
  PORTAL_BASE,
  EXCHANGE_PATH,
  API_BASE,
  CLIENT_VERSION,
  CALLBACK_PATH,
  CALLBACK_PORT,
  LOGIN_TTL_MS,
} from "./constants.mjs";
import { unwrapEnvelope, readString, readNumber, envelopeMessage, requestJson } from "./http.mjs";

/**
 * Sign-ins that have been started but not finished, keyed by their state. A
 * finished or expired one is dropped, so the map stays the size of the
 * sign-ins actually in flight.
 */
const pending = new Map();

function prunePending(now) {
  for (const [key, entry] of pending) if (now - entry.at >= LOGIN_TTL_MS) pending.delete(key);
}

/** Mint the client-side identity a sign-in runs under. */
export function createLoginSession(nowMs = Date.now()) {
  return { uuid: randomUUID(), firstKeyfrom: String(nowMs) };
}

/** Start a sign-in and remember it by its state. */
export function startLoginSession(nowMs = Date.now()) {
  prunePending(nowMs);
  const state = randomUUID();
  const session = createLoginSession(nowMs);
  pending.set(state, { ...session, at: nowMs });
  return { state, ...session };
}

/**
 * The state a pasted address names, else the only sign-in in flight. The
 * fallback is for a reader who pastes the bare code instead of the address:
 * with one sign-in open there is no ambiguity about which it belongs to.
 */
export function takeSession(state) {
  const now = Date.now();
  prunePending(now);
  const wanted = String(state ?? "").trim();
  if (wanted && pending.has(wanted)) {
    const entry = pending.get(wanted);
    pending.delete(wanted);
    return entry;
  }
  if (!wanted && pending.size === 1) {
    const [key, entry] = pending.entries().next().value;
    pending.delete(key);
    return entry;
  }
  return undefined;
}

/** For tests: forget everything without waiting for the TTL. */
export function clearSessions() {
  pending.clear();
}

export function loginUrl(state, port = CALLBACK_PORT) {
  const redirect = "http://127.0.0.1:" + port + CALLBACK_PATH;
  const query = new URLSearchParams({ source: "electron", redirect_uri: redirect, state: String(state) });
  return PORTAL_BASE + "/portal#/login?" + query.toString();
}

/**
 * Read what the reader pasted: a whole address, or the bare code. Looking in
 * the fragment too costs one line and covers the portal rewriting the route.
 */
export function parseCallback(value) {
  const text = String(value ?? "").trim();
  if (!text) return {};
  const cut = text.indexOf("?") >= 0 ? text.indexOf("?") : text.indexOf("#");
  if (cut < 0) return { code: text };
  const query = text.slice(cut + 1).split("#")[0];
  const params = new URLSearchParams(query);
  return {
    code: params.get("code") ?? params.get("authCode") ?? "",
    state: params.get("state") ?? "",
  };
}

/**
 * Trade the code for tokens. No Authorization header: this call is how a
 * token is obtained in the first place.
 */
export async function exchangeAuthCode(code, session, fetcher = fetch) {
  const url = API_BASE + EXCHANGE_PATH;
  const body = {
    authCode: code,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: String(Date.now()),
    uuid: session.uuid,
    version: CLIENT_VERSION,
  };
  let result;
  try {
    result = await requestJson(fetcher, url, { method: "POST", body });
  } catch (error) {
    if (error?.signIn) throw new Error("LobsterAI refused the authorization code");
    throw error;
  }
  const data = unwrapEnvelope(result.body);
  if (data === undefined) {
    const why = envelopeMessage(result.body);
    throw new Error("LobsterAI's exchange answered a failure envelope" + (why ? ": " + why : ""));
  }
  const accessToken = readString(data, "accessToken");
  if (!accessToken) throw new Error("LobsterAI's exchange answered no accessToken");

  const user = typeof data.user === "object" && data.user !== null ? data.user : {};
  const expiresIn = readNumber(data, "expiresIn") ?? 0;
  return {
    accessToken,
    refreshToken: readString(data, "refreshToken"),
    expiresIn: expiresIn > 0 ? expiresIn : undefined,
    userId: readString(user, "id"),
    nickname: readString(user, "nickname"),
    uuid: session.uuid,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: body.latestKeyfrom,
  };
}

/** Refresh an account from its refresh token, keeping the client identity. */
export async function refreshTokens(auth, fetcher = fetch) {
  const body = {
    firstKeyfrom: auth.firstKeyfrom ?? "",
    latestKeyfrom: auth.latestKeyfrom ?? "",
    version: CLIENT_VERSION,
    refreshToken: auth.refresh ?? "",
  };
  if (auth.uuid) body.uuid = auth.uuid;
  if (auth.userId) body.userId = auth.userId;

  const result = await requestJson(fetcher, API_BASE + "/api/auth/refresh", { method: "POST", body });
  const data = unwrapEnvelope(result.body);
  if (data === undefined) throw new Error("LobsterAI's refresh answered a failure envelope");
  const accessToken = readString(data, "accessToken");
  if (!accessToken) throw new Error("LobsterAI's refresh answered no accessToken");
  return {
    accessToken,
    // A refresh may answer no new refresh token; the old one stays valid.
    refreshToken: readString(data, "refreshToken") || auth.refresh || "",
    expiresIn: readNumber(data, "expiresIn"),
  };
}

/** The name to show for an account: the nickname it reported, else its id. */
export function displayName(credential) {
  if (credential.nickname) return credential.nickname;
  if (credential.userId) return "LobsterAI " + credential.userId.slice(-6);
  return "";
}
