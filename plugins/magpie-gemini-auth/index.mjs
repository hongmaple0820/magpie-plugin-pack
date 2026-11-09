// Gemini Code Assist as a magpie provider.
//
// Three things have to be right or the gateway refuses: the v1internal
// envelope, the client identity headers, and a model name carrying a tier.
// The access token lasts an hour, so a refresh token is not optional.

import {
  ID,
  NAME,
  NPM,
  ENDPOINT_DAILY,
  STREAM_PATH,
  IDENTITY_HEADERS,
  DEFAULT_PROJECT,
  modelRows,
  resolveModel,
} from "./lib/constants.mjs";
import { credOf, isExpired, refresh, probeProject } from "./lib/credential.mjs";
import { newState, foldFrame, parseFrame, drain, completionBody } from "./lib/stream.mjs";
import { createHash } from "node:crypto";

const projectCache = new Map();

function expired(message) {
  return Object.assign(new Error(message || "gemini: sign in again"), { status: 401, signIn: "expired" });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "gemini_error",
      },
    }),
    { status, headers },
  );
}

function chunkText(model, delta, finish, usage) {
  return "data: " + JSON.stringify({
    id: "",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    ...(usage ? { usage } : {}),
  }) + "\n\n";
}

/** The web client names a conversation by a hash of its opening, so a retry reuses its cache. */
function sessionIdOf(project, firstUserText) {
  return createHash("sha256").update(project + "\u0000infer\u0000" + firstUserText).digest("hex").slice(0, 32);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
}

/** OpenAI messages to v1internal contents, consecutive same-role turns merged. */
export function contentsOf(messages) {
  const contents = [];
  const systems = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (message?.role === "system") {
      systems.push(text);
      continue;
    }
    const role = message?.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return { contents, systems };
}

async function* frames(response) {
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
      if (payload) yield payload;
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
        for await (const payload of frames(upstream)) {
          const grew = foldFrame(state, parseFrame(payload));
          if (!wroteRole && (grew.text || grew.reasoning)) {
            controller.enqueue(encoder.encode(chunkText(model, { role: "assistant" })));
            wroteRole = true;
          }
          if (grew.reasoning) controller.enqueue(encoder.encode(chunkText(model, { reasoning_content: grew.reasoning })));
          if (grew.text) controller.enqueue(encoder.encode(chunkText(model, { content: grew.text })));
        }
        controller.enqueue(encoder.encode(chunkText(model, {}, state.finishReason || "stop", state.usage)));
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

export const GeminiPlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[ID] ??= {};
    const provider = cfg.provider[ID];
    provider.name ??= NAME;
    provider.npm ??= NPM;
    provider.api ??= ENDPOINT_DAILY;
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
      {
        type: "api",
        label: "粘贴 Google 凭据 JSON",
        placeholder: '{"access_token":"…","refresh_token":"…","expiry":…}',
      },
    ],

    /** Renew the hour-long access token; the project travels with the account. */
    async refresh(auth) {
      const cred = credOf(auth);
      if (!cred) throw expired("gemini: paste the credential JSON again");
      try {
        const next = await refresh(cred);
        return {
          key: JSON.stringify({
            access_token: next.accessToken,
            refresh_token: next.refreshToken,
            expiry: next.expiry,
            ...(next.project ? { cloudaicompanionProject: next.project } : {}),
          }),
          ...(next.expiry ? { expires: next.expiry } : {}),
        };
      } catch (error) {
        if (error?.signIn) throw expired(error.message);
        throw error;
      }
    },

    async loader(getAuth) {
      return {
        baseURL: ENDPOINT_DAILY,
        apiKey: "",
        async fetch(input, init) {
          const request = new Request(input, init);
          try {
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw Object.assign(
                new Error("gemini: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }
            let cred = credOf(await getAuth());
            if (!cred?.accessToken) throw expired("gemini: paste the credential JSON");
            if (isExpired(cred)) cred = await refresh(cred);

            let projectId = cred.project || projectCache.get(cred.accessToken);
            if (!projectId) {
              projectId = (await probeProject(cred.accessToken)) || DEFAULT_PROJECT;
              projectCache.set(cred.accessToken, projectId);
            }

            const body = await request.json();
            const model = resolveModel(body?.model);
            const { contents, systems } = contentsOf(body?.messages);
            if (contents.length === 0) {
              throw Object.assign(new Error("gemini: the request had no content to send"), { status: 400 });
            }

            const maxOutputTokens = body.max_tokens ?? 64000;
            const inner = {
              contents,
              generationConfig: { maxOutputTokens, thinkingConfig: { includeThoughts: true } },
              sessionId: sessionIdOf(projectId, contents[0]?.parts?.[0]?.text ?? ""),
            };
            if (systems.length) inner.systemInstruction = { role: "system", parts: [{ text: systems.join("\n\n") }] };

            const envelope = { model, project: projectId, request: inner, userAgent: "antigravity" };

            const upstream = await fetch(ENDPOINT_DAILY + STREAM_PATH, {
              method: "POST",
              headers: { ...IDENTITY_HEADERS, Authorization: "Bearer " + cred.accessToken, "Content-Type": "application/json" },
              body: JSON.stringify(envelope),
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
