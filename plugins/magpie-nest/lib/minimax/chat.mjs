// MiniMax 推理通道：OpenAI Chat Completions ↔ Anthropic Messages (SSE)。
//
// 参考实现：
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-messages.ts
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-adapter.ts
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax.ts
//
// 上游：POST {apiHost}/mavis/api/v1/llm/v1/messages (Anthropic Messages, stream=true, SSE)
// magpie 侧：@ai-sdk/openai-compatible 期望 Chat Completions 形态的 Request/Response

import { randomUUID } from "node:crypto";
import { MINIMAX_INFER_PATH, SITE, modelEntry, stripModel } from "./constants.mjs";

const INFER_URL = `${SITE.api}${MINIMAX_INFER_PATH}`;
const ADAPTIVE_ONLY_PREFIX = "MiniMax-M3.1";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired(message) {
  return Object.assign(new Error(message), { status: 401, signIn: "expired" });
}

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "minimax_error",
      },
    }),
    { status, headers },
  );
}

function uuid() {
  return randomUUID();
}

// ---------- OpenAI -> Anthropic 消息转换 ----------

function textBlock(text) {
  return { type: "text", text };
}

function imageBlock(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) throw new Error("minimax: unsupported image_url format (need a data:image/...;base64 URL)");
  return {
    type: "image",
    source: { type: "base64", media_type: match[1], data: match[2] },
  };
}

function openAiContentToBlocks(content) {
  if (typeof content === "string") return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock(String(content ?? ""))];
  return content.map((c) => {
    if (c.type === "text") return textBlock(c.text ?? "");
    if (c.type === "image_url") return imageBlock(c.image_url?.url ?? "");
    return textBlock(JSON.stringify(c));
  });
}

function assistantToBlocks(msg) {
  const blocks = [];
  if (msg.content && (typeof msg.content !== "string" || msg.content.length > 0)) {
    blocks.push(...openAiContentToBlocks(msg.content));
  }
  for (const tc of msg.tool_calls ?? []) {
    if (tc.type !== "function" || !tc.function?.name) continue;
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments ?? "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: tc.id ?? uuid(), name: tc.function.name, input });
  }
  return blocks;
}

/**
 * OpenAI messages → Anthropic messages。
 * Anthropic 硬规则：tool_result 块必须和它上游的 assistant(tool_use) 相邻，
 * 所以「assistant 工具调用 → 一批 tool 结果」要压缩成 assistant 消息后紧跟
 * 一条 user 消息承载全部 tool_result。
 */
export function buildAnthropicMessages(openaiMessages) {
  const out = [];
  let pendingToolResults = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const msg of openaiMessages ?? []) {
    if (!msg || typeof msg.role !== "string") continue;

    if (msg.role === "system" || msg.role === "developer") continue;

    if (msg.role === "assistant") {
      flushToolResults();
      const blocks = assistantToBlocks(msg);
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: openAiContentToBlocks(msg.content),
        is_error: false,
      });
      continue;
    }

    if (msg.role === "user") {
      const blocks = openAiContentToBlocks(msg.content);
      if (pendingToolResults.length > 0) {
        // 用户消息直接跟在工具结果后面：把 tool_result 合并进这条 user 消息，
        // 避免连发两条 user（Anthropic 2013）。
        out.push({ role: "user", content: [...pendingToolResults, ...blocks] });
        pendingToolResults = [];
      } else {
        out.push({ role: "user", content: blocks });
      }
      continue;
    }
    // 未知角色一律跳过
  }
  flushToolResults();
  return out;
}

// ---------- thinking 决策表 ----------
//
// DSH 只会送来 magpie 梯队词（none/low/medium/high/xhigh/max）：
// 插件声明的 variants 键是这些词，值被 magpie 丢弃，所以「开/关」两态模型的
// 「开」只能借用 high 这个键，这里再翻译回上游要的形态。
//
//   effort 值        M3.1（adaptive 强制）        M3（switchable，无档位）      M2.7（forced_on）
//   undefined        thinking adaptive            不发（=不思考）               不发
//   none             thinking adaptive（disabled 会 400）  thinking disabled    不发
//   low..max         adaptive + output_config     thinking adaptive（不带档位）  不发
function thinkingPatch(modelKey, effort) {
  const value = typeof effort === "string" && effort.trim() !== "" ? effort.trim() : undefined;
  const adaptiveOnly = modelKey.startsWith(ADAPTIVE_ONLY_PREFIX);
  const entry = modelEntry(modelKey);
  const hasEffortOptions = (entry?.vendorEfforts ?? []).length > 0;
  const forcedOn = entry?.alwaysThinks === true;

  if (forcedOn && !adaptiveOnly && !hasEffortOptions) {
    // M2.7 系：强制思考且没有档位 —— 不发 thinking，也不能给 none（上游会静默忽略）。
    return undefined;
  }

  const wantsOff = value === "none";
  if (wantsOff) {
    // M3.1 传 disabled 会硬 400（2013），只能退回 adaptive。
    return adaptiveOnly ? { thinking: { type: "adaptive" } } : { thinking: { type: "disabled" } };
  }

  if (hasEffortOptions) {
    // 有真档位：adaptive + 根级 output_config（⚠️ 不是塞进 thinking 里）。
    return {
      thinking: { type: "adaptive" },
      ...(value !== undefined ? { outputConfig: { effort: value } } : {}),
    };
  }

  if (adaptiveOnly) {
    // M3.1 强制 adaptive，远端没有档位（理论上不会走到，防御性保留）。
    return { thinking: { type: "adaptive" } };
  }

  if (value !== undefined) {
    // switchable 无档位（M3）：任何表态都只是「开」，不带 output_config。
    return { thinking: { type: "adaptive" } };
  }
  // M3 不发 thinking = 不思考（服务端默认）。
  return undefined;
}

export function buildAnthropicPayload(modelKey, openaiChat) {
  const messages = buildAnthropicMessages(openaiChat.messages);
  const system = (openaiChat.messages ?? [])
    .filter((m) => m?.role === "system" && m?.content)
    .map((m) => String(m.content))
    .join("\n\n");

  const payload = {
    model: modelKey,
    stream: true,
    messages,
    ...(system ? { system } : {}),
    ...(openaiChat.temperature !== undefined ? { temperature: openaiChat.temperature } : {}),
    ...(openaiChat.max_tokens !== undefined
      ? { max_tokens: openaiChat.max_tokens }
      : openaiChat.max_completion_tokens !== undefined
        ? { max_tokens: openaiChat.max_completion_tokens }
        : {}),
    ...(openaiChat.stop !== undefined
      ? { stop_sequences: Array.isArray(openaiChat.stop) ? openaiChat.stop : [openaiChat.stop] }
      : {}),
  };

  if (Array.isArray(openaiChat.tools) && openaiChat.tools.length > 0) {
    payload.tools = openaiChat.tools
      .filter((t) => t.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
  }

  const patch = thinkingPatch(modelKey, openaiChat.reasoning_effort);
  if (patch?.thinking) payload.thinking = patch.thinking;
  if (patch?.outputConfig) payload.output_config = patch.outputConfig;

  return payload;
}

// ---------- Anthropic SSE -> OpenAI chunk 事件 ----------

function mapStopReason(reason) {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "stop";
  return "stop";
}

function parseSseData(rawLine) {
  if (rawLine.startsWith("event:")) return { kind: "event" };
  if (!rawLine.startsWith("data:")) return null;
  const data = rawLine.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return { kind: "frame", frame: JSON.parse(data) };
  } catch {
    return null;
  }
}

/**
 * 消费 Anthropic SSE，产出 OpenAI 语义事件：
 *   {type:"reasoning", delta}
 *   {type:"text", delta}
 *   {type:"tool_call", id, name, arguments}        （首次：带 id/name）
 *   {type:"tool_call_delta", id, argumentsDelta}   （后续：只带参数增量）
 *   {type:"usage", usage}
 *   {type:"finish", reason}
 */
export async function* consumeAnthropicSse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawAnyChunk = false;
  let stopReason = null;
  let usage = null;
  const blocks = new Map();

  function handleFrame(frame) {
    const chunks = [];
    const type = frame?.type;

    if (type === "message_start") {
      const u = frame.message?.usage;
      if (u) {
        usage = {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: u.input_tokens ?? 0,
          prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        };
      }
      return chunks;
    }

    if (type === "ping") return chunks;

    if (type === "content_block_start") {
      const block = frame.content_block ?? {};
      const index = frame.index;
      blocks.set(index, { type: block.type, text: "", toolId: block.id, toolName: block.name, toolArgs: "" });
      if (block.type === "thinking") {
        sawAnyChunk = true;
        chunks.push({ type: "reasoning", delta: "" });
      } else if (block.type === "text") {
        sawAnyChunk = true;
        chunks.push({ type: "text", delta: "" });
      } else if (block.type === "tool_use") {
        sawAnyChunk = true;
        chunks.push({ type: "tool_call", id: block.id, name: block.name, arguments: "" });
      }
      return chunks;
    }

    if (type === "content_block_delta") {
      const delta = frame.delta ?? {};
      const index = frame.index;
      const state = blocks.get(index);
      if (!state) return chunks;
      if (delta.type === "thinking_delta") {
        state.text += delta.thinking ?? "";
        chunks.push({ type: "reasoning", delta: delta.thinking ?? "" });
      } else if (delta.type === "text_delta") {
        state.text += delta.text ?? "";
        chunks.push({ type: "text", delta: delta.text ?? "" });
      } else if (delta.type === "input_json_delta") {
        state.toolArgs += delta.partial_json ?? "";
        chunks.push({ type: "tool_call_delta", id: state.toolId, argumentsDelta: delta.partial_json ?? "" });
      }
      // signature_delta 必须忽略（thinking 签名，非正文）
      return chunks;
    }

    if (type === "content_block_stop") {
      blocks.delete(frame.index);
      return chunks;
    }

    if (type === "message_delta") {
      const delta = frame.delta ?? {};
      if (delta.stop_reason) stopReason = delta.stop_reason;
      if (frame.usage) {
        usage = {
          prompt_tokens: usage?.prompt_tokens ?? 0,
          completion_tokens: frame.usage.output_tokens ?? 0,
          total_tokens: (usage?.prompt_tokens ?? 0) + (frame.usage.output_tokens ?? 0),
          prompt_tokens_details: usage?.prompt_tokens_details ?? { cached_tokens: 0 },
          completion_tokens_details: {
            reasoning_tokens: frame.usage.output_tokens_details?.thinking_tokens ?? 0,
          },
        };
      }
      return chunks;
    }

    if (type === "message_stop") return chunks;

    if (type === "error") {
      const err = frame.error ?? {};
      throw new Error(`minimax: ${err.message ?? JSON.stringify(err)}`);
    }

    return chunks;
  }

  function handleLine(line) {
    const parsed = parseSseData(line);
    if (!parsed) return [];
    if (parsed.kind === "event") return [];
    return handleFrame(parsed.frame);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer) {
          const lines = buffer.split("\n");
          for (const line of lines) {
            for (const chunk of handleLine(line)) yield chunk;
          }
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const chunk of handleLine(line)) yield chunk;
      }
      if (signal?.aborted) {
        throw Object.assign(new Error("minimax: aborted"), { status: 499 });
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }

  if (!sawAnyChunk) {
    throw new Error("minimax: 模型未返回任何内容块");
  }

  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: mapStopReason(stopReason) };
}

// ---------- OpenAI SSE chunk 编码 ----------

function chunkJson(model, delta, finishReason = null, extra = {}) {
  return {
    id: `chatcmpl-${uuid()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

function encodeChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function* streamToOpenAI(events, servedName) {
  yield encodeChunk(chunkJson(servedName, { role: "assistant", content: "" }));

  for await (const ev of events) {
    if (ev.type === "text") {
      yield encodeChunk(chunkJson(servedName, { content: ev.delta }));
    } else if (ev.type === "reasoning") {
      yield encodeChunk(chunkJson(servedName, { reasoning_content: ev.delta }));
    } else if (ev.type === "tool_call") {
      yield encodeChunk(chunkJson(servedName, {
        tool_calls: [{
          index: 0,
          id: ev.id,
          type: "function",
          function: { name: ev.name, arguments: ev.arguments },
        }],
      }));
    } else if (ev.type === "tool_call_delta") {
      yield encodeChunk(chunkJson(servedName, {
        tool_calls: [{ index: 0, function: { arguments: ev.argumentsDelta } }],
      }));
    } else if (ev.type === "finish") {
      yield encodeChunk(chunkJson(servedName, {}, ev.reason, {}));
    }
  }
  yield "data: [DONE]\n\n";
}

// ---------- 主导出 ----------

export async function ask(openaiChat, cred, init, site) {
  const token = tokenOf(cred);
  if (!token) throw expired("minimax: 未登录或登录已过期，请重新登录");

  const modelKey = stripModel(openaiChat?.model);
  if (!modelKey) throw Object.assign(new Error("minimax: 请求没带 model"), { status: 400 });

  const entry = modelEntry(modelKey);
  const payload = buildAnthropicPayload(modelKey, openaiChat);

  let res;
  try {
    res = await fetch(INFER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: init?.signal,
    });
  } catch (e) {
    throw Object.assign(new Error(`minimax: upstream request failed: ${e?.message ?? e}`), { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 402) {
      return errorResponse({ status: 402, message: "minimax: 余额不足，请前往官网充值", signIn: "kept" });
    }
    if (res.status === 401 || res.status === 403) {
      return errorResponse({ status: res.status, message: text || "minimax: 认证失败，请重新登录", signIn: "expired" });
    }
    return errorResponse({ status: res.status, message: text || `minimax: HTTP ${res.status}` });
  }

  if (!res.body) {
    return errorResponse({ status: 502, message: "minimax: 响应缺少 body" });
  }

  const servedName = entry.name ?? modelKey;
  const events = consumeAnthropicSse(res, init?.signal);

  if (openaiChat?.stream === false) {
    let content = "";
    let reasoning = "";
    const toolCalls = new Map(); // index -> {id,name,args}
    let finalUsage = null;
    let finishReason = "stop";

    for await (const ev of events) {
      if (ev.type === "text") content += ev.delta;
      else if (ev.type === "reasoning") reasoning += ev.delta;
      else if (ev.type === "tool_call") {
        toolCalls.set(0, { id: ev.id, name: ev.name, args: ev.arguments });
      } else if (ev.type === "tool_call_delta") {
        const cur = toolCalls.get(0) ?? { id: ev.id ?? "", name: "", args: "" };
        cur.id = cur.id || ev.id || "";
        cur.args += ev.argumentsDelta;
        toolCalls.set(0, cur);
      } else if (ev.type === "usage") finalUsage = ev.usage;
      else if (ev.type === "finish") finishReason = ev.reason;
    }

    const message = {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.size > 0
        ? {
            tool_calls: [...toolCalls.values()].map((t) => ({
              index: 0,
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: t.args },
            })),
          }
        : {}),
    };

    return new Response(
      JSON.stringify({
        id: `chatcmpl-${uuid()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: servedName,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        ...(finalUsage ? { usage: finalUsage } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const body = streamToOpenAI(events, servedName);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}