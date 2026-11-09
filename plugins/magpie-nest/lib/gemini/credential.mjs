// The account is a Google OAuth credential, and it expires in an hour.
//
// A refresh token issued to the Cloud Code client can only be redeemed by that
// client, so the whole credential JSON travels as one string: access token,
// refresh token, expiry and project.

import { CLIENT_SECRET } from "./client-secret.mjs";
import { CLIENT_ID, TOKEN_ENDPOINT } from "./constants.mjs";

const EXPIRY_LEAD_MS = 60_000;

/** Read the credential from a JSON string, a parsed object, or a bare token. */
export function credOf(auth) {
  const raw = auth?.key ?? auth?.credential ?? auth?.access ?? auth?.token;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return {
        accessToken: String(parsed.access_token ?? parsed.accessToken ?? ""),
        refreshToken: String(parsed.refresh_token ?? parsed.refreshToken ?? ""),
        expiry: Number(parsed.expiry ?? parsed.expires_at ?? 0) || 0,
        project: String(parsed.cloudaicompanionProject ?? parsed.project ?? ""),
      };
    } catch {
      return undefined;
    }
  }
  // A bare token: usable until it lapses, with no way to renew it.
  return { accessToken: text, refreshToken: "", expiry: 0, project: "" };
}

/** Unknown expiry is not expired: a wrong guess costs a needless round trip. */
export function isExpired(cred, now = Date.now()) {
  if (!cred || !cred.expiry) return false;
  return cred.expiry - now <= EXPIRY_LEAD_MS;
}

export async function refresh(cred, fetcher = fetch) {
  if (!cred?.refreshToken) {
    throw Object.assign(
      new Error("gemini: the access token lapsed and the account carries no refresh_token — paste the whole credential JSON again"),
      { status: 401, signIn: "expired" },
    );
  }
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: cred.refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error("gemini: the token refresh was refused (HTTP " + response.status + ")"), {
      status: 401,
      signIn: "expired",
    });
  }
  let grant;
  try {
    grant = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("gemini: the token refresh answered a non-JSON body"), { status: 502 });
  }
  if (typeof grant.access_token !== "string" || !grant.access_token) {
    throw Object.assign(new Error("gemini: the token refresh answered no access_token"), { status: 401, signIn: "expired" });
  }
  const expiresIn = Number(grant.expires_in);
  return {
    accessToken: grant.access_token,
    // Google rotates refresh tokens occasionally; keep the old one otherwise.
    refreshToken: typeof grant.refresh_token === "string" && grant.refresh_token ? grant.refresh_token : cred.refreshToken,
    expiry: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    project: cred.project,
  };
}

/** Ask the service which project this account runs in. */
export async function probeProject(accessToken, fetcher = fetch) {
  for (const base of ["https://daily-cloudcode-pa.sandbox.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"]) {
    try {
      const response = await fetcher(base + "/v1internal:loadCodeAssist", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: '{"metadata":{"ideType":"ANTIGRAVITY"}}',
      });
      if (!response.ok) continue;
      const body = await response.json().catch(() => undefined);
      const project = body?.cloudaicompanionProject;
      if (typeof project === "string" && project) return project;
    } catch {
      /* the next host may answer */
    }
  }
  return "";
}
