// LobsterAI (Youdao) as a magpie provider.
//
// The shape is the one every magpie provider plugin has -- config, auth,
// provider -- because the work is a plain HTTP conversation, not a browser
// drive:
//
//   sign-in  -> the portal's code, traded for tokens
//   a turn   -> POST /api/proxy/v1/chat/completions, SSE-only
//   check-in -> slot, context, then a claim
//
// Read lib/constants.mjs first: two of the headers it names are load-bearing.

import { ID, NAME, NPM, CHAT_BASE, modelRows } from "./constants.mjs";
import { credsOf, canRefresh, patchOf } from "./credential.mjs";
import {
  startLoginSession,
  takeSession,
  loginUrl,
  parseCallback,
  exchangeAuthCode,
  refreshTokens,
  displayName,
} from "./login.mjs";
import { chat } from "./bridge.mjs";
import { checkinOf } from "./checkin.mjs";
import { LobsteraiError } from "./http.mjs";

/** Refresh this long before the token's own expiry. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * A refresh answers the same patch to every account on it within a minute;
 * remembering it spares the endpoint a burst when several requests wake up
 * on one expired token.
 */
const refreshCache = new Map();

function expired() {
  return Object.assign(new LobsteraiError("LobsterAI: the sign-in has expired, sign in again", { status: 401 }), {
    signIn: "expired",
  });
}

/** The body an error becomes. x-magpie-sign-in is how magpie learns to ask for a new sign-in. */
function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  if (error?.retryAfter !== undefined) headers["retry-after"] = String(error.retryAfter);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "lobsterai_error",
      },
    }),
    { status, headers },
  );
}

const methods = [
  {
    type: "oauth",
    label: "浏览器登录 LobsterAI",
    async authorize() {
      const session = startLoginSession();
      return {
        url: loginUrl(session.state),
        instructions: [
          "magpie 会打开 LobsterAI 登录页，请在页面里完成登录。",
          "登录后浏览器会跳到 127.0.0.1 上的一个回调地址（页面打不开是正常的，那个端口本来就没有服务）。",
          "把地址栏里整条地址复制下来粘到下面的输入框；只粘 code= 后面那一串也可以。",
        ].join("\n"),
        method: "code",
        async callback(value) {
          try {
            const pasted = parseCallback(value);
            if (!pasted.code) {
              return { type: "failed", error: "没找到授权码：请复制登录后跳转的整条地址栏，或 code= 后面那一串" };
            }
            // The state names which started sign-in this code belongs to; with
            // one open and a bare code pasted, that one is the only candidate.
            const session = takeSession(pasted.state);
            if (!session) {
              return { type: "failed", error: "这次登录已经失效或已被使用，请重新点一次登录" };
            }
            const credential = await exchangeAuthCode(pasted.code, session);
            const name = displayName(credential);
            const expires =
              credential.expiresIn !== undefined ? Date.now() + credential.expiresIn * 1000 : undefined;
            return {
              type: "success",
              access: credential.accessToken,
              refresh: credential.refreshToken,
              ...(expires !== undefined ? { expires } : {}),
              // The three client identity fields travel with the account: the
              // refresh endpoint refuses a body that lacks one of them.
              uuid: credential.uuid,
              firstKeyfrom: credential.firstKeyfrom,
              latestKeyfrom: credential.latestKeyfrom,
              ...(credential.userId ? { userId: credential.userId } : {}),
              ...(credential.nickname ? { nickname: credential.nickname } : {}),
              ...(name ? { accountId: name } : {}),
            };
          } catch (error) {
            return { type: "failed", error: String(error?.message ?? error) };
          }
        },
      };
    },
  },
  {
    type: "api",
    label: "手动粘贴 Access Token",
    placeholder: "eyJhbGci…",
    // Only for an environment where the portal cannot be opened. A pasted
    // token has no refresh token and no client identity, so it cannot renew
    // itself: when it expires the account is signed in again.
  },
];

export const LobsteraiPlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[ID] ??= {};
    const provider = cfg.provider[ID];
    provider.name ??= NAME;
    provider.npm ??= NPM;
    provider.api ??= CHAT_BASE;
    provider.models = { ...modelRows(), ...(provider.models ?? {}) };
  },

  provider: {
    id: ID,
    // No catalog endpoint is known, so the list stays the one config declared.
    async models(provider) {
      return provider?.models ?? modelRows();
    },
  },

  auth: {
    provider: ID,
    maxConcurrency: 3,
    refreshLead: REFRESH_LEAD_MS,
    methods,

    /**
     * Renew before the token lapses. The patch magpie merges back keeps the
     * client identity fields untouched -- they are the account's, not the
     * token's.
     */
    async refresh(auth) {
      const creds = credsOf(auth);
      if (!creds) throw expired();
      if (!canRefresh(creds)) throw expired();

      const cached = refreshCache.get(creds.refresh);
      if (cached && Date.now() - cached.at < 60_000) return cached.patch;

      try {
        const next = await refreshTokens(creds);
        const patch = patchOf(next.accessToken, next.refreshToken, next.expiresIn, creds);
        refreshCache.set(creds.refresh, { at: Date.now(), patch });
        return patch;
      } catch (error) {
        if (error?.signIn) throw expired();
        throw error;
      }
    },

    async loader(getAuth) {
      return {
        baseURL: CHAT_BASE,
        apiKey: "",
        async fetch(input, init) {
          const request = new Request(input, init);
          try {
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw new LobsteraiError("lobsterai: " + request.method + " " + path + " is not served by this provider", {
                status: 404,
              });
            }
            // Read the account per request: magpie refreshes it between
            // requests, and a credential captured when the loader was built
            // would be the one before the refresh.
            const creds = credsOf(await getAuth());
            if (!creds) throw expired();
            return await chat(creds, request);
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },

    async checkin(getAuth) {
      const creds = credsOf(await getAuth());
      if (!creds) return { outcome: "failed", message: "lobsterai: not signed in" };
      try {
        return await checkinOf(creds);
      } catch (error) {
        return { outcome: "failed", message: String(error?.message ?? error) };
      }
    },
  },
});
