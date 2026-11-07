/**
 * 协议桥：OpenAI Chat Completions ↔ 端砚 Orbit protocol 2.0。
 *
 * magpie 把 agent 的请求统一转成 Chat Completions 交给 loader.fetch；
 * 对 Orbit 通道的模型，这里把请求体改写成 Orbit 2.0，并把 Orbit SSE
 * （thinking_delta / content_delta / tool_use_* / usage / message_end）
 * 还原成 Chat Completions 的流式（或非流式）响应。
 *
 * 只依赖 Web 标准 API（Bun / Node 22 均可运行）。
 */
import { CLIENT_VERSION } from "./constants.mjs";

const MAX_ORBIT_TOOLS = 64; // 实测 >64 会被云端拒收
const OFF_EFFORTS = new Set(["off", "none", "disabled"]);
const AUTH_RE = /登录|token|session|auth|过期|失效|凭据|unauthor/i;
const QUOTA_RE = /墨点|额度|quota|insufficient|credit|balance|余额|耗尽/i;

function uuid() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/* ------------------------------------------------------------------ *
 * 请求：Chat Completions → Orbit 2.0
 * ------------------------------------------------------------------ */

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = [];
    for (const part of value) {
      if (typeof part === "string") parts.push(part);
      else if (part && ["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.join("\n");
  }
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return "";
}

function toolResultText(content) {
  const text = textOf(content);
  if (text) return text;
  if (Array.isArray(content) && content.length) {
    try {
      return JSON.stringify(content);
    } catch {
      return "(no output)";
    }
  }
  if (content === null || content === undefined || content === "") return "(no output)";
  return String(content);
}

function usedToolNames(messages) {
  const names = new Set();
  for (const message of messages) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      const name = call?.function?.name ?? call?.name;
      if (name) names.add(String(name));
    }
  }
  return names;
}

function toolsOf(body, usedNames) {
  const list = [];
  const seen = new Set();
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const fn = tool?.function && typeof tool.function === "object" ? tool.function : tool;
    const name = String(fn?.name ?? "").trim().slice(0, 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const parameters = fn?.parameters ?? fn?.input_schema;
    list.push({
      name,
      description: typeof fn?.description === "string" ? fn.description.slice(0, 4096) : "",
      input_schema: parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? parameters
        : { type: "object", properties: {} },
    });
  }
  if (list.length <= MAX_ORBIT_TOOLS) return list;
  const preferred = list.filter((item) => usedNames.has(item.name) || item.name === "web_search");
  const rest = list.filter((item) => !preferred.includes(item));
  return [...preferred, ...rest].slice(0, MAX_ORBIT_TOOLS);
}

/**
 * 连续同 role 才合并；但 Orbit/Anthropic 不允许同一条 user 里同时出现
 * text 与 tool_result，遇到就另起一条消息（并行工具结果仍可合并）。
 */
function pushBlocks(out, role, blocks) {
  if (!blocks.length) return;
  const previous = out.at(-1);
  const hasResult = (arr) => arr.some((block) => block?.type === "tool_result");
  const hasText = (arr) => arr.some((block) => block?.type === "text");
  const mix = previous?.role === role && (
    (hasResult(previous.content) && hasText(blocks)) ||
    (hasText(previous.content) && hasResult(blocks))
  );
  if (previous?.role === role && !mix) previous.content.push(...blocks);
  else out.push({ role, content: [...blocks] });
}

export function toOrbitBody({ body, chatId, canonicalId, supportsThinking }) {
  const b = body && typeof body === "object" ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const system = [];
  const out = [];

  for (const message of messages) {
    const role = String(message?.role ?? "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = textOf(message?.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "assistant") {
      const blocks = [];
      const text = textOf(message?.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        const id = String(call?.id ?? "");
        const name = String(call?.function?.name ?? call?.name ?? "");
        if (!id || !name) continue;
        let input = call?.function?.arguments ?? call?.arguments ?? {};
        if (typeof input === "string") {
          try {
            input = input ? JSON.parse(input) : {};
          } catch {
            input = {};
          }
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
        blocks.push({ type: "tool_use", id, name, input });
      }
      if (blocks.length) pushBlocks(out, "assistant", blocks);
      continue;
    }
    if (role === "tool") {
      const id = String(message?.tool_call_id ?? message?.toolCallId ?? "");
      if (!id) continue;
      pushBlocks(out, "user", [{
        type: "tool_result",
        tool_use_id: id,
        content: toolResultText(message?.content),
        is_error: message?.is_error === true || message?.isError === true,
      }]);
      continue;
    }
    // user / 其它：只取文本（端砚 supports_attachments=false，图片块丢弃）
    const text = textOf(message?.content);
    if (text) pushBlocks(out, "user", [{ type: "text", text }]);
  }

  const effort = String(b.reasoning_effort ?? b.reasoning?.effort ?? "").toLowerCase();
  const explicitOff = OFF_EFFORTS.has(effort) || b.thinking?.type === "disabled";
  const max = [b.max_tokens, b.max_completion_tokens, b.max_output_tokens]
    .map((n) => Number(n))
    .find((n) => Number.isSafeInteger(n) && n > 0);

  const result = {
    protocol_version: "2.0",
    request_id: uuid().toLowerCase(),
    inference_kind: "detached",
    inference_id: uuid().toLowerCase(),
    chat_id: chatId,
    model: String(canonicalId || b.model || ""),
    system,
    messages: out.length ? out : [{ role: "user", content: [{ type: "text", text: "" }] }],
    tools: toolsOf(b, usedToolNames(messages)),
    tool_choice: { type: "auto" },
    thinking: { enabled: supportsThinking === true && !explicitOff },
    metadata: { locale: "zh", client_version: CLIENT_VERSION },
  };
  if (max) result.max_output_tokens = max;
  if (Number.isFinite(Number(b.temperature)) && b.temperature !== null && b.temperature !== undefined) {
    result.temperature = Number(b.temperature);
  }
  if (Number.isFinite(Number(b.top_p)) && b.top_p !== null && b.top_p !== undefined) {
    result.top_p = Number(b.top_p);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 响应：Orbit SSE → Chat Completions
 * ------------------------------------------------------------------ */

export function errorResponse(status, message, { signIn, type = "api_error", code } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (signIn) headers["X-Magpie-Sign-In"] = signIn;
  return new Response(
    JSON.stringify({ error: { message: String(message || "请求失败"), type, code } }),
    { status, headers },
  );
}

function errorForEvent(err) {
  const msg = String(err?.message || "端砚流错误");
  if (err?.code === "AUTH_EXPIRED" || AUTH_RE.test(msg)) {
    return errorResponse(401, msg, { signIn: "expired", type: "authentication_error", code: err?.code });
  }
  if (QUOTA_RE.test(msg)) return errorResponse(429, msg, { type: "rate_limit_error", code: err?.code });
  if (err?.retryable) return errorResponse(503, msg, { type: "api_error", code: err?.code });
  return errorResponse(400, msg, { type: "invalid_request_error", code: err?.code });
}

export function upstreamErrorToResponse(error) {
  const msg = String(error?.message || "端砚请求失败");
  const code = error?.code ? String(error.code) : undefined;
  if (error?.authExpired === true || Number(error?.status) === 401 || (!error?.quota && AUTH_RE.test(msg) && /登录|失效|过期|session|token/i.test(msg))) {
    return errorResponse(401, msg, { signIn: "expired", type: "authentication_error", code });
  }
  if (error?.quota === true || Number(error?.status) === 402) {
    return errorResponse(429, msg, { type: "rate_limit_error", code });
  }
  if (error?.retryable === true || Number(error?.status) >= 500) {
    return errorResponse(502, msg, { type: "api_error", code });
  }
  return errorResponse(400, msg, { type: "invalid_request_error", code });
}

function parseFrame(frame) {
  let eventName = "";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  if (!event.type && eventName) event = { ...event, type: eventName };
  return event;
}

async function* orbitEvents(response, signal) {
  if (!response?.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const event = parseFrame(buf);
      if (event) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function newState() {
  return {
    id: `chatcmpl-${uuid()}`,
    created: Math.floor(Date.now() / 1000),
    textParts: [],
    tools: new Map(),
    toolOrder: [],
    nextToolIndex: 0,
    usage: null,
    stopReason: "end_turn",
    sawContent: false,
    error: null,
  };
}

function toolOf(state, key) {
  let tool = state.tools.get(key);
  if (!tool) {
    tool = { index: state.nextToolIndex++, id: key || `call_${uuid().slice(0, 12)}`, name: "", args: "", sawDelta: false };
    state.tools.set(key, tool);
    state.toolOrder.push(tool);
  }
  return tool;
}

function chunk(model, state, delta, finish = null, usage = null) {
  const row = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) row.usage = usage;
  return row;
}

/** 把一个 Orbit 事件映射成若干 Chat Completions chunk（纯函数式状态机）。 */
function mapEvent(event, state, model) {
  const type = String(event?.type ?? "");
  if (type === "error") {
    state.error = {
      message: String(event.message || event.msg || "端砚流错误"),
      code: String(event.code ?? ""),
      retryable: event.retryable === true,
    };
    return [];
  }
  if (type === "thinking_delta" && typeof event.text === "string" && event.text) {
    state.sawContent = true;
    return [chunk(model, state, { reasoning_content: event.text })];
  }
  if (type === "content_delta" && typeof event.text === "string" && event.text) {
    state.sawContent = true;
    state.textParts.push(event.text);
    return [chunk(model, state, { content: event.text })];
  }
  if (type === "tool_use_start") {
    state.sawContent = true;
    const key = String(event.id ?? "");
    const tool = toolOf(state, key);
    if (event.id) tool.id = String(event.id);
    if (event.name) tool.name = String(event.name);
    return [chunk(model, state, {
      tool_calls: [{ index: tool.index, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }],
    })];
  }
  if (type === "tool_input_delta") {
    state.sawContent = true;
    const key = String(event.id ?? "");
    const tool = toolOf(state, key);
    if (event.id) tool.id = String(event.id);
    const part = String(event.partial_json ?? "");
    if (!part) return [];
    tool.args += part;
    tool.sawDelta = true;
    return [chunk(model, state, { tool_calls: [{ index: tool.index, function: { arguments: part } }] })];
  }
  if (type === "tool_use_end") {
    state.sawContent = true;
    const tool = state.tools.get(String(event.id ?? ""));
    if (tool && !tool.sawDelta && event.input && typeof event.input === "object") {
      try {
        const json = JSON.stringify(event.input);
        tool.args = json;
        return [chunk(model, state, { tool_calls: [{ index: tool.index, function: { arguments: json } }] })];
      } catch {
        /* ignore */
      }
    }
    return [];
  }
  if (type === "usage") {
    const u = event.usage && typeof event.usage === "object" ? event.usage : event;
    const input = Number(u.input_tokens) || 0;
    const output = Number(u.output_tokens) || 0;
    state.usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
    return [];
  }
  if (type === "message_end") {
    state.stopReason = String(event.stop_reason ?? "end_turn");
    return [];
  }
  // message_start / ping / 未知事件
  return [];
}

function finishReasonOf(stopReason) {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function finalChunk(model, state) {
  return chunk(model, state, {}, finishReasonOf(state.stopReason), state.usage);
}

function fullCompletion(model, state) {
  const toolCalls = state.toolOrder.map((tool) => ({
    id: tool.id,
    type: "function",
    function: { name: tool.name, arguments: tool.args || "{}" },
  }));
  const message = {
    role: "assistant",
    content: state.textParts.length ? state.textParts.join("") : (toolCalls.length ? null : ""),
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(state.stopReason) }],
    usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Orbit SSE Response → Chat Completions Response。
 * 先缓冲到第一个内容事件：如果厂商在开头就报 error，可以返回真正的非 2xx，
 * 让 magpie 的 401/429/5xx 故障切换生效；已经开流之后只能发错误 chunk。
 */
export async function orbitResponse(response, { model, stream = true, signal } = {}) {
  const state = newState();
  const events = orbitEvents(response, signal);
  const closeEvents = async () => {
    try {
      await events.return?.();
    } catch {
      /* ignore */
    }
  };
  const pending = [];

  try {
    while (true) {
      const { done, value } = await events.next();
      if (done) break;
      pending.push(...mapEvent(value, state, model));
      if (state.error || state.sawContent) break;
    }
  } catch (error) {
    await closeEvents();
    return errorResponse(502, String(error?.message || error), { type: "api_error" });
  }

  if (state.error && !state.sawContent) {
    await closeEvents();
    return errorForEvent(state.error);
  }
  if (!state.sawContent && !state.toolOrder.length) {
    await closeEvents();
    return errorResponse(502, "书生·端砚返回了空响应", { type: "api_error" });
  }

  // 非流式：继续读完，用累计状态拼完整响应。
  if (!stream) {
    try {
      while (true) {
        const { done, value } = await events.next();
        if (done) break;
        mapEvent(value, state, model);
        if (state.error) return errorForEvent(state.error);
      }
    } catch (error) {
      return errorResponse(502, String(error?.message || error), { type: "api_error" });
    } finally {
      await closeEvents();
    }
    if (!state.sawContent && !state.toolOrder.length) {
      return errorResponse(502, "书生·端砚返回了空响应", { type: "api_error" });
    }
    return new Response(JSON.stringify(fullCompletion(model, state)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 流式：不能带 content-length / content-encoding（正文被重写过）。
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const row of pending) controller.enqueue(encoder.encode(sseFrame(row)));
        while (true) {
          const { done, value } = await events.next();
          if (done) break;
          const rows = mapEvent(value, state, model);
          for (const row of rows) controller.enqueue(encoder.encode(sseFrame(row)));
          if (state.error) {
            controller.enqueue(encoder.encode(sseFrame({
              error: { message: state.error.message, type: "api_error" },
            })));
            return;
          }
        }
        controller.enqueue(encoder.encode(sseFrame(finalChunk(model, state))));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        controller.enqueue(encoder.encode(sseFrame({
          error: { message: String(error?.message || error), type: "api_error" },
        })));
      } finally {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        await closeEvents();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}
