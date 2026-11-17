// MiniMax Code 设备码 OAuth 登录 + 令牌续期。
//
// 参考实现：
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-oauth.ts
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-auth.ts
//   - F:\maple\ChatLink\src\main\oauth\adapters\minimax.ts

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  MINIMAX_DEVICE_CODE_PATH,
  MINIMAX_TOKEN_PATH,
  MINIMAX_OAUTH_TIMEOUT_MS,
  SIGN_IN_TIMEOUT,
  POLL_INTERVAL_MS,
  DAY,
  SITE,
} from "./constants.mjs";

const b64url = (buf) => buf.toString("base64url");

/** 生成 PKCE verifier + challenge（S256）。 */
export function createMinimaxPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function readString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function readTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** 解析设备码响应。 */
export function parseMinimaxDeviceAuthorization(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload;
  const deviceCode = readString(record, ["device_code"]);
  const userCode = readString(record, ["user_code"]);
  const verificationUri = readString(record, ["verification_uri", "verification_url"]);
  const expiresInSec = readNumber(record.expires_in);
  if (!deviceCode || !userCode || !verificationUri || !expiresInSec) return undefined;
  const intervalSec = readNumber(record.interval) ?? 5;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?user_code=${userCode}`,
    expiresInSec,
    intervalSec,
  };
}

/** 解析令牌授予响应。 */
export function parseMinimaxTokenGrant(payload, previousRefreshToken) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("MiniMax token grant: invalid response shape");
  }
  const record = payload;
  const accessToken = readString(record, ["access_token"]);
  if (!accessToken) throw new Error("MiniMax token grant: missing access_token");
  const refreshToken = readString(record, ["refresh_token"]) ?? previousRefreshToken;
  if (!refreshToken) throw new Error("MiniMax token grant: missing refresh_token");
  const tokenType = readString(record, ["token_type"]);
  if (!tokenType || tokenType.toLowerCase() !== "bearer") {
    throw new Error("MiniMax token grant: token_type must be bearer");
  }
  const expiresIn = readNumber(record.expires_in);
  if (!expiresIn) throw new Error("MiniMax token grant: missing or invalid expires_in");
  const scope = readString(record, ["scope"]);
  if (!scope || !scope.split(/\s+/).includes("agent.default")) {
    throw new Error("MiniMax token grant: scope must include agent.default");
  }
  const expiresAt = String(Date.now() + expiresIn * 1000);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_at: expiresAt,
    scope,
  };
}

/** 设备码授权错误类。 */
export class MinimaxLoginCancelledError extends Error {
  constructor(message = "用户取消了 MiniMax 授权") {
    super(message);
    this.name = "MinimaxLoginCancelledError";
  }
}

export class MinimaxLoginExpiredError extends Error {
  constructor(message = "MiniMax 设备码已过期，请重新登录") {
    super(message);
    this.name = "MinimaxLoginExpiredError";
  }
}

/** 发起设备码授权，返回登录信息与后台轮询回调。 */
export function deviceSignIn(site) {
  const pkce = createMinimaxPkce();
  const deviceCodeUrl = `${site.authBase}${MINIMAX_DEVICE_CODE_PATH}`;
  const body = new URLSearchParams({
    client_id: site.clientId,
    scope: site.scope,
    audience: site.audience,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });

  return {
    url: deviceCodeUrl,
    instructions: "请在浏览器打开链接并输入授权码完成登录",
    method: "auto",
    async callback(signal) {
      let auth;
      try {
        const initRes = await fetch(deviceCodeUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
        });
        const initBody = await initRes.json().catch(() => undefined);
        auth = parseMinimaxDeviceAuthorization(initBody);
        if (!auth) throw new Error("MiniMax device code: invalid authorization response");
        auth.codeVerifier = pkce.verifier;
      } catch (e) {
        throw new Error(`MiniMax device code request failed: ${e?.message ?? e}`);
      }

      const deadline = Date.now() + SIGN_IN_TIMEOUT;
      let intervalMs = auth.intervalSec * 1000;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          throw Object.assign(new Error("minimax: login aborted"), { status: 499 });
        }
        await new Promise((r) => setTimeout(r, intervalMs));

        const pollBody = new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: auth.deviceCode,
          client_id: site.clientId,
          code_verifier: auth.codeVerifier,
        });

        let pollRes;
        try {
          pollRes = await fetch(`${site.authBase}${MINIMAX_TOKEN_PATH}`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: pollBody,
            signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
          });
        } catch (e) {
          throw new Error(`MiniMax poll request failed: ${e?.message ?? e}`);
        }

        const pollBodyJson = await pollRes.json().catch(() => undefined);

        if (!pollRes.ok) {
          const errRecord = typeof pollBodyJson === "object" && pollBodyJson !== null
            ? pollBodyJson
            : {};
          const error = readString(errRecord, ["error"]);
          if (error === "authorization_pending") continue;
          if (error === "slow_down") {
            intervalMs += 5000;
            continue;
          }
          throw new Error(`MiniMax authorization failed: ${error ?? `HTTP ${pollRes.status}`}`);
        }

        const status = readString(pollBodyJson, ["status"]);
        if (status === "pending") continue;
        if (status === "slow_down") {
          intervalMs += 5000;
          continue;
        }
        if (status === "denied" || status === "access_denied") {
          throw new MinimaxLoginCancelledError();
        }
        if (status === "expired" || status === "expired_token") {
          throw new MinimaxLoginExpiredError();
        }

        const credential = parseMinimaxTokenGrant(pollBodyJson, undefined);
        return {
          type: "success",
          access: credential.access_token,
          refresh: credential.refresh_token,
          expires: credential.expires_at,
          accountId: undefined,
          uid: undefined,
          email: undefined,
          name: undefined,
          machineId: undefined,
        };
      }

      throw new MinimaxLoginExpiredError();
    },
  };
}

/** 续期设备码 token。 */
export async function refreshMinimaxCredential(site, refreshToken) {
  if (!String(refreshToken ?? "").trim()) {
    throw new Error("minimax refresh: missing refresh token; sign in again");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: site.clientId,
    scope: site.scope,
    audience: site.audience,
  });
  let res;
  try {
    res = await fetch(`${site.authBase}${MINIMAX_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`minimax refresh: request failed: ${e?.message ?? e}`);
  }
  const bodyJson = await res.json().catch(() => undefined);
  if (!res.ok) {
    const record = typeof bodyJson === "object" && bodyJson !== null ? bodyJson : {};
    const error = readString(record, ["error"]) ?? `HTTP ${res.status}`;
    throw new Error(`minimax refresh failed: ${error}`);
  }
  const credential = parseMinimaxTokenGrant(bodyJson, refreshToken);
  return {
    token: credential.access_token,
    refresh: credential.refresh_token,
    expires: credential.expires_at,
  };
}