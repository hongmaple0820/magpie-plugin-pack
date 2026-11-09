// DeepSeek web (chat.deepseek.com) as a magpie provider.
//
// Every write is PoW-gated, a conversation needs a session created first, and
// the reply is a patch stream. Those three are the whole plugin.

import {
  ID,
  NAME,
  NPM,
  BASE,
  COMPLETION_PATH,
  SESSION_CREATE_PATH,
  SESSION_DELETE_PATH,
  FALLBACK_UA,
  FALLBACK_CLIENT_VERSION,
  modelRows,
  stripModel,
  isThinkingModel,
  promptOf,
} from "./lib/constants.mjs";
import { powHeaderOf } from "./lib/pow.mjs";
import { newState, foldEvent, drain, completionBody } from "./lib/stream.mjs";

/** The account carries a token and, optionally, the anti-bot extras. */
export function credOf(auth) {
  const raw = auth?.key ?? auth?.credential ?? auth?.access ?? auth?.token;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return {
        token: String(parsed.token ?? parsed.access_token ?? ""),
        cookie: String(parsed.cookie ?? ""),
        hifDliq: String(parsed.hifDliq ?? parsed["x-hif-dliq"] ?? ""),
        hifLeim: String(parsed.hifLeim ?? parsed["x-hif-leim"] ?? ""),
        userAgent: String(parsed.userAgent ?? ""),
        clientVersion: String(parsed.clientVersion ?? ""),
      };
    } catch {
      return undefined;
    }
  }
  return { token: text, cookie: "", hifDliq: "", hifLeim: "", userAgent: "", clientVersion: "" };
}

function headersOf(cred, referer) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "x-client-platform": "web",
    "x-client-version": cred.clientVersion || FALLBACK_CLIENT_VERSION,
    "user-agent": cred.userAgent || FALLBACK_UA,
    "content-type": "application/json",
    origin: BASE,
    referer: referer || BASE + "/",
    authorization: "Bearer " + cred.token,
  };
  if (cred.cookie) headers.cookie = cred.cookie;
  if (cred.hifDliq) headers["x-hif-dliq"] = cred.hifDliq;
  if (cred.hifLeim) headers["x-hif-leim"] = cred.hifLeim;
  return headers;
}

function expired() {
  return Object.assign(new Error("DeepSeek: the sign-in has expired, paste a new token"), {
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
        type: error?.signIn === "expired" ? "authentication_error" : "deepseek_error",
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
        for await (const event of events(upstream)) {
          const grew = foldEvent(state, event);
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

async function createSession(headers, fetcher, signal) {
  const response = await fetcher(BASE + SESSION_CREATE_PATH, {
    method: "POST",
    headers,
    body: "{}",
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401 || response.status === 403) throw expired();
  if (!response.ok) {
    throw Object.assign(new Error("deepseek: the session was refused (HTTP " + response.status + ")"), { status: 502 });
  }
  const body = await response.json().catch(() => undefined);
  const id = body?.data?.biz_data?.chat_session?.id;
  if (typeof id !== "string" || !id) {
    throw Object.assign(new Error("deepseek: the session answer carried no id"), { status: 502 });
  }
  return id;
}

function deleteSession(headers, sessionId, fetcher) {
  // Best effort: a conversation left behind costs nothing but clutter.
  fetcher(BASE + SESSION_DELETE_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({ chat_session_id: sessionId }),
  }).catch(() => {});
}

export const DeepSeekWebPlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[ID] ??= {};
    const provider = cfg.provider[ID];
    provider.name ??= NAME;
    provider.npm ??= NPM;
    provider.api ??= BASE;
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
        label: "粘贴 DeepSeek 令牌（或整份凭据 JSON）",
        placeholder: "裸 token，或 {\"token\":\"…\",\"cookie\":\"…\"}",
      },
    ],

    async loader(getAuth) {
      return {
        baseURL: BASE,
        apiKey: "",
        async fetch(input, init) {
          const request = new Request(input, init);
          try {
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw Object.assign(
                new Error("deepseek-web: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const cred = credOf(await getAuth());
            if (!cred?.token) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model) || "deepseek-chat";
            if (!modelRows()[model]) {
              throw Object.assign(new Error("deepseek-web: no such model: " + model), { status: 404 });
            }
            const prompt = promptOf(body?.messages);
            if (!prompt) {
              throw Object.assign(new Error("deepseek-web: the request named no messages"), { status: 400 });
            }

            const headers = headersOf(cred);
            const powHeader = await powHeaderOf(headers, COMPLETION_PATH);
            const sessionId = await createSession(headers, fetch, request.signal);

            const upstream = await fetch(BASE + COMPLETION_PATH, {
              method: "POST",
              headers: {
                ...headersOf(cred, BASE + "/a/chat/s/" + sessionId),
                accept: "text/event-stream",
                "x-ds-pow-response": powHeader,
              },
              body: JSON.stringify({
                chat_session_id: sessionId,
                // Every call is a new session with the whole transcript, so the
                // message is a root: no parent chain to walk.
                parent_message_id: null,
                prompt,
                ref_file_ids: [],
                thinking_enabled: isThinkingModel(model),
                search_enabled: false,
                model_type: "default",
                action: null,
                preempt: false,
              }),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!upstream.ok) {
              const text = await upstream.text().catch(() => "");
              deleteSession(headers, sessionId, fetch);
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
            deleteSession(headers, sessionId, fetch);
            return Response.json(completionBody(state, model));
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },
  },
});
