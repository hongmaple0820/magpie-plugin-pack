// Z.ai (chat.z.ai) as a magpie provider.
//
// The endpoint is plain OpenAI Chat Completions behind a web sign-in, so this
// plugin is thin on purpose: swap the credential, send the browser context the
// gateway expects, and pass both directions through unchanged. There is no
// protocol to translate, which is also why there is nothing here to get wrong.

import { ID, NAME, NPM, API_BASE, CHAT_PATH, modelRows, stripModel } from "./lib/constants.mjs";

const BROWSER_CONTEXT = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Origin: "https://chat.z.ai",
  Referer: "https://chat.z.ai/",
  "Sec-Ch-Ua": '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Z.ai: the sign-in has expired, paste a new token"), { status: 401, signIn: "expired" });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "zai_error",
      },
    }),
    { status, headers },
  );
}

export const ZaiPlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[ID] ??= {};
    const provider = cfg.provider[ID];
    provider.name ??= NAME;
    provider.npm ??= NPM;
    provider.api ??= API_BASE;
    // Ours last: a provider record magpie already had must not overwrite the
    // list this plugin serves.
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
    maxConcurrency: 3,
    methods: [
      {
        type: "api",
        label: "粘贴 Z.ai 令牌",
        placeholder: "eyJ…",
        // F12 -> Application -> Cookies -> the value that starts with eyJ
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
            if (!path.endsWith("/chat/completions")) {
              throw Object.assign(new Error("zai: " + request.method + " " + path + " is not served by this provider"), {
                status: 404,
              });
            }
            const token = tokenOf(await getAuth());
            if (!token) throw expired();

            const body = await request.json();
            body.model = stripModel(body.model);
            if (body.model && !modelRows()[body.model]) {
              // The gateway answers an unknown id by quietly serving another
              // model; refusing here is the only honest answer.
              throw Object.assign(new Error("zai: no such model: " + body.model), { status: 404 });
            }

            const headers = {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
              ...BROWSER_CONTEXT,
            };
            const upstream = await fetch(API_BASE + CHAT_PATH, {
              method: "POST",
              headers,
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
