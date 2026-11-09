// Doubao answers in numbered events: 2001 carries content, 2003 ends the turn.
//
// Each 2001 event wraps its own JSON in event_data; the message content inside
// it is itself JSON, and the text is one of a few shapes depending on the
// client version -- so it is read defensively rather than assumed.

export function newState() {
  return { text: "", conversationId: "", finished: false, error: undefined };
}

/** The text one event contributes, or "". */
export function textOfMessage(message) {
  if (!message?.content) return "";
  try {
    const parsed = JSON.parse(message.content);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.text === "string") return parsed.text;
    if (typeof parsed?.delta?.text === "string") return parsed.delta.text;
    if (typeof parsed?.content === "string") return parsed.content;
    return "";
  } catch {
    return typeof message.content === "string" ? message.content : "";
  }
}

/** Fold one event, answering the text it carries. */
export function foldEvent(state, raw) {
  if (raw?.code) {
    state.error = { code: raw.code, message: raw.message ?? "" };
    return "";
  }
  if (raw?.event_type === 2003) {
    state.finished = true;
    return "";
  }
  if (raw?.event_type !== 2001) return "";

  let payload;
  try {
    payload = JSON.parse(raw.event_data);
  } catch {
    return "";
  }
  if (!state.conversationId && payload?.conversation_id) state.conversationId = String(payload.conversation_id);
  if (payload?.is_finish) {
    state.finished = true;
    return "";
  }
  const text = textOfMessage(payload?.message);
  if (!text) return "";
  state.text += text;
  return text;
}

export async function readAll(response) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

export function sseData(text) {
  const out = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") out.push(payload);
  }
  return out;
}

export async function drain(response) {
  const state = newState();
  for (const payload of sseData(await readAll(response))) {
    let raw;
    try {
      raw = JSON.parse(payload);
    } catch {
      continue;
    }
    foldEvent(state, raw);
    if (state.finished || state.error) break;
  }
  return state;
}

export function completionBody(state, model) {
  return {
    id: state.conversationId || "chatcmpl-" + Math.random().toString(36).slice(2, 12),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: state.text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
