// The conversation payload the web client sends.
//
// The field set is part of the protocol: a missing one is read as an invalid
// client, so nothing here is optional sugar.

import { randomUUID } from "node:crypto";

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
      : "";

/** OpenAI messages to the conversation payload's message list. */
export function conversationMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = textOf(message?.content);
    if (!text) continue;
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user";
    out.push({ id: randomUUID(), author: { role }, content: { content_type: "text", parts: [text] } });
  }
  return out;
}

export function conversationPayload(messages, model, cred, timezoneOffsetMin = -480) {
  return {
    action: "next",
    messages: conversationMessages(messages),
    model,
    parent_message_id: randomUUID(),
    conversation_mode: { kind: "primary_assistant" },
    conversation_origin: null,
    force_paragen: false,
    force_paragen_model_slug: "",
    force_rate_limit: false,
    force_use_sse: true,
    history_and_training_disabled: true,
    reset_rate_limits: false,
    suggestions: [],
    supported_encodings: [],
    system_hints: [],
    timezone: cred.timezone || "Asia/Shanghai",
    timezone_offset_min: timezoneOffsetMin,
    variant_purpose: "comparison_implicit",
    websocket_request_id: randomUUID(),
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 120,
      page_height: 900,
      page_width: 1400,
      pixel_ratio: 2,
      screen_height: 1440,
      screen_width: 2560,
      app_name: "chatgpt.com",
    },
  };
}
