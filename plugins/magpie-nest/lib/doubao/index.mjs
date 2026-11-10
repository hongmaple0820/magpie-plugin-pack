// 豆包（www.doubao.com）作为 magpie 渠道：真实协议见 protocol.mjs 头注。
// 一键登录抓整套 cookie + 指纹 query，二者都随账号落库（cookieJar / fpQuery）。

import { ID, NAME, NPM, API_BASE, modelRows, stripModel } from "./constants.mjs";
import { CHAT_PATH, chatQuery, newConversationId, requestBody, clientHeaders, BOT_ID } from "./protocol.mjs";
import { newState, foldEvent } from "./stream.mjs";
import { webLoginMethod } from "../weblogin/index.mjs";

function sessionOf(auth) {
  const value = auth?.cookieJar ?? auth?.key ?? auth?.access ?? auth?.token ?? auth?.sessionId;
  return typeof value === "string" ? value.trim() : "";
}

function fpQueryOf(auth) {
  const raw = auth?.fpQuery;
  if (raw && typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function expired() {
  return Object.assign(new Error("豆包: 会话已过期，请用一键登录重新抓取"), {
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
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    }) +
    "\n\n"
  );
}

/** 把豆包 SSE 流投影成 OpenAI SSE。 */
function project(upstream, model) {
  const id = "chatcmpl-doubao-" + newConversationId();
  const state = newState();
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(chunkText(id, model, { role: "assistant" })));
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const idx = buffer.indexOf("\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const delta = foldEvent(state, line);
            if (delta) controller.enqueue(encoder.encode(chunkText(id, model, { content: delta })));
            if (state.error) throw Object.assign(new Error(state.error), { status: 502 });
          }
        }
        const tail = foldEvent(state, buffer);
        if (tail) controller.enqueue(encoder.encode(chunkText(id, model, { content: tail })));
        if (state.finished && state.endType === 3) {
          // 会话冲突：整轮重试成本太高，直接报错让 magpie 故障切换。
          throw Object.assign(new Error("豆包: 会话冲突（end_type=3），请重试"), { status: 502 });
        }
        controller.enqueue(encoder.encode(chunkText(id, model, {}, state.error ? "stop" : "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        controller.enqueue(encoder.encode(chunkText(id, model, {}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
}

/** 一次性读完整流（非流式请求）。 */
async function drain(upstream, model) {
  const state = newState();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // SSE 块以空行分隔，data 行可能很长；逐行喂 foldEvent 即可——它自己判断 event/data。
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      foldEvent(state, line);
    }
  }
  if (buffer.trim()) foldEvent(state, buffer);
  return new Response(
    JSON.stringify({
      id: "chatcmpl-doubao-" + newConversationId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: state.text || "" },
          finish_reason: state.error ? "stop" : "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 网页客户端每轮只发最后一条用户消息（历史由服务器按会话持有），单发即完整一轮。 */
function lastUserText(messages) {
  const text = (m) => {
    if (typeof m?.content === "string") return m.content;
    if (Array.isArray(m?.content)) {
      return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
    }
    return "";
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return text(messages[i]);
  }
  return text(messages[messages.length - 1]);
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
    maxConcurrency: 2,
    methods: [
      webLoginMethod({
        channel: "doubao",
        label: "一键登录（弹出浏览器自动抓取，推荐）",
      }),
      {
        type: "api",
        label: "粘贴豆包 Cookie",
        placeholder: "一键登录抓不到时，F12 → Network → 任一请求 → 复制整条 Cookie 头",
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
              throw Object.assign(new Error("doubao: " + request.method + " " + path + " is not served by this provider"), {
                status: 404,
              });
            }
            const auth = await getAuth();
            const cookieJar = sessionOf(auth);
            if (!cookieJar) throw expired();
            const fpQuery = fpQueryOf(auth);

            const body = await request.json();
            const model = stripModel(body?.model) || "doubao";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("doubao: no such model: " + model), { status: 404 });
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("doubao: the request named no messages"), { status: 400 });
            }

            // 每次都是全新会话（服务器按 cookie 识别账号；复用旧会话 ID 会
            // 收到 DOWNLINK pull_msg_notify + end_type=3）。
            const wire = requestBody({ text: lastUserText(body.messages) });
            const upstream = await fetch(API_BASE + CHAT_PATH + "?" + chatQuery(fpQuery), {
              method: "POST",
              headers: { ...clientHeaders(), Cookie: cookieJar },
              body: JSON.stringify(wire),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!upstream.ok) {
              const text = await upstream.text().catch(() => "");
              const out = new Headers(upstream.headers);
              out.delete("content-length");
              out.delete("content-encoding");
              if (upstream.status === 401) out.set("x-magpie-sign-in", "expired");
              return new Response(text, { status: upstream.status, headers: out });
            }

            if (body.stream === true) {
              return new Response(project(upstream, model), {
                status: 200,
                headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
              });
            }
            return await drain(upstream, model);
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },
  },
});
