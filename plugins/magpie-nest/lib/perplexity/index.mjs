// Perplexity (www.perplexity.ai) as a magpie provider.
//
// The web app answers one question at a time over SSE, in diff patches. A
// session cookie stands in for an API key.

import {
  ID,
  NAME,
  NPM,
  API_BASE,
  ASK_PATH,
  SESSION_COOKIE,
  CLIENT_HEADERS,
  modelRows,
  stripModel,
  requestBody,
  queryOf,
} from "./constants.mjs";
import { newState, foldEvent, drain, completionBody } from "./stream.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token ?? auth?.sessionToken;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Perplexity: the session has expired, paste a new session token"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "perplexity_error",
      },
    }),
    { status, headers },
  );
}

function chunkText(model, delta, finish) {
  return "data: " + JSON.stringify({
    id: "",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }) + "\n\n";
}

async function* iterate(response) {
  if (!response?.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).trim();
        if (payload) yield payload;
      }
    }
  }
}

function project(upstream, model) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const state = newState();
      let wroteRole = false;
      try {
        for await (const payload of iterate(upstream)) {
          if (payload === "[DONE]") break;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const grew = foldEvent(state, event);
          if (!wroteRole) {
            controller.enqueue(encoder.encode(chunkText(model, { role: "assistant", content: "" })));
            wroteRole = true;
          }
          if (grew.reasoning) controller.enqueue(encoder.encode(chunkText(model, { reasoning_content: grew.reasoning })));
          if (grew.text) controller.enqueue(encoder.encode(chunkText(model, { content: grew.text })));
        }
        controller.enqueue(encoder.encode(chunkText(model, {}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        controller.enqueue(
          encoder.encode("data: " + JSON.stringify({ error: { message: String(error?.message ?? error) } }) + "\n\n"),
        );
      } finally {
        controller.close();
      }
    },
  });
}

export const PerplexityPlugin = async () => ({
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
    maxConcurrency: 1,
    methods: [
      {
        type: "api",
        label: "粘贴 Perplexity 会话令牌",
        placeholder: "__Secure-next-auth.session-token 的值",
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
                new Error("perplexity: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const token = tokenOf(await getAuth());
            if (!token) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model) || "auto";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("perplexity: no such model: " + model), { status: 404 });
            }
            const query = queryOf(body?.messages);
            if (!query) {
              throw Object.assign(new Error("perplexity: the request named no question"), { status: 400 });
            }

            const upstream = await fetch(API_BASE + ASK_PATH, {
              method: "POST",
              headers: {
                ...CLIENT_HEADERS,
                "Content-Type": "application/json",
                Cookie: SESSION_COOKIE + "=" + token,
              },
              body: JSON.stringify(requestBody(query, model)),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!upstream.ok) {
              const text = await upstream.text().catch(() => "");
              const out = new Headers(upstream.headers);
              out.delete("content-length");
              out.delete("content-encoding");
              return new Response(text, { status: upstream.status, headers: out });
            }

            if (body.stream === true) {
              return new Response(project(upstream, model), {
                status: 200,
                headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
              });
            }
            const state = await drain(upstream);
            return Response.json(completionBody(state, model));
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },
  },
});
