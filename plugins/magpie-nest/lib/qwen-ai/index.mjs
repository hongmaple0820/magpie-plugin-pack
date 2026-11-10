// Qwen AI (chat.qwen.ai) as a magpie provider.
//
// Two calls per turn: the web app creates a conversation, then a message is
// posted into it and answered as a phased stream. The plugin hides both
// behind one OpenAI-compatible request.

import { ID, NAME, NPM, API_BASE, modelRows, stripModel } from "./constants.mjs";
import { createChat, flatten, messageBody, postMessage } from "./chat.mjs";
import { newState, foldChunk, drain, completionBody } from "./stream.mjs";
import { webLoginMethod } from "../weblogin/index.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Qwen AI: the sign-in has expired, paste a new token"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "qwen_ai_error",
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
      try {
        for await (const payload of iterate(upstream)) {
          if (payload === "[DONE]") break;
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const grew = foldChunk(state, parsed);
          if (grew.reasoning) controller.enqueue(encoder.encode(chunkText(model, { reasoning_content: grew.reasoning })));
          if (grew.text) controller.enqueue(encoder.encode(chunkText(model, { content: grew.text })));
          if (state.finished) break;
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

export const QwenAiPlugin = async () => ({
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
        channel: "qwen-ai",
        label: "一键登录（弹出浏览器自动抓取，推荐）",
      }),

      {
        type: "api",
        label: "粘贴 chat.qwen.ai 令牌",
        placeholder: "登录 chat.qwen.ai 后 F12 → Application → Local Storage → token",
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
                new Error("qwen-ai: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const auth = await getAuth();
            const token = tokenOf(auth);
            if (!token) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model);
            if (!modelRows()[model]) {
              throw Object.assign(new Error("qwen-ai: no such model: " + (model || "(none)")), { status: 404 });
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("qwen-ai: the request named no messages"), { status: 400 });
            }

            const cookieJar = String(auth?.cookieJar ?? "").trim();
            const chatId = await createChat(token, model, fetch, request.signal, cookieJar);
            const thinking = model.includes("think") || model.includes("r1");
            const message = messageBody({
              chatId,
              model,
              content: flatten(body.messages),
              thinking,
            });
            const upstream = await postMessage(token, message, fetch, request.signal, cookieJar);

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
