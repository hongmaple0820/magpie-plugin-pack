// TRAE CN / Global (ByteDance AI IDE) as magpie providers.
//
// TRAE's agent endpoint /api/agent/v3/llm_utils_chat is not
// OpenAI-compatible in either direction. constants.mjs rewrites the request
// into the SOLO shape; here the SOLO event stream (event: output / done /
// error / token_usage) is projected back onto OpenAI SSE, and drained into a
// single completion for non-streaming callers.
//
// Credentials are pasted from a logged-in IDE: the access token is sent in
// four headers at once, and uid / machineId / deviceId are the device
// identity the gateway checks — without uid the request is rejected
// outright. The channel (function) is the escape hatch: solo_agent covers
// the widest model set by default.
// (F:/maple/ChatLink/src/main/providers/builtin/trae.ts:6-20,
//  F:/maple/ChatLink/src/main/proxy/adapters/trae.ts:117-228,360-469)

import {
  regionOf,
  modelRows,
  stripModel,
  clientHeaders,
  toSoloBody,
  CHAT_PATH,
} from "./constants.mjs";
import { fetchCatalog, pairFor } from "./catalog.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function credsOf(auth) {
  const meta = auth?.metadata ?? {};
  return {
    uid: String(meta?.uid ?? auth?.uid ?? "").trim(),
    machineId: String(meta?.machineId ?? auth?.machineId ?? "").trim(),
    deviceId: String(meta?.deviceId ?? auth?.deviceId ?? "").trim(),
    channel: String(meta?.channel ?? auth?.channel ?? "").trim(),
    api: String(meta?.api ?? auth?.api ?? "").trim(),
  };
}

const trimSlash = (v) => v.replace(/\/+$/, "");

/**
 * 账号记录里的 api 不一定是模型主机：国际版把用量放在 api-sg-central /
 * api-us-east，把账号放在 grow-*，模型只在 coresg-*（新加坡）/ coreva-*（美国）。
 * 直接拿 api 当 chat 主机，上游会回一张 404 网页（实测 trae-global）。
 * 映射照社区 index.mjs:189-199 的 apiOf。
 */
function chatBaseOf(api, region) {
  const value = typeof api === "string" ? api.trim() : "";
  if (!value) return region.chatBase;
  let host = "";
  try {
    host = new URL(value).hostname;
  } catch {
    return region.chatBase;
  }
  if (/^coreva/i.test(host) || /^api-us/i.test(host)) return region.usChatBase ?? region.chatBase;
  if (/^coresg/i.test(host)) return trimSlash(value);
  if (/^(api[-.]|grow)/i.test(host)) return region.chatBase;
  return trimSlash(value);
}

function expired(realm) {
  return Object.assign(new Error(realm + ": the sign-in has expired, paste a new IDE token"), {
    status: 401,
    signIn: "expired",
  });
}

function errorResponse(realm, error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "trae_error",
      },
    }),
    { status, headers },
  );
}

// ---- SOLO SSE -> OpenAI SSE projection -------------------------------------

function normalizeToolCall(call) {
  if (typeof call !== "object" || call === null) return call;
  const copy = { ...call };
  if (typeof copy.function_call === "object" && copy.function_call !== null) {
    copy.function = { ...copy.function_call };
    delete copy.function_call;
  }
  if (typeof copy.function === "object" && copy.function !== null) {
    delete copy.function.namespace;
    delete copy.function.partial_arguments;
  }
  return copy;
}

function parseFrame(event, data) {
  let raw = null;
  if (typeof data === "string" && data.length > 0) {
    try {
      raw = JSON.parse(data);
    } catch {
      /* a frame that is not JSON carries nothing we can use */
    }
  } else if (data && typeof data === "object") {
    raw = data;
  }
  const name =
    String(event ?? "").trim() ||
    (raw && typeof raw === "object" ? String(raw.event ?? raw.type ?? "").trim() : "");
  if (!name) return null;

  const out = { event: name };
  if (!raw || typeof raw !== "object") return out;
  switch (name) {
    case "output":
      if (typeof raw.response === "string") out.response = raw.response;
      if (typeof raw.reasoning_content === "string") out.reasoning_content = raw.reasoning_content;
      if (Array.isArray(raw.tool_calls)) out.tool_calls = raw.tool_calls.map(normalizeToolCall);
      break;
    case "token_usage":
      out.usage = raw;
      break;
    case "done":
      if (typeof raw.finish_reason === "string") out.finish_reason = raw.finish_reason;
      break;
    case "error":
      out.error_code = typeof raw.code === "number" ? raw.code : null;
      out.error_message = typeof raw.message === "string" ? raw.message : null;
      break;
    default:
      break;
  }
  return out;
}

// Reads {event, data} pairs off the SOLO stream. A frame whose event line is
// missing falls back to the data JSON's own event/type field, as the
// community plugin's parser does (index.mjs:1584-1620).
async function* soloFrames(upstream) {
  if (!upstream?.body) return;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data = [];

  const flush = () => {
    if (data.length === 0) return null;
    const frame = parseFrame(event, data.join("\n"));
    event = "";
    data = [];
    return frame;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (!line) {
          const frame = flush();
          if (frame) yield frame;
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          const frame = flush();
          if (frame) yield frame;
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
    const frame = flush();
    if (frame) yield frame;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function chunkLine(id, model, delta, finish, usage) {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  };
  if (usage !== undefined) payload.usage = usage;
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function project(upstream, model) {
  const encoder = new TextEncoder();
  const id = "chatcmpl-trae-" + Date.now().toString(36);
  return new ReadableStream({
    async start(controller) {
      let finished = false;
      let usage;
      const enqueue = (text) => controller.enqueue(encoder.encode(text));
      try {
        for await (const frame of soloFrames(upstream)) {
          if (frame.event === "output") {
            const delta = {};
            if (typeof frame.response === "string" && frame.response.length > 0) delta.content = frame.response;
            if (typeof frame.reasoning_content === "string" && frame.reasoning_content.length > 0) {
              delta.reasoning_content = frame.reasoning_content;
            }
            if (Array.isArray(frame.tool_calls) && frame.tool_calls.length > 0) delta.tool_calls = frame.tool_calls;
            if (Object.keys(delta).length > 0) enqueue(chunkLine(id, model, delta));
          } else if (frame.event === "token_usage") {
            if (frame.usage && typeof frame.usage === "object") usage = frame.usage;
          } else if (frame.event === "done") {
            finished = true;
            enqueue(chunkLine(id, model, {}, frame.finish_reason || "stop", usage));
            enqueue("data: [DONE]\n\n");
            break;
          } else if (frame.event === "error") {
            finished = true;
            enqueue(
              "data: " +
                JSON.stringify({
                  error: {
                    message: frame.error_message || "TRAE upstream error",
                    type: "upstream_error",
                    code: frame.error_code ?? null,
                  },
                }) +
                "\n\n",
            );
            enqueue("data: [DONE]\n\n");
            break;
          }
        }
        if (!finished) {
          // finish_reason arrives on a done frame; a stream that ends without
          // one still gets a terminal chunk, otherwise clients hang.
          enqueue(chunkLine(id, model, {}, "stop", usage));
          enqueue("data: [DONE]\n\n");
        }
      } catch (error) {
        enqueue(
          "data: " +
            JSON.stringify({ error: { message: String(error?.message ?? error), type: "upstream_error" } }) +
            "\n\n",
        );
        enqueue("data: [DONE]\n\n");
      } finally {
        controller.close();
      }
    },
  });
}

// Drains the SOLO stream into one OpenAI completion for non-streaming
// callers. reasoning_content is preserved: dropping it would strip the trace
// TRAE's thinking models put in a separate field.
async function drain(upstream, model) {
  const id = "chatcmpl-trae-" + Date.now().toString(36);
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage;
  let errorMessage = "";
  const toolCalls = [];

  for await (const frame of soloFrames(upstream)) {
    if (frame.event === "output") {
      if (typeof frame.response === "string") content += frame.response;
      if (typeof frame.reasoning_content === "string") reasoning += frame.reasoning_content;
      if (Array.isArray(frame.tool_calls)) {
        for (const call of frame.tool_calls) {
          if (typeof call !== "object" || call === null) continue;
          const index = typeof call.index === "number" ? call.index : toolCalls.length;
          const merged = toolCalls[index] ?? { index, id: call.id, type: "function", function: {} };
          if (call.id) merged.id = call.id;
          const fn = call.function;
          if (typeof fn === "object" && fn !== null) {
            if (typeof fn.name === "string" && fn.name.length > 0) merged.function.name = fn.name;
            if (typeof fn.arguments === "string") {
              merged.function.arguments = (merged.function.arguments || "") + fn.arguments;
            }
          }
          toolCalls[index] = merged;
        }
      }
    } else if (frame.event === "token_usage") {
      if (frame.usage && typeof frame.usage === "object") usage = frame.usage;
    } else if (frame.event === "done") {
      if (frame.finish_reason) finishReason = frame.finish_reason;
    } else if (frame.event === "error") {
      errorMessage = frame.error_message || "TRAE upstream error";
    }
  }

  if (errorMessage && content.length === 0 && toolCalls.length === 0) {
    throw Object.assign(new Error(errorMessage), { status: 502 });
  }

  const message = { role: "assistant", content };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  const calls = toolCalls.filter(Boolean);
  if (calls.length > 0) {
    message.tool_calls = calls;
    if (finishReason === "stop") finishReason = "tool_calls";
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage !== undefined ? { usage } : {}),
  };
}

// ---- the two plugins --------------------------------------------------------

const PROMPTS = {
  "trae-cn": [
    { key: "uid", type: "text", message: "UID（必填，缺 uid 网关直接拒绝）", placeholder: "IDE DevTools 请求头里的 X-Uid" },
    { key: "machineId", type: "text", message: "Machine ID（可选）", placeholder: "X-Machine-Id" },
    { key: "deviceId", type: "text", message: "Device ID（可选）", placeholder: "X-Device-Id" },
    { key: "channel", type: "text", message: "Routing channel（可选）", placeholder: "默认 solo_agent；模型在流里报 4001 时换 solo_work_lite / solo_coder" },
    { key: "api", type: "text", message: "API 域覆盖（可选）", placeholder: "默认 https://trae-api-cn.mchost.guru" },
  ],
  "trae-global": [
    { key: "uid", type: "text", message: "UID（必填，缺 uid 网关直接拒绝）", placeholder: "IDE DevTools 请求头里的 X-Uid" },
    { key: "machineId", type: "text", message: "Machine ID（可选）", placeholder: "X-Machine-Id" },
    { key: "deviceId", type: "text", message: "Device ID（可选）", placeholder: "X-Device-Id" },
    { key: "channel", type: "text", message: "Routing channel（可选）", placeholder: "默认 solo_agent；模型在流里报 4001 时换 solo_work_lite / solo_coder" },
    { key: "api", type: "text", message: "API 域覆盖（可选）", placeholder: "默认 https://coresg-normal.trae.ai（SG）；US 账户填 https://coreva-normal.trae.ai" },
  ],
};

function makePlugin(regionId) {
  const region = regionOf(regionId);
  const rows = modelRows(regionId);

  return async () => ({
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[regionId] ??= {};
      const provider = cfg.provider[regionId];
      provider.name ??= region.name;
      provider.npm ??= region.npm;
      provider.api ??= region.chatBase;
      // Ours last: a provider record magpie already had must not overwrite
      // the list this plugin serves.
      provider.models = { ...(provider.models ?? {}), ...rows };
    },

    provider: {
      id: regionId,
      async models(provider, { auth } = {}) {
        const fallback = provider?.models ?? rows;
        const token = tokenOf(auth);
        if (!token) return fallback;
        const creds = credsOf(auth);
        if (!creds.uid) return fallback;
        let catalog;
        try {
          catalog = await fetchCatalog(region, chatBaseOf(creds.api, region), token, creds);
        } catch {
          // 目录拿不到就退回静态表：登录后第一次失败不该让列表空掉。
          return fallback;
        }
        if (!catalog?.length) return fallback;
        const base = provider?.models ?? {};
        const out = {};
        for (const pair of catalog) {
          const id = pair.configName;
          if (out[id]) continue;
          out[id] = {
            ...(base[id] ?? {}),
            id,
            name: pair.name || id,
            tool_call: true,
            reasoning: true,
          };
        }
        return out;
      },
    },

    auth: {
      provider: regionId,
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "粘贴 IDE 令牌 + 设备身份",
          placeholder: "Cloud-IDE-JWT（eyJ…）",
          prompts: PROMPTS[regionId],
        },
      ],

      async loader(getAuth) {
        return {
          baseURL: region.chatBase,
          apiKey: "",
          async fetch(input, init) {
            const request = new Request(input, init);
            try {
              const path = new URL(request.url).pathname;
              if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
                throw Object.assign(
                  new Error(regionId + ": " + request.method + " " + path + " is not served by this provider"),
                  { status: 404 },
                );
              }

              // Read the account per request: magpie refreshes it between
              // requests, and a credential captured when the loader was built
              // would be the one before the refresh.
              const auth = await getAuth();
              const token = tokenOf(auth);
              if (!token) throw expired(region.name);
              const creds = credsOf(auth);
              if (!creds.uid) {
                throw Object.assign(
                  new Error(region.name + ": uid 缺失（X-Uid）— 重新粘贴令牌并填写 UID，取法见 README"),
                  { status: 400 },
                );
              }

              const body = await request.json();
              const model = stripModel(regionId, body?.model);
              // 静态表只用于展示：账号真实目录随订阅变（trae-cn 实测 90 个），
              // 未枚举的模型放行给上游判断，本地 404 会让新模型永远不可用。
              body.model = model;

              // 模型必须走到「列了它的那个 function」，config_name 也取账号目录里的
              // 那一项：静态猜的 channel 上游会回 "the param is invalid"。
              let catalog = null;
              try {
                catalog = await fetchCatalog(region, chatBaseOf(creds.api, region), token, creds, {
                  signal: request.signal,
                });
              } catch {
                /* 目录拉不到就按静态 channel 试一次 */
              }
              const pair = pairFor(catalog, model);
              const solo = toSoloBody(body, {
                channel: pair?.function ?? creds.channel,
                config: pair?.configName ?? model,
              });
              const upstream = await fetch(chatBaseOf(creds.api, region) + CHAT_PATH, {
                method: "POST",
                headers: clientHeaders(region, token, creds),
                body: JSON.stringify(solo),
                ...(request.signal ? { signal: request.signal } : {}),
              });

              if (!upstream.ok) {
                const text = await upstream.text().catch(() => "");
                const out = new Headers(upstream.headers);
                out.delete("content-length");
                out.delete("content-encoding");
                // No refresh token to renew with: a 401 marks the account
                // expired; any other status says the sign-in is fine to keep.
                out.set("x-magpie-sign-in", upstream.status === 401 ? "expired" : "kept");
                return new Response(text, { status: upstream.status, headers: out });
              }

              const okHeaders = { "x-magpie-sign-in": "kept" };
              if (body.stream === true) {
                return new Response(project(upstream, model), {
                  status: 200,
                  headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache",
                    ...okHeaders,
                  },
                });
              }

              const completion = await drain(upstream, model);
              return Response.json(completion, { headers: okHeaders });
            } catch (error) {
              return errorResponse(region.name, error);
            }
          },
        };
      },
    },
  });
}

export const TraeGlobalPlugin = makePlugin("trae-global");
export const TraeCnPlugin = makePlugin("trae-cn");
