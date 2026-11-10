// Kimi (www.kimi.com) as a magpie provider.
//
// The chat call is gRPC-Web: a framed JSON request, a stream of framed JSON
// replies. Everything else -- the OpenAI shape a client expects -- is this
// plugin's job to build.

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
  requestBody,
} from "./constants.mjs";
import { encodeFrame, FrameDecoder } from "./frame.mjs";
import { newState, foldMessage, completionBody } from "./stream.mjs";
import { webLoginMethod } from "../weblogin/index.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired() {
  return Object.assign(new Error("Kimi: the sign-in has expired, paste a new access token"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "kimi_error",
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

async function* framesOf(response) {
  if (!response?.body) return;
  const reader = response.body.getReader();
  const decoder = new FrameDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const payload of decoder.push(value)) {
      if (!payload.trim()) continue;
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
        for await (const data of framesOf(upstream)) {
          const grew = foldMessage(state, data);
          if (state.error) break;
          if (!wroteRole && (grew.text || grew.reasoning)) {
            controller.enqueue(encoder.encode(chunkText(model, { role: "assistant" })));
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

export const KimiPlugin = async () => ({
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
        channel: "kimi",
        label: "一键登录（弹出浏览器自动抓取，推荐）",
      }),

      {
        type: "api",
        label: "粘贴 Kimi 访问令牌",
        placeholder: "eyJ…（或 refresh_token，二者都可用于换取会话）",
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
                new Error("kimi: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const token = tokenOf(await getAuth());
            if (!token) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model) || "kimi-k3";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("kimi: no such model: " + model), { status: 404 });
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("kimi: the request named no messages"), { status: 400 });
            }

            const lowered = model.toLowerCase();
            const thinking = lowered.includes("think") || lowered.includes("r1");
            const search = lowered.includes("search");
            const framed = encodeFrame(
              JSON.stringify(requestBody(flatten(body.messages), { thinking, search })),
            );

            const upstream = await fetch(API_BASE + CHAT_PATH, {
              method: "POST",
              headers: {
                ...CLIENT_HEADERS,
                "Content-Type": "application/connect+json",
                Authorization: "Bearer " + token,
              },
              body: framed,
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

            const state = newState();
            for await (const data of framesOf(upstream)) {
              foldMessage(state, data);
              if (state.error) break;
            }
            if (state.error) {
              throw Object.assign(
                new Error("kimi failed the turn: " + JSON.stringify(state.error).slice(0, 300)),
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
