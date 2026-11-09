// ChatGPT patches one message instead of streaming deltas.
//
//   "v1"                                          a protocol marker, ignored
//   {"p":"/message/content/parts/0","o":"append","v":"Hello"}
//   {"p":"","o":"patch","v":[{...},{...}]}        a batch, applied in order
//   {"v":" world"}                                a bare continuation
//   {"v":{...}}                                   a new message snapshot
//
// The upstream also injects internal markers wrapped in \ue200...\ue201; a
// client that receives them raw shows mojibake, so they are rewritten to
// "label (url)" as it goes.

const OPEN = "\ue200";
const SEP = "\ue202";
const CLOSE = "\ue201";

function isInternal(part) {
  const value = part.trim();
  if (!value) return true;
  const lower = value.toLowerCase();
  return /^turn\d+/.test(lower) || lower.startsWith("turn") || lower.startsWith("source");
}

function annotationText(payload) {
  const parts = payload.split(SEP).map((part) => part.trim());
  const kind = (parts[0] ?? "").toLowerCase();
  const data = parts.slice(1);
  if (kind === "url") {
    const label = data[0] ?? "";
    const url = data[1] ?? "";
    if (label && (url.startsWith("http://") || url.startsWith("https://"))) return label + " (" + url + ")";
    return label || url;
  }
  for (const part of data) {
    if (part && !isInternal(part)) return part;
  }
  return "";
}

/** Rewrite the internal annotations, and drop the control characters. */
export function cleanText(text) {
  if (!text || (!text.includes(OPEN) && !text.includes(CLOSE))) return text;
  let out = "";
  let index = 0;
  for (;;) {
    const start = text.indexOf(OPEN, index);
    if (start < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, start);
    const end = text.indexOf(CLOSE, start + 1);
    if (end < 0) {
      out += text.slice(start);
      break;
    }
    out += annotationText(text.slice(start + 1, end));
    index = end + 1;
  }
  return out;
}

export function newState() {
  return { text: "", reasoning: "", conversationId: "", finished: false, error: undefined };
}

/** Fold one SSE payload, answering the text it contributes. */
export function foldEvent(state, raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[DONE]" || trimmed === '"v1"' || trimmed === "v1") return "";

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return "";
  }
  if (!event || typeof event !== "object") return "";

  if (event.type === "resume_conversation_token") return "";
  if (event.error) {
    state.error = event.error;
    return "";
  }
  if (event.conversation_id) state.conversationId = String(event.conversation_id);
  if (event.message?.conversation_id) state.conversationId = String(event.message.conversation_id);

  // A batch: apply each patch in order.
  if (event.o === "patch" && Array.isArray(event.v)) {
    let out = "";
    for (const patch of event.v) out += foldEvent(state, JSON.stringify(patch));
    return out;
  }

  // An append to the answer.
  const path = typeof event.p === "string" ? event.p : "";
  if (path.startsWith("/message/content/parts")) {
    if (typeof event.v === "string") {
      const delta = cleanText(event.v);
      state.text += delta;
      return delta;
    }
    return "";
  }

  // A bare continuation belongs to the answer.
  if (typeof event.v === "string" && !path) {
    const delta = cleanText(event.v);
    state.text += delta;
    return delta;
  }

  // A snapshot of a message: take the text it holds as the baseline.
  if (event.v && typeof event.v === "object" && event.v.message) {
    const parts = event.v.message?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts.filter((part) => typeof part === "string").join("");
      const cleaned = cleanText(text);
      if (cleaned.length >= state.text.length) {
        state.text = cleaned;
      }
    }
    return "";
  }

  if (event.v === null && event.p) return "";
  return "";
}

export async function* payloadsOf(response) {
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

export function completionBody(state, model) {
  return {
    id: "chatcmpl-" + Math.random().toString(36).slice(2, 12),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: state.text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
