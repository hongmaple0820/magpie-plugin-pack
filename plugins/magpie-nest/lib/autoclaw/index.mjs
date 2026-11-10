// AutoClaw (Zhipu OpenClaw) as two magpie providers:
//   autoclaw     overseas gateway (autoglm-api.autoglm.ai)
//   autoclaw-cn  CN managed gateway (autoglm-acceleration-api.zhipuai.cn)
//
// The protocol is not a plain OpenAI endpoint: see headers.mjs for the
// official client fingerprint and body shaping. Sign-in methods live in
// login.mjs; protocol facts are in constants.mjs.

import {
  CN_HOST, CN_ID, GLOBAL_HOST, MANAGED_HOST, NPM, OVERSEAS_ID,
  REGIONS, modelRows, stripModel,
} from "./constants.mjs";
import {
  bareToken, conversationSessionId, errorResponse, expiredResponse,
  explained, managedChatHeaders, refusedNotSignIn, rewriteManagedBody,
  rewriteOverseasBody, setOfficialChatHeaders,
} from "./headers.mjs";
import { overseaOAuthMethod, phoneSmsMethod } from "./login.mjs";

function makeAutoclawPlugin(regionId) {
  const region = REGIONS[regionId];

  return async () => ({
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[regionId] ??= {};
      const provider = cfg.provider[regionId];
      provider.name ??= region.name;
      provider.npm ??= NPM;
      provider.api ??= region.api;
      // Ours last: a provider record magpie already had must not overwrite
      // the list this plugin serves.
      provider.models = { ...(provider.models ?? {}), ...modelRows(regionId) };
    },

    provider: {
      id: regionId,
      async models(provider) {
        return provider?.models ?? modelRows(regionId);
      },
    },

    auth: {
      provider: regionId,
      maxConcurrency: 3,
      methods: [regionId === CN_ID ? phoneSmsMethod() : overseaOAuthMethod()],

      async loader(getAuth) {
        return {
          baseURL: region.api,
          apiKey: "",
          async fetch(input, init) {
            const request = new Request(input, init);
            try {
              const path = new URL(request.url).pathname;
              if (!path.endsWith("/chat/completions")) {
                throw Object.assign(new Error(regionId + ": " + request.method + " " + path + " is not served by this provider"), {
                  status: 404,
                });
              }

              const auth = await getAuth();
              const token = bareToken(auth?.key ?? auth?.access ?? auth?.token);
              if (!token) {
                throw Object.assign(new Error(regionId + ": the sign-in has expired, sign in again"), {
                  status: 401,
                  signIn: "expired",
                });
              }

              const body = await request.json();
              const modelId = stripModel(body.model);
              if (!modelId) {
                throw Object.assign(new Error(regionId + ": 请求没带 model"), { status: 400 });
              }
              // Upstream wants the bare routeModelId; magpie may name it
              // "<provider>/<model>".
              if (modelId) body.model = modelId;

              if (regionId === CN_ID) {
                const { payload, model } = rewriteManagedBody(JSON.stringify(body));
                const headers = managedChatHeaders(token, model);
                const sentBody = JSON.stringify(payload);
                const res = await fetch(MANAGED_HOST + region.chatPath, {
                  method: "POST",
                  headers,
                  body: sentBody,
                  signal: request.signal,
                });
                if (res.status !== 401 && res.status !== 403) return explained(res);
                const spent = await refusedNotSignIn(res);
                if (spent) return spent;
                try { res.body?.cancel?.(); } catch {}
                return expiredResponse("AutoClaw 登录已失效");
              }

              const rewritten = rewriteOverseasBody(JSON.stringify(body));
              const sent = rewritten ?? body;
              const routeModel = String(sent.model ?? "");
              const nextBody = JSON.stringify(sent);
              const headers = new Headers();
              setOfficialChatHeaders(headers, {
                accessToken: token,
                model: routeModel,
                sessionId: conversationSessionId(sent),
              });

              const tryFetch = (host) =>
                fetch(host + region.chatPath, { method: "POST", headers, body: nextBody, signal: request.signal });

              const res1 = await tryFetch(GLOBAL_HOST);
              if (res1.status !== 401 && res1.status !== 403) return explained(res1);
              const spent1 = await refusedNotSignIn(res1);
              if (spent1) return spent1;
              try { res1.body?.cancel?.(); } catch {}

              const res2 = await tryFetch(CN_HOST);
              const spent2 = await refusedNotSignIn(res2);
              if (spent2) return spent2;
              if (res2.status === 401 || res2.status === 403) {
                try { res2.body?.cancel?.(); } catch {}
                return expiredResponse("AutoClaw 登录已失效（两个 host 均拒绝该 token）");
              }
              return explained(res2);
            } catch (error) {
              return errorResponse(error);
            }
          },
        };
      },
    },
  });
}

export const AutoClawPlugin = makeAutoclawPlugin(OVERSEAS_ID);
export const AutoClawCnPlugin = makeAutoclawPlugin(CN_ID);
