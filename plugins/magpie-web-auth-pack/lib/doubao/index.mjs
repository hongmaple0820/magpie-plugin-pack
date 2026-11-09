// Doubao (www.doubao.com) as a magpie provider.
//
// The web app answers in numbered events: 2001 carries content, 2003 ends the
// turn. Everything the client expects has to be rebuilt from those.

import {
  ID,
  NAME,
  NPM,
  API_BASE,
  CHAT_PATH,
  clientHeaders,
  queryParams,
  modelRows,
  stripModel,
  conversationText,
  requestBody,
} from "./constants.mjs";
import { newState, foldEvent, drain, completionBody } from "./stream.mjs";

function sessionOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token ?? auth?.sessionId;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Doubao: the session has expired, paste a new sessionid"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "doubao_error",
      },
    }),
    { status, headers },
  );
}

function chunkText(id, model, delta, finish) {
  return "data: " + JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }) + "\n\n";
}

async function* events(response) {
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
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        /* a frame that is not JSON carries nothing we can use */
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
        for await (const raw of events(upstream)) {
          const text = foldEvent(state, raw);
          if (state.error) {
            controller.enqueue(
              encoder.encode(
                "data: " + JSON.stringify({ error: { message: state.error.message || "doubao failed the turn" } }) + "\n\n",
              ),
            );
            break;
          }
          if (!wroteRole && text) {
            controller.enqueue(encoder.encode(chunkText(state.conversationId || "", model, { role: "assistant" })));
            wroteRole = true;
          }
          if (text) controller.enqueue(encoder.encode(chunkText(state.conversationId || "", model, { content: text })));
          if (state.finished) break;
        }
        controller.enqueue(encoder.encode(chunkText("", model, {}, "stop")));
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

export const DoubaoPlugin = async () => ({
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
        label: "粘贴豆包 sessionid",
        placeholder: "登录 www.doubao.com 后 F12 → Application → Cookies → sessionid",
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
                new Error("doubao: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const sessionId = sessionOf(await getAuth());
            if (!sessionId) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model) || "doubao";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("doubao: no such model: " + model), { status: 404 });
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("doubao: the request named no messages"), { status: 400 });
            }

            const query = new URLSearchParams(queryParams()).toString();
            const upstream = await fetch(API_BASE + CHAT_PATH + "?" + query, {
              method: "POST",
              headers: clientHeaders(sessionId),
              body: JSON.stringify(requestBody(conversationText(body.messages))),
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
            if (state.error) {
              throw Object.assign(
                new Error("doubao failed the turn: " + (state.error.message || state.error.code)),
                { status: 502 },
              );
            }
            return Response.json(completionBody(state, model));
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },
  },
});
