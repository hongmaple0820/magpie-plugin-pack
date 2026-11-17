// Cline 登录（WorkOS 设备码三步）+ 令牌续期。
//
// 参考实现：
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\cline-oauth.ts
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\cline.ts
//
// 三步（OFM 2026-09-25 实测，本仓库 2026-11-17 用真 client_id 复验第 1、2 步）：
//   ① POST {workOs}/user_management/authorize/device   form client_id
//        → {device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}
//   ② 轮询 POST {workOs}/user_management/authenticate  form grant_type=device_code + device_code + client_id
//        → 200 {access_token, refresh_token, token_type}
//        → 400 {error:"authorization_pending"|"slow_down"|"invalid_grant"|"expired_token"}
//          ⚠️ 看 body.error，不看状态码；authorization_pending 必须继续轮询，
//          slow_down 必须真的累积退避。
//   ③ POST {api}/api/v1/auth/register  JSON {accessToken, refreshToken}
//        → {success:true, data:{accessToken, refreshToken, expiresAt, tokenType, userInfo}}
//
// 没有 PKCE：WorkOS 设备码流不带 code_challenge（与 minimax 那套不同）。

import {
  API_BASE,
  CLINE_OAUTH_TIMEOUT_MS,
  CLINE_REQUEST_TIMEOUT_MS,
  REGISTER_PATH,
  REFRESH_PATH,
  SIGN_IN_TIMEOUT,
  TOKEN_PREFIX,
  WORKOS_AUTHENTICATE_PATH,
  WORKOS_DEVICE_PATH,
  DEVICE_GRANT_TYPE,
} from "./constants.mjs";

function readString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** ISO 8601 / epoch 秒 / epoch 毫秒 → 毫秒时间戳字符串（magpie 的 expires 形态）。 */
export function toExpiresMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(value < 1e12 ? Math.round(value * 1000) : Math.round(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const text = value.trim();
    if (/^\d+$/.test(text)) return toExpiresMs(Number(text));
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return String(parsed);
  }
  return undefined;
}

/** 解析设备码响应。 */
export function parseClineDeviceAuthorization(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const deviceCode = readString(payload, ["device_code"]);
  const userCode = readString(payload, ["user_code"]);
  const verificationUri = readString(payload, ["verification_uri", "verification_url"]);
  const expiresInSec = readNumber(payload.expires_in);
  if (!deviceCode || !userCode || !verificationUri || !expiresInSec) return undefined;
  const complete = readString(payload, ["verification_uri_complete"])
    ?? `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: complete,
    expiresInSec,
    intervalSec: readNumber(payload.interval) ?? 5,
  };
}

/** 解析 WorkOS 令牌响应（设备码第二步）。 */
export function parseVendorTokenGrant(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("cline: 令牌响应不是对象");
  }
  const accessToken = readString(payload, ["access_token"]);
  if (!accessToken) throw new Error("cline: 令牌响应缺 access_token");
  const refreshToken = readString(payload, ["refresh_token"]);
  const tokenType = readString(payload, ["token_type"]) ?? "Bearer";
  if (tokenType.toLowerCase() !== "bearer") throw new Error("cline: token_type 必须是 bearer");
  return { accessToken, refreshToken, tokenType: "Bearer" };
}

/**
 * 解析平台信封（register / refresh 同构）。
 * ⚠️ 判据必须是 `success && data.accessToken`：只看裸 accessToken 会把失败信封当成功。
 * 字段同时容错驼峰与下划线两种形态。
 */
export function parseClineAccountPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (payload.success === false) return undefined;
  const data = typeof payload.data === "object" && payload.data !== null ? payload.data : payload;
  const access = readString(data, ["accessToken", "access_token"]);
  if (!access) return undefined;
  const userInfo = typeof data.userInfo === "object" && data.userInfo !== null
    ? data.userInfo
    : typeof data.user_info === "object" && data.user_info !== null
      ? data.user_info
      : {};
  return {
    access,
    refresh: readString(data, ["refreshToken", "refresh_token"]),
    expires: toExpiresMs(readString(data, ["expiresAt", "expires_at"]) ?? readNumber(data.expiresAt)),
    email: readString(userInfo, ["email"]),
    name: readString(userInfo, ["name", "displayName", "display_name"]),
    accountId: readString(userInfo, ["clineUserId", "cline_user_id", "userId", "user_id"]),
  };
}

/** 设备码授权错误类。 */
export class ClineLoginCancelledError extends Error {
  constructor(message = "用户取消了 Cline 授权") {
    super(message);
    this.name = "ClineLoginCancelledError";
  }
}

export class ClineLoginExpiredError extends Error {
  constructor(message = "Cline 设备码已过期，请重新登录") {
    super(message);
    this.name = "ClineLoginExpiredError";
  }
}

/** 带前缀的令牌（剥掉 workos: 前缀就 401）。 */
export function withTokenPrefix(token) {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) return "";
  return value.startsWith(TOKEN_PREFIX) ? value : `${TOKEN_PREFIX}${value}`;
}

async function postForm(url, form) {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(CLINE_OAUTH_TIMEOUT_MS),
  });
}

/** 第三步：把 WorkOS 令牌换成 Cline 账号凭据（失败不致命，令牌本身可用）。 */
async function registerAccount(access, refresh, signal) {
  const res = await fetch(`${API_BASE}${REGISTER_PATH}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: access, refreshToken: refresh }),
    signal: signal ?? AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const detail = readString(body, ["error"]) ?? `HTTP ${res.status}`;
    throw new Error(`cline register: ${detail}`);
  }
  const account = parseClineAccountPayload(body);
  if (!account) throw new Error("cline register: 响应里没有 accessToken");
  return account;
}

/** 发起设备码授权，返回登录信息与后台轮询回调。 */
export function deviceSignIn(site) {
  const deviceUrl = `${site.workOsBase}${WORKOS_DEVICE_PATH}`;
  const authenticateUrl = `${site.workOsBase}${WORKOS_AUTHENTICATE_PATH}`;

  return {
    url: deviceUrl,
    instructions: "请在浏览器打开链接并输入授权码完成登录",
    method: "auto",
    async callback(signal) {
      let auth;
      try {
        const res = await postForm(deviceUrl, new URLSearchParams({ client_id: site.clientId }));
        const body = await res.json().catch(() => undefined);
        auth = parseClineDeviceAuthorization(body);
        if (!auth) {
          throw new Error(`device code: 响应不认识（HTTP ${res.status}）`);
        }
      } catch (error) {
        throw new Error(`cline device code 请求失败: ${error?.message ?? error}`);
      }

      const deadline = Date.now() + SIGN_IN_TIMEOUT;
      let intervalMs = auth.intervalSec * 1000;
      let networkFailures = 0;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw Object.assign(new Error("cline: login aborted"), { status: 499 });
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));

        const form = new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: auth.deviceCode,
          client_id: site.clientId,
        });

        let res;
        try {
          res = await postForm(authenticateUrl, form);
          networkFailures = 0;
        } catch (error) {
          networkFailures += 1;
          // OFM：连续网络失败 5 次才放弃（一次抖动不该让用户重新登录）。
          if (networkFailures >= 5) {
            throw new Error(`cline 轮询失败: ${error?.message ?? error}`);
          }
          continue;
        }

        const body = await res.json().catch(() => undefined);

        if (!res.ok) {
          const error = readString(body, ["error"]);
          if (error === "authorization_pending") continue;
          if (error === "slow_down") {
            intervalMs += 1000;
            continue;
          }
          if (error === "access_denied") throw new ClineLoginCancelledError();
          if (error === "expired_token" || error === "invalid_grant") {
            // 2026-11-17 实测：假 device_code 就是 400 invalid_grant。
            throw new ClineLoginExpiredError(`cline 授权失败: ${error}`);
          }
          throw new Error(`cline 授权失败: ${error ?? `HTTP ${res.status}`}`);
        }

        const grant = parseVendorTokenGrant(body);
        const access = withTokenPrefix(grant.accessToken);
        const refresh = grant.refreshToken;

        // 第三步 best-effort：register 会真去刷一次 refresh token，
        // 它挂了不该让已经拿到的令牌作废（推理只需要 Bearer）。
        let account;
        try {
          account = await registerAccount(access, refresh, signal);
        } catch {
          account = undefined;
        }

        return {
          type: "success",
          access: account?.access ? withTokenPrefix(account.access) : access,
          refresh: account?.refresh ?? refresh,
          expires: account?.expires,
          accountId: account?.accountId,
          uid: account?.accountId,
          email: account?.email,
          name: account?.name,
        };
      }

      throw new ClineLoginExpiredError();
    },
  };
}

/** 续期：POST {api}/api/v1/auth/refresh，驼峰表单 {refreshToken, grantType:"refresh_token"}。 */
export async function refreshClineCredential(site, refreshToken) {
  const refresh = typeof refreshToken === "string" ? refreshToken.trim() : "";
  if (!refresh) throw new Error("cline refresh: 没有 refresh token，需要重新登录");

  const res = await fetch(`${site.api}${REFRESH_PATH}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh, grantType: "refresh_token" }),
    signal: AbortSignal.timeout(CLINE_REQUEST_TIMEOUT_MS),
  }).catch((error) => {
    throw new Error(`cline refresh: 请求失败: ${error?.message ?? error}`);
  });

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const detail = readString(body, ["error"]) ?? `HTTP ${res.status}`;
    // 2026-11-17 实测：假 refresh 是 400 {"error":"failed to refresh token: invalid_grant"}。
    throw new Error(`cline refresh 失败: ${detail}`);
  }
  const account = parseClineAccountPayload(body);
  if (!account) throw new Error("cline refresh: 响应里没有 accessToken");
  return {
    token: withTokenPrefix(account.access),
    refresh: account.refresh ?? refresh,
    expires: account.expires,
  };
}
