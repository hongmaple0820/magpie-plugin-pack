// Qwen AI is stateful: a conversation is created first, then a message is
// posted into it. A one-shot request therefore costs two calls.

import { randomUUID } from "node:crypto";
import { API_BASE, NEW_CHAT_PATH, clientHeaders } from "./constants.mjs";

function authHeaders(token, cookieJar) {
  const out = {
    ...clientHeaders(),
    Authorization: "Bearer " + token,
    // 裸 Bearer 会被阿里 WAF 拦成挑战页（实测 2026-11-10）：必须带整套浏览器
    // cookie；ChatLink 同款 X-Request-Id 每请求一个 UUID。
    "X-Request-Id": randomUUID(),
  };
  if (cookieJar) out.Cookie = cookieJar;
  return out;
}

export async function createChat(token, model, fetcher = fetch, signal, cookieJar) {
  const response = await fetcher(API_BASE + NEW_CHAT_PATH, {
    method: "POST",
    headers: authHeaders(token, cookieJar),
    body: JSON.stringify({
      title: "New Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
      project_id: "",
    }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("Qwen AI refused the token"), { status: 401, signIn: "expired" });
  }
  if (!response.ok) {
    throw Object.assign(new Error("Qwen AI answered HTTP " + response.status + " creating a chat"), { status: 502 });
  }
  const body = await response.json().catch(() => undefined);
  const id = body?.data?.id ?? body?.id;
  if (typeof id !== "string" || !id) {
    throw Object.assign(new Error("Qwen AI created no chat id"), { status: 502 });
  }
  return id;
}

/** The web app takes one user message per turn; the transcript is written into it. */
export function flatten(messages) {
  const systems = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : "";
    const text = content.trim();
    if (!text) continue;
    if (message?.role === "system") systems.push(text);
    else turns.push((message?.role === "assistant" ? "Assistant: " : "User: ") + text);
  }
  const parts = [];
  if (systems.length) parts.push(systems.join("\n\n"));
  parts.push(...turns);
  return parts.join("\n\n");
}

export function messageBody({ chatId, model, content, thinking }) {
  const fid = randomUUID();
  const childId = randomUUID();
  const stamp = Math.floor(Date.now() / 1000);
  return {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [childId],
        role: "user",
        content,
        user_action: "chat",
        files: [],
        timestamp: stamp,
        models: [model],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: thinking,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: thinking,
          thinking_format: "summary",
          auto_search: false,
        },
        extra: { meta: { subChatType: "t2t" } },
        sub_chat_type: "t2t",
        parent_id: null,
      },
    ],
    timestamp: stamp + 1,
  };
}

export async function postMessage(token, body, fetcher = fetch, signal, cookieJar) {
  return fetcher(API_BASE + "/api/v2/chat/completions?chat_id=" + encodeURIComponent(body.chat_id), {
    method: "POST",
    headers: authHeaders(token, cookieJar),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}
