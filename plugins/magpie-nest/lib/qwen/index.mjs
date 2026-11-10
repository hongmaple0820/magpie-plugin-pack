// Qwen (qianwen.com) as a magpie provider.
//
// The web app takes one message per turn over SSE, with the thinking sent
// beside the answer as a separate load. A ticket cookie stands in for a key.

import {
  ID,
  NAME,
  NPM,
  API_BASE,
  CHAT_PATH,
  CLIENT_HEADERS,
  modelRows,
  stripModel,
  flatten,
  queryString,
  requestBody,
  uuid,
} from "./constants.mjs";
import { newState, foldEvent, drain, completionBody } from "./stream.mjs";
import { webLoginMethod } from "../weblogin/index.mjs";

const TICKET_COOKIE = "tongyi_sso_ticket=";

function ticketOf(auth) {
  const value = auth?.key ?? auth?.ticket ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Qwen: the sign-in has expired, paste a new tongyi_sso_ticket"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "qwen_error",
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

function project(upstream, model, id) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const state = newState();
      let wroteRole = false;
      try {
        for await (const event of events(upstream)) {
          const grew = foldEvent(state, event);
          if (state.error) {
            controller.enqueue(
              encoder.encode(
                "data: " + JSON.stringify({ error: { message: state.error.message || "qwen failed the turn" } }) + "\n\n",
              ),
            );
            break;
          }
          if (!wroteRole && (grew.text || grew.reasoning)) {
            controller.enqueue(encoder.encode(chunkText(id, model, { role: "assistant" })));
            wroteRole = true;
          }
          if (grew.reasoning) controller.enqueue(encoder.encode(chunkText(id, model, { reasoning_content: grew.reasoning })));
          if (grew.text) controller.enqueue(encoder.encode(chunkText(id, model, { content: grew.text })));
          if (state.stop) break;
        }
        controller.enqueue(encoder.encode(chunkText(id, model, {}, "stop")));
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

export const QwenPlugin = async () => ({
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
        channel: "qwen",
        label: "一键登录（弹出浏览器自动抓取，推荐）",
      }),

      {
        type: "api",
        label: "粘贴通义 tongyi_sso_ticket",
        placeholder: "登录 qianwen.com 后 F12 → Application → Cookies → tongyi_sso_ticket",
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
                new Error("qwen: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const ticket = ticketOf(await getAuth());
            if (!ticket) throw expired();

            const body = await request.json();
            let model = stripModel(body?.model) || "tongyi-qwen3-max-model-agent";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("qwen: no such model: " + model), { status: 404 });
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("qwen: the request named no messages"), { status: 400 });
            }

            const lowered = model.toLowerCase();
            const thinking = lowered.includes("think") || lowered.includes("r1");
            const search = lowered.includes("search");
            // The thinking switch is a different agent, not a flag.
            if (thinking && model === "tongyi-qwen3-max-model-agent") model = "tongyi-qwen3-max-thinking-agent";

            const reqId = uuid();
            const sessionId = uuid();
            const nowMs = Date.now();
            const upstream = await fetch(API_BASE + CHAT_PATH + "?" + queryString(nowMs), {
              method: "POST",
              headers: {
                ...CLIENT_HEADERS,
                "Content-Type": "application/json",
                Cookie: TICKET_COOKIE + ticket,
              },
              body: JSON.stringify(
                requestBody({
                  model,
                  content: flatten(body.messages),
                  thinking,
                  search,
                  reqId,
                  sessionId,
                  nowMs,
                }),
              ),
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
              return new Response(project(upstream, model, reqId), {
                status: 200,
                headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
              });
            }

            const state = await drain(upstream);
            if (state.error) {
              throw Object.assign(
                new Error("qwen failed the turn: " + (state.error.message || state.error.code)),
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
