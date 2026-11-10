// GLM (Zhipu Qingyan's web app) as a magpie provider.
//
// The web app is not OpenAI-shaped: one endpoint takes a whole conversation
// flattened into a single user message, every request is signed, and the reply
// is a stream of cumulative parts rather than deltas.

import {
  ID,
  NAME,
  NPM,
  API_BASE,
  STREAM_PATH,
  ASSISTANT_ID,
  CLIENT_HEADERS,
  modelRows,
  stripModel,
} from "./constants.mjs";
import { randomUUID } from "node:crypto";
import { generateSign } from "./sign.mjs";
import { refreshTokenOf, exchangeRefreshToken } from "./token.mjs";
import { newState, foldEvent, ssePayloads, drain, completionBody } from "./stream.mjs";
import { webLoginMethod } from "../weblogin/index.mjs";

function expired() {
  return Object.assign(new Error("GLM: the sign-in has expired, paste a new refresh token"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "glm_error",
      },
    }),
    { status, headers },
  );
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .join("");
}

/**
 * The web app takes one user message, so the transcript is written into it:
 * system prompts first, then each turn labelled. The trailing "Assistant: " is
 * what the client sends to make the model answer rather than continue.
 */
export function flatten(messages) {
  const systems = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (message?.role === "system") systems.push(text);
    else turns.push((message?.role === "assistant" ? "Assistant: " : "User: ") + text);
  }
  const parts = [];
  if (systems.length) parts.push(systems.join("\n\n"));
  parts.push(...turns);
  return parts.join("\n\n") + "\n\nAssistant: ";
}

function bodyOf(model, messages) {
  return {
    assistant_id: ASSISTANT_ID,
    conversation_id: "",
    project_id: "",
    chat_type: "user_chat",
    messages: [{ role: "user", content: [{ type: "text", text: flatten(messages) }] }],
    meta_data: {
      channel: "",
      draft_id: "",
      if_plus_model: true,
      input_question_type: "xxxx",
      is_networking: false,
      is_test: false,
      platform: "pc",
      quote_log_id: "",
      cogview: { rm_label_watermark: false },
      ...(model === "glm-5.3" ? { chat_mode: "zero" } : {}),
    },
  };
}

/** One OpenAI SSE chunk. */
function chunk(model, delta, finish) {
  return "data: " + JSON.stringify({
    id: "",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }) + "\n\n";
}

/** Project GLM's parts stream into OpenAI chunks. */
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
            controller.enqueue(encoder.encode(chunk(model, { role: "assistant", content: "" })));
            wroteRole = true;
          }
          if (grew.reasoning) controller.enqueue(encoder.encode(chunk(model, { reasoning_content: grew.reasoning })));
          if (grew.text) controller.enqueue(encoder.encode(chunk(model, { content: grew.text })));
          if (state.finished) break;
        }
        controller.enqueue(encoder.encode(chunk(model, {}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify({ error: { message: String(error?.message ?? error) } }) + "\n\n"));
      } finally {
        controller.close();
      }
    },
  });
}

/** Line-by-line SSE payloads from a live body. */
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
  const rest = buffer.trim();
  if (rest.startsWith("data:")) {
    const payload = rest.slice(5).trim();
    if (payload) yield payload;
  }
}

export const GlmPlugin = async () => ({
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
        channel: "glm",
        label: "一键登录（弹出浏览器自动抓取，推荐）",
      }),

      {
        type: "api",
        label: "粘贴清言 refresh_token",
        placeholder: "登录 chatglm.cn 后 F12 → Application → Local Storage → chatglm_refresh_token",
      },
    ],

    /** Long-lived: the refresh token is the account; this only rotates the access token. */
    async refresh(auth) {
      const refreshToken = refreshTokenOf(auth);
      if (!refreshToken) throw expired();
      try {
        const entry = await exchangeRefreshToken(refreshToken);
        return { access: entry.access, refresh: entry.refresh, expires: entry.at + 55 * 60 * 1000 };
      } catch (error) {
        if (error?.signIn) throw expired();
        throw error;
      }
    },

    async loader(getAuth) {
      return {
        baseURL: API_BASE,
        apiKey: "",
        async fetch(input, init) {
          const request = new Request(input, init);
          try {
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw Object.assign(new Error("glm: " + request.method + " " + path + " is not served by this provider"), {
                status: 404,
              });
            }
            const auth = await getAuth();
            let access = typeof auth?.access === "string" ? auth.access.trim() : "";
            if (!access) {
              const refreshToken = refreshTokenOf(auth);
              if (!refreshToken) throw expired();
              access = (await exchangeRefreshToken(refreshToken)).access;
            }

            const body = await request.json();
            const model = stripModel(body?.model) || "glm-5";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("glm: no such model: " + model), { status: 404 });
            }

            const signature = generateSign();
            const upstream = await fetch(API_BASE + STREAM_PATH, {
              method: "POST",
              headers: {
                ...CLIENT_HEADERS,
                Authorization: "Bearer " + access,
                "X-Device-Id": randomUUID(),
                "X-Request-Id": randomUUID(),
                "X-Sign": signature.sign,
                "X-Timestamp": signature.timestamp,
                "X-Nonce": signature.nonce,
              },
              body: JSON.stringify(bodyOf(model, body?.messages)),
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
