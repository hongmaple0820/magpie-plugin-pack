// Loomy (iFlytek) as a magpie provider.
//
// The endpoint is standard OpenAI chat completions with standard SSE, so both
// directions pass through: swap the credential, send the body, return the
// answer as it came.
//
// One asymmetry is worth knowing: the chat endpoint accepts only
// Authorization: Bearer, while the business endpoints accept only a token
// header. This plugin only talks to the chat endpoint.

import { ID, NAME, NPM, API_BASE, CHAT_PATH, modelRows, stripModel } from "./constants.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Loomy: the session has expired, paste a new token"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "loomy_error",
      },
    }),
    { status, headers },
  );
}

export const LoomyPlugin = async () => ({
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
      {
        type: "api",
        label: "粘贴 Loomy 会话令牌",
        placeholder: "登录 Loomy 客户端后的 session token",
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
                new Error("loomy: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const token = tokenOf(await getAuth());
            if (!token) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model) || "deepseek-v4-flash-0731";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("loomy: no such model: " + model), { status: 404 });
            }
            body.model = model;

            const upstream = await fetch(API_BASE + CHAT_PATH, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: body.stream === true ? "text/event-stream" : "application/json",
                Authorization: "Bearer " + token,
              },
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
