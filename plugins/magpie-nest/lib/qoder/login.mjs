// 设备码 OAuth 登录 + PAT 兑换 + 令牌续期。
//
// 移植自社区 index.mjs:219-276, 639-810, 2724-2759 与
// ChatLink oauth/adapters/qoder.ts:83-156（PKCE 与字段解析）。
// 三个实测坑（ChatLink qoder.ts:14-26）：
//   1. 轮询必须挂 region.openApi，不是 authBase；
//   2. client_id 分 region 且两版不同；
//   3. 真实用户名只能来自 /api/v1/userinfo（设备码响应里没有 user_name）。

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DAY,
  DEVICE_REFRESH_PATH,
  DEVICE_SELECT_PATH,
  JOB_EXCHANGE_PATH,
  JOB_REFRESH_PATH,
  JOB_TOKEN_PATH,
  POLL_INTERVAL_MS,
  POLL_PATH,
  REQUEST_TIMEOUT_MS,
  SIGN_IN_TIMEOUT,
  USERINFO_PATH,
} from "./constants.mjs";

const b64url = (buf) => buf.toString("base64url");
const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function createQoderPkce() {
  const length = 43 + Math.floor(86 * Math.random());
  const bytes = randomBytes(length);
  let verifier = "";
  for (let i = 0; i < length; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length];
  const challenge = createHash("sha256").update(verifier).digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

function readString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseQoderTokenPayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { accessToken: "" };
  const source = value;
  const accessToken = readString(source, ["token", "device_token", "access_token"]) ?? "";
  const refreshToken = readString(source, ["refresh_token", "refreshToken"]);
  const expiresAt = readTimestamp(source.expires_at ?? source.expiresAt);
  const uid = readString(source, ["user_id", "userId"]);
  return { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }), ...(expiresAt === undefined ? {} : { expiresAt }), ...(uid === undefined ? {} : { uid }) };
}

export class SignInGone extends Error {
  constructor(message, expired = false) {
    super(message);
    this.expired = expired;
  }
}

async function openapi(site, path, { method = "GET", token, body, query } = {}) {
  const url = new URL(site.openApi + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function whenSaid(v) {
  if (typeof v === "number" || /^\d+$/.test(String(v ?? "").trim())) {
    const n = Number(v);
    if (!(n > 0)) return 0;
    return n < 1e12 ? n * 1000 : n;
  }
  const at = Date.parse(String(v ?? "").trim());
  return isNaN(at) ? 0 : at;
}

function expiresAt(jt) {
  for (const k of ["expire_time", "expires_at"]) {
    const at = whenSaid(jt?.[k]);
    if (at > Date.now()) return at;
  }
  if (jt?.expires_in > 0) return Date.now() + jt.expires_in;
  return Date.now() + DAY;
}

function deviceExpiry(dt) {
  const at = Date.parse(String(dt?.expires_at ?? "").trim());
  if (!isNaN(at)) return at;
  if (dt?.expires_in > 0) return Date.now() + dt.expires_in * 1000;
  return Date.now() + DAY;
}

async function userInfoOf(site, token) {
  try {
    const ui = await openapi(site, USERINFO_PATH, { token });
    if (ui.status >= 200 && ui.status < 300 && ui.json) {
      const j = ui.json;
      const email = String(j?.email ?? "").trim();
      const name = String(j?.name ?? "").trim();
      const uid = readString(j, ["id", "user_id", "uid"]) ?? "";
      return { email, name, uid };
    }
  } catch {}
  return { email: "", name: "", uid: "" };
}

/**
 * 设备码登录（authorize 形态，供 magpie type:"oauth" 调用）。
 * url 打开 region.authBase 的授权页；callback 由 magpie 在用户授权后调用，
 * 内部轮询 region.openApi 的 deviceToken/poll（坑 1：绝不轮询 authBase）。
 */
export function deviceSignIn(site) {
  const { verifier, challenge } = createQoderPkce();
  const nonce = randomUUID();
  const machineId = randomUUID();
  const q = new URLSearchParams({ challenge, challenge_method: "S256", nonce, machine_id: machineId, client_id: site.clientId });
  const until = Date.now() + SIGN_IN_TIMEOUT;
  return {
    url: `${site.authBase}${DEVICE_SELECT_PATH}?${q}`,
    instructions: `在浏览器里登录 ${site.name} 并授权此设备，插件会每 ${POLL_INTERVAL_MS / 1000} 秒轮询一次，最长等待 15 分钟。`,
    method: "auto",
    async callback() {
      let dt;
      for (;;) {
        if (Date.now() > until) throw new Error(`${site.name}: the sign-in timed out; start again`);
        try {
          const r = await openapi(site, POLL_PATH, { query: { nonce, verifier, challenge_method: "S256" } });
          if (r.status === 200 && String(r.json?.token ?? "").trim()) {
            dt = r.json;
            break;
          }
        } catch {} // 网络抖动：继续问
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      // 国际版：设备码换 job token（社区 index.mjs:664）。
      // 中国版：先试 job token，4xx 退回设备码直接聊天（社区 index.mjs:672-677）。
      let chat;
      if (!site.deviceChat) {
        const jr = await openapi(site, JOB_TOKEN_PATH, { method: "POST", token: dt.token, body: { clientId: site.clientId } });
        if (jr.status === 200 && String(jr.json?.token ?? "").trim()) {
          chat = { access: jr.json.token, refresh: jr.json.refresh_token ?? "", expires: expiresAt(jr.json) };
        } else {
          throw new Error(`${site.name} job token: status ${jr.status}: ${jr.text.trim().slice(0, 300)}`);
        }
      } else {
        const jr = await openapi(site, JOB_TOKEN_PATH, { method: "POST", token: dt.token, body: { clientId: site.clientId } });
        if (jr.status === 200 && String(jr.json?.token ?? "").trim()) {
          chat = { access: jr.json.token, refresh: jr.json.refresh_token ?? "", expires: expiresAt(jr.json) };
        } else if (jr.status >= 400 && jr.status < 500) {
          chat = { access: dt.token, refresh: dt.refresh_token ?? "", expires: deviceExpiry(dt), deviceChat: true };
        } else {
          throw new Error(`${site.name} job token: status ${jr.status}: ${jr.text.trim().slice(0, 300)}`);
        }
      }
      const user = await userInfoOf(site, dt.token);
      const uid = user.uid || dt.user_id || "";
      const email = user.email;
      const name = user.name || dt.user_name || "";
      if (!uid && site.deviceChat) throw new Error(`${site.name}: the sign-in named no user`);
      return {
        type: "success",
        ...chat,
        accountId: email || uid || name || dt.user_id,
        uid,
        email,
        name,
        machineId,
        deviceToken: dt.token,
        deviceRefresh: dt.refresh_token ?? "",
      };
    },
  };
}

/** PAT 兑换 job token（社区 index.mjs:743-785；两端点同路径）。 */
export async function patSignIn(site, pat) {
  const machineId = randomUUID();
  const r = await openapi(site, JOB_EXCHANGE_PATH, { method: "POST", body: { personal_token: pat } });
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    throw Object.assign(new Error(`${site.name} refused the PAT — check it is still valid`), { status: r.status });
  }
  if (r.status !== 200) throw new Error(`${site.name} PAT exchange: status ${r.status}`);
  const token = String(r.json?.token ?? r.json?.device_token ?? r.json?.access_token ?? "").trim();
  if (!token) throw new Error(`${site.name} PAT exchange: empty token in response`);
  const refresh = String(r.json?.refresh_token ?? r.json?.refreshToken ?? "").trim();
  const chat = { access: token, refresh, expires: expiresAt(r.json) };
  const user = await userInfoOf(site, token);
  if (!user.uid) throw new Error(`${site.name} PAT sign-in: could not determine user id`);
  return {
    type: "success",
    ...chat,
    accountId: user.email || user.uid,
    uid: user.uid,
    email: user.email,
    name: user.name,
    machineId,
    deviceToken: "",
    deviceRefresh: "",
    patAuth: true,
    pat,
  };
}

export async function refreshJob(site, refresh, user) {
  if (!String(refresh ?? "").trim()) throw new SignInGone(`${site.name}: the sign-in lapsed; sign in again`);
  const r = await openapi(site, JOB_REFRESH_PATH, { method: "POST", body: { refresh_token: refresh } });
  if (r.status === 401 || r.status === 403) {
    throw new SignInGone(`${user}'s ${site.name} sign-in has expired — sign in again (job token refresh: status ${r.status})`, true);
  }
  if (r.status !== 200) throw new Error(`qoder job token refresh: status ${r.status}`);
  if (!String(r.json?.token ?? "").trim() || !String(r.json?.refresh_token ?? "").trim()) {
    throw new Error("qoder job token refresh: incomplete token pair");
  }
  return { token: r.json.token, refresh: r.json.refresh_token, expires: expiresAt(r.json) };
}

function deviceRefreshBody(site, refresh) {
  const body = { refresh_token: refresh };
  return site.clientId && site.redirect ? { ...body, client_id: site.clientId, redirect_uri: site.redirect } : body;
}

export async function refreshDevice(site, refresh, chat = false) {
  if (!String(refresh ?? "").trim()) {
    if (chat) throw new SignInGone(`${site.name}: the sign-in lapsed; sign in again`);
    throw new Error("qoder device token refresh: missing refresh token; sign in again");
  }
  let r;
  try {
    r = await openapi(site, DEVICE_REFRESH_PATH, { method: "POST", body: deviceRefreshBody(site, refresh) });
  } catch (e) {
    throw new Error(`qoder device token refresh: request failed: ${e?.message ?? e}`);
  }
  if (r.status !== 200) {
    const err = `qoder device token refresh: upstream HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) {
      if (chat) throw new SignInGone(`${site.name} sign-in has expired — sign in again (${err})`, true);
      throw new Error(`${site.name} refused the account-page sign-in (chat still works) — sign in again to see usage (${err})`);
    }
    throw new Error(err);
  }
  const token = r.json?.token || r.json?.device_token || "";
  if (!String(token).trim() || !String(r.json?.refresh_token ?? "").trim()) throw new Error("qoder device token refresh: incomplete token pair");
  return { token, refresh: r.json.refresh_token, expires: deviceExpiry(r.json) };
}
