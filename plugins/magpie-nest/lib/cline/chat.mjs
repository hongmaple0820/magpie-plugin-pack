// Cline 推理通道：OpenAI Chat Completions 原样透传（上游本来就是这套协议）。
//
// 参考实现：
//   - F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\cline-adapter.ts
//   - F:\maple\ChatLink\src\main\providers\builtin\cline.ts
//
// 只做三件事，别的一律不碰：
//   1. 思考增量搬家：上游/ChatLink 给的是 `delta.reasoning`，本仓库与 DSH 只读
//      `delta.reasoning_content` → 补写一个同值字段并删掉旧键（免得双份）。
//   2. 工具 schema 清洗：递归删掉 enum 里的空字符串成员（清完为空则整个删掉
//      enum 键）。Gemini 系上游见到 enum:[""] 会 400。
//   3. 错误分类：401/403 且不是地域限制 → 登录过期；402/429 → 保留（可换号）。
//
// ⚠️ 不校验 reasoning_effort：上游对不认识的档位静默忽略（'banana' → 200 且 0 思考）。

import { CHAT_PATH, CLIENT_HEADERS, SITE, stripModel } from "./constants.mjs";
import { withTokenPrefix } from "./login.mjs";

/** OFM cline-adapter.ts / ChatLink 的 401/403 地域限制文案。 */
const REGION_MARKERS = [
  "not available in your region",
  "access forbidden",
  "region not supported",
  "not available in your country",
];

const CREDIT_MARKERS = [
  "insufficient credits",
  "out of credits",
  "credit limit",
  "payment required",
  "usage limit",
];

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
        type: error?.signIn === "expired" ? "authentication_error" : "cline_error",
      },
    }),
    { status, headers },
  );
}

// ---------- 工具 schema 清洗 ----------

/**
 * 递归删掉 enum 里的空字符串成员；清完为空就把整个 enum 键删掉。
 * 数字/布尔枚举原样保留（OFM sanitizeClineToolParameters 的行为）。
 */
export function sanitizeParameters(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeParameters);
  if (typeof schema !== "object" || schema === null) return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" && Array.isArray(value)) {
      const kept = value.filter((item) => !(typeof item === "string" && item === ""));
      if (kept.length > 0) out.enum = kept;
      // 清完为空：整个键丢掉（不是留 enum: []）
      continue;
    }
    out[key] = sanitizeParameters(value);
  }
  return out;
}

function sanitizeTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  if (tool.type !== "function" || !tool.function || typeof tool.function !== "object") return tool;
  const parameters = tool.function.parameters;
  if (typeof parameters !== "object" || parameters === null) return tool;
  return {
    ...tool,
    function: { ...tool.function, parameters: sanitizeParameters(parameters) },
  };
}

// ---------- reasoning → reasoning_content ----------

/** 就地把 delta/message 里的 reasoning 搬到 reasoning_content。 */
export function rewriteReasoning(holder) {
  if (!holder || typeof holder !== "object") return holder;
  const reasoning = holder.reasoning;
  if (typeof reasoning === "string" && reasoning !== "" && holder.reasoning_content === undefined) {
    holder.reasoning_content = reasoning;
  }
  if ("reasoning" in holder) delete holder.reasoning;
  return holder;
}

/** 重写一个 chunk / 完整响应：choices[].delta 与 choices[].message 都搬。 */
export function rewriteChunk(chunk) {
  if (!chunk || typeof chunk !== "object" || !Array.isArray(chunk.choices)) return chunk;
  for (const choice of chunk.choices) {
    if (!choice || typeof choice !== "object") continue;
    if (choice.delta) rewriteReasoning(choice.delta);
    if (choice.message) rewriteReasoning(choice.message);
  }
  return chunk;
}

/**
 * 重写一行 SSE。不是 data: 行、[DONE]、或解析不出来的原样返回。
 * 逐行处理而不是整体 parse：上游帧可能很大，且必须保留空行做事件分隔。
 */
export function rewriteSseLine(line) {
  if (!line.startsWith("data:")) return line;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return line;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return line;
  }
  return `data: ${JSON.stringify(rewriteChunk(frame))}`;
}

async function* rewriteStream(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const line of buffer.split("\n")) yield `${rewriteSseLine(line)}\n`;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield `${rewriteSseLine(line)}\n`;
      if (signal?.aborted) {
        throw Object.assign(new Error("cline: aborted"), { status: 499 });
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }
}

// ---------- 主导出 ----------

export async function ask(openaiChat, cred, init, site = SITE) {
  const token = withTokenPrefix(tokenOf(cred));
  if (!token) throw expired("cline: 未登录或登录已过期，请重新登录");

  const model = stripModel(openaiChat?.model);
  if (!model) throw Object.assign(new Error("cline: 请求没带 model"), { status: 400 });

  const body = { ...openaiChat, model };
  if (Array.isArray(body.tools)) body.tools = body.tools.map(sanitizeTool);
  const wantsStream = body.stream === true;

  let res;
  try {
    res = await fetch(`${site.api}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: wantsStream ? "text/event-stream" : "application/json",
        ...CLIENT_HEADERS,
      },
      body: JSON.stringify(body),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  } catch (error) {
    throw Object.assign(new Error(`cline: 上游请求失败: ${error?.message ?? error}`), { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const lower = text.toLowerCase();

    if (res.status === 401 || res.status === 403) {
      // 403 有两种：地域限制（留着这套凭证没用，也不该判过期）与登录失效。
      if (REGION_MARKERS.some((marker) => lower.includes(marker))) {
        return errorResponse({
          status: 403,
          message: `cline: 本地区不可用（上游原话: ${text || "region blocked"}）`,
          signIn: "kept",
        });
      }
      return errorResponse({
        status: res.status,
        message: text || "cline: 认证失败，请重新登录",
        signIn: "expired",
      });
    }

    if (res.status === 402 || res.status === 429) {
      const credit = CREDIT_MARKERS.some((marker) => lower.includes(marker));
      return errorResponse({
        status: res.status,
        message: `cline: ${credit ? "额度用尽" : "限流或额度不足"}（上游原话: ${text || `HTTP ${res.status}`}）`,
        signIn: "kept",
      });
    }

    return errorResponse({ status: res.status, message: text || `cline: HTTP ${res.status}` });
  }

  if (wantsStream) {
    if (!res.body) return errorResponse({ status: 502, message: "cline: 响应缺少 body" });
    return new Response(rewriteStream(res.body, init?.signal), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  const payload = await res.json().catch(() => undefined);
  if (payload === undefined) {
    return errorResponse({ status: 502, message: "cline: 上游响应不是 JSON" });
  }
  return new Response(JSON.stringify(rewriteChunk(payload)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
