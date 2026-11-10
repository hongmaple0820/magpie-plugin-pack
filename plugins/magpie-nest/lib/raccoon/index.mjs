// Raccoon Work as a magpie provider.
//
// The endpoint speaks plain OpenAI chat completions, so both directions pass
// through. Two client headers are load-bearing, and an optional organisation
// code is added only when the account has one.
//
// One quirk is deliberately left alone: the server ACCEPTS reasoning_effort
// but it has no observable effect -- thinking is controlled by
// extra_body.thinking.type. Neither is sent, so the upstream default (thinking
// on) applies rather than silently changing answer quality.

import { ID, NAME, NPM, API_BASE, CHAT_PATH, modelRows, stripModel, clientHeaders } from "./constants.mjs";
import { webLoginMethod } from "../weblogin/index.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function officeOf(auth) {
  const value = auth?.officeCode;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Raccoon Work: the token was refused, paste a new one"), {
    status: 401,
    signIn: "expired",
  });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "raccoon_error",
      },
    }),
    { status, headers },
  );
}

export const RaccoonPlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[ID] ??= {};
    const provider = cfg.provider[ID];
    provider.name ??= NAME;
    provider.npm ??= NPM;
    provider.api ??= API_BASE;
    provider.models = { ...(provider.models ?? {}), ...modelRows() };
  },

  provider: {
    id: ID,
    async models(provider) {
      return provider?.models ?? modelRows();
    },
  },

  auth: {
    provider: ID,
    maxConcurrency: 2,
    methods: [
      webLoginMethod({
        channel: "raccoon",
        label: "一键登录（弹出浏览器自动抓取，推荐）",
      }),

      {
        type: "api",
        label: "粘贴 Raccoon Work 访问令牌",
        placeholder: "RACCOON_ACCESS_TOKEN",
      },
    ],

    async loader(getAuth) {
      return {
        baseURL: API_BASE,
        apiKey: "",
        async fetch(input, init) {
          const request = new Request(input, init);
          try {
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw Object.assign(
                new Error("raccoon: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const auth = await getAuth();
            const token = tokenOf(auth);
            if (!token) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model);
            if (!modelRows()[model]) {
              throw Object.assign(new Error("raccoon: no such model: " + (model || "(none)")), { status: 404 });
            }
            body.model = model;

            const upstream = await fetch(API_BASE + CHAT_PATH, {
              method: "POST",
              headers: clientHeaders(token, officeOf(auth)),
              body: JSON.stringify(body),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!upstream.ok) {
              const text = await upstream.text().catch(() => "");
              const out = new Headers(upstream.headers);
              out.delete("content-length");
              out.delete("content-encoding");
              return new Response(text, { status: upstream.status, headers: out });
            }

            const out = new Headers();
            out.set("content-type", upstream.headers.get("content-type") ?? "application/json");
            out.set("cache-control", "no-cache");
            return new Response(upstream.body, { status: 200, headers: out });
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },
  },
});
