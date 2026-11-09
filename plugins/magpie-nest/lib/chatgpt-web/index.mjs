// ChatGPT's web app as a magpie provider.
//
// Not the OpenAI API: every conversation is behind a sentinel handshake, the
// reply is a patch stream over one message, and the transport is the biggest
// unknown -- the upstream may refuse a client whose TLS fingerprint is not a
// browser's. That risk is stated in the README rather than hidden.

import { randomUUID } from "node:crypto";
import { ID, NAME, NPM, BASE, modelRows, stripModel, FALLBACK_UA, DEFAULT_CLIENT_VERSION, DEFAULT_CLIENT_BUILD_NUMBER } from "./constants.mjs";
import { handshake, sentinelHeaders } from "./sentinel.mjs";
import { conversationPayload } from "./payload.mjs";
import { newState, foldEvent, payloadsOf, completionBody } from "./stream.mjs";

function credOf(auth) {
  const raw = auth?.key ?? auth?.credential ?? auth?.access ?? auth?.token;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return {
        accessToken: String(parsed.accessToken ?? parsed.access_token ?? ""),
        cookie: String(parsed.cookie ?? ""),
        deviceId: String(parsed.deviceId ?? ""),
        sessionId: String(parsed.sessionId ?? ""),
        userAgent: String(parsed.userAgent ?? ""),
        clientVersion: String(parsed.clientVersion ?? ""),
        clientBuildNumber: String(parsed.clientBuildNumber ?? ""),
        timezone: String(parsed.timezone ?? ""),
      };
    } catch {
      return undefined;
    }
  }
  return { accessToken: text, cookie: "", deviceId: "", sessionId: "", userAgent: "", clientVersion: "", clientBuildNumber: "", timezone: "" };
}

/** A device id must be stable per account: a fresh one per request is a tell. */
function deviceIdOf(cred, seed) {
  if (cred.deviceId) return cred.deviceId;
  return randomUUID();
}

function headersOf(cred, deviceId, sessionId) {
  const ua = cred.userAgent || FALLBACK_UA;
  const headers = {
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: BASE,
    referer: BASE + "/",
    "user-agent": ua,
    "sec-ch-ua": '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "oai-device-id": deviceId,
    "oai-session-id": sessionId,
    "oai-language": "zh-CN",
    "oai-client-version": cred.clientVersion || DEFAULT_CLIENT_VERSION,
    "oai-client-build-number": cred.clientBuildNumber || DEFAULT_CLIENT_BUILD_NUMBER,
  };
  if (cred.accessToken) headers.authorization = "Bearer " + cred.accessToken;
  if (cred.cookie) headers.cookie = cred.cookie;
  return headers;
}

function expired() {
  return Object.assign(new Error("ChatGPT: the sign-in has expired, paste a new token"), { status: 401, signIn: "expired" });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "chatgpt_web_error",
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

function project(upstream, model) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const state = newState();
      let wroteRole = false;
      try {
        for await (const payload of payloadsOf(upstream)) {
          const delta = foldEvent(state, payload);
          if (state.error) break;
          if (delta) {
            if (!wroteRole) {
              controller.enqueue(encoder.encode(chunkText(model, { role: "assistant" })));
              wroteRole = true;
            }
            controller.enqueue(encoder.encode(chunkText(model, { content: delta })));
          }
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

export const ChatGptWebPlugin = async () => ({
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
        label: "粘贴 ChatGPT access token（或整份凭据 JSON）",
        placeholder: "(await (await fetch('/api/auth/session')).json()).accessToken",
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
                new Error("chatgpt-web: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            const cred = credOf(await getAuth());
            if (!cred) throw expired();

            const body = await request.json();
            const model = stripModel(body?.model);
            if (!modelRows()[model]) {
              throw Object.assign(new Error("chatgpt-web: no such model: " + (model || "(none)")), { status: 404 });
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("chatgpt-web: the request named no messages"), { status: 400 });
            }

            const deviceId = deviceIdOf(cred);
            const sessionId = cred.sessionId || randomUUID();
            const headers = headersOf(cred, deviceId, sessionId);

            const ready = await handshake({
              base: BASE,
              token: cred.accessToken,
              headers,
              userAgent: cred.userAgent || FALLBACK_UA,
              ...(request.signal ? { signal: request.signal } : {}),
            });

            const upstream = await fetch(BASE + (cred.accessToken ? "/backend-api/conversation" : "/backend-anon/conversation"), {
              method: "POST",
              headers: { ...headers, ...sentinelHeaders(ready), accept: "text/event-stream" },
              body: JSON.stringify(conversationPayload(body.messages, model, cred)),
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
            for await (const payload of payloadsOf(upstream)) {
              foldEvent(state, payload);
              if (state.error) break;
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
