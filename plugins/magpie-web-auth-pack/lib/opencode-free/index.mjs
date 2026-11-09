// OpenCode's keyless lane as a magpie provider: no account, no key.
//
// Three things the gate fingerprints, all of them here because none is
// optional: a v2 user agent, four session headers carrying one canonical
// session id, and the CLI's own read/shell tool definitions in the request.

import {
  ID,
  NAME,
  NPM,
  API_BASE,
  CHAT_PATH,
  ANON_KEY,
  UA,
  modelRows,
  baseModelId,
  isKnownModel,
} from "./constants.mjs";
import { canonicalizeSession } from "./session.mjs";
import { applyFingerprint, withNote } from "./fingerprint.mjs";
import { aggregate, completionBody } from "./sse.mjs";

const SESSION_HEADER = "x-magpie-session";

/** One conversation, one upstream session: minting per request burns its quota. */
const sessions = new Map();

function sessionFor(seed) {
  const key = String(seed ?? "").trim() || "global";
  const remembered = sessions.get(key);
  if (remembered) return remembered;
  const minted = canonicalizeSession(key);
  if (sessions.size > 512) sessions.delete(sessions.keys().next().value);
  sessions.set(key, minted);
  return minted;
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({ error: { message: String(error?.message ?? error), type: "opencode_free_error" } }),
    { status, headers },
  );
}

export const OpencodeFreePlugin = async () => ({
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
      {
        // Nothing to type and nothing to open: the lane takes no credential.
        // It is still an account, so magpie has something to route to.
        type: "oauth",
        label: "启用匿名免费通道（无需登录、无需输入）",
        authorize: () => ({
          url: "",
          instructions: [
            "这一条通道不需要账号也不需要密钥：它用的是上游公开的匿名池。",
            "点确定即可，几秒后账号会自动出现在列表里。",
            "若请求返回 401/403，通常是该模型已在免费池之外，换一个模型即可。",
          ].join("\n"),
          method: "auto",
          callback: async () => ({
            type: "success",
            access: ANON_KEY,
            accountId: "anonymous",
          }),
        }),
      },
    ],

    async loader() {
      return {
        baseURL: API_BASE,
        apiKey: ANON_KEY,
        async fetch(input, init) {
          const request = new Request(input, init);
          try {
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw Object.assign(
                new Error("opencode-free: " + request.method + " " + path + " is not served by this provider"),
                { status: 404 },
              );
            }

            const body = await request.json();
            const model = baseModelId(body?.model);
            if (!isKnownModel(model)) {
              throw Object.assign(
                new Error("opencode-free: " + (model || "(no model)") + " is not in the free pool"),
                { status: 404 },
              );
            }
            if (!Array.isArray(body?.messages) || body.messages.length === 0) {
              throw Object.assign(new Error("opencode-free: the request named no messages"), { status: 400 });
            }

            const { tools, toolChoice, injected } = applyFingerprint(body.tools, body.tool_choice);
            const seed = request.headers.get(SESSION_HEADER) || "global";
            const session = sessionFor(seed);
            const streaming = body.stream === true;

            const upstreamBody = {
              model,
              messages: withNote(body.messages, injected),
              stream: true,
              tools,
              ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
              ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
              ...(body.stop !== undefined ? { stop: body.stop } : {}),
              ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
              ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
            };

            const upstream = await fetch(API_BASE + CHAT_PATH, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + ANON_KEY,
                "user-agent": UA,
                "x-opencode-client": "cli",
                "x-opencode-session": session,
                "x-opencode-session-id": session,
                "x-session-affinity": session,
                "x-session-id": session,
                "x-opencode-project": "global",
                accept: streaming ? "text/event-stream" : "*/*",
              },
              body: JSON.stringify(upstreamBody),
              ...(request.signal ? { signal: request.signal } : {}),
            });

            if (!upstream.ok) {
              const text = await upstream.text().catch(() => "");
              const out = new Headers(upstream.headers);
              out.delete("content-length");
              out.delete("content-encoding");
              return new Response(text, { status: upstream.status, headers: out });
            }

            if (streaming) {
              const out = new Headers();
              out.set("content-type", "text/event-stream; charset=utf-8");
              out.set("cache-control", "no-cache");
              return new Response(upstream.body, { status: 200, headers: out });
            }

            const state = await aggregate(upstream);
            if (state.error) {
              throw Object.assign(
                new Error("opencode-free failed the turn: " + JSON.stringify(state.error).slice(0, 300)),
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
