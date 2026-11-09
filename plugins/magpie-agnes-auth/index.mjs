// Agnes AI as a magpie provider.
//
// The text models speak plain OpenAI chat completions, so this is a credential
// swap. Agnes' image and video models are a different surface -- they are not
// chat completions, and listing them here would offer models that fail.

import { ID, NAME, NPM, API_BASE, CHAT_PATH, modelRows, stripModel } from "./lib/constants.mjs";

function keyOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Agnes: the API key was refused"), { status: 401, signIn: "expired" });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "agnes_error",
      },
    }),
    { status, headers },
  );
}

export const AgnesPlugin = async () => ({
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
        label: "粘贴 Agnes API Key",
        placeholder: "sk-…",
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
                new Error("agnes: " + request.method + " " + path + " is not served by this provider (image and video generation are not implemented yet)"),
                { status: 404 },
              );
            }
            const key = keyOf(await getAuth());
            if (!key) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model);
            if (!modelRows()[model]) {
              throw Object.assign(new Error("agnes: no such text model: " + (model || "(none)")), { status: 404 });
            }
            body.model = model;

            const upstream = await fetch(API_BASE + CHAT_PATH, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: body.stream === true ? "text/event-stream" : "application/json",
                Authorization: "Bearer " + key,
              },
              body: JSON.stringify(body),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!upstream.ok) {
              const text = await upstream.text().catch(() => "");
              const out = new Headers(upstream.headers);
              out.delete("content-length");
              out.delete("content-encoding");
              return new Response(text, { status: upstream.status === 401 ? 401 : upstream.status, headers: out });
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
