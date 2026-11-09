// What magpie hands back as an account's auth, read as LobsterAI needs it.
//
// The sign-in returns access/refresh/expires plus the identity fields the
// refresh endpoint insists on. Those three -- uuid, firstKeyfrom,
// latestKeyfrom -- are minted by the client, never by the server, and must
// travel back unchanged on every refresh: losing one makes the refresh fail
// and the account has to be signed in again.

import { EXPIRY_LEAD_MS } from "./constants.mjs";

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** Milliseconds from a JWT's exp claim, when it has one. */
export function jwtExpMs(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = payload?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read an auth object as credentials. Returns undefined when there is no
 * access token at all, which is the "not signed in" case callers turn into a
 * 401 with signIn: "expired".
 */
export function credsOf(auth) {
  if (typeof auth !== "object" || auth === null) return undefined;
  const token = clean(auth.key) || clean(auth.access) || clean(auth.token) || clean(auth.access_token);
  if (!token) return undefined;
  const expiresAt =
    (Number.isFinite(auth.expires) && auth.expires > 0 ? Number(auth.expires) : undefined) ?? jwtExpMs(token);
  return {
    token,
    refresh: clean(auth.refresh) || clean(auth.refresh_token),
    uuid: clean(auth.uuid),
    firstKeyfrom: clean(auth.firstKeyfrom) || clean(auth.first_keyfrom),
    latestKeyfrom: clean(auth.latestKeyfrom) || clean(auth.latest_keyfrom),
    userId: clean(auth.userId) || clean(auth.user_id),
    nickname: clean(auth.nickname),
    expiresAt,
  };
}

/** Whether a refresh is worth trying at all: it needs all three identity fields. */
export function canRefresh(creds) {
  return Boolean(creds && creds.refresh && creds.uuid && creds.firstKeyfrom);
}

/** Unknown expiry is not expired: a wrong guess costs a needless refresh. */
export function isExpired(creds, now = Date.now()) {
  if (!creds || creds.expiresAt === undefined) return false;
  return creds.expiresAt - now <= EXPIRY_LEAD_MS;
}

/** Turn a token payload into the fields magpie merges into the account. */
export function patchOf(accessToken, refreshToken, expiresIn, previous = {}) {
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : jwtExpMs(accessToken);
  return {
    access: accessToken,
    refresh: refreshToken || previous.refresh || "",
    ...(expiresAt !== undefined ? { expires: expiresAt } : {}),
  };
}
