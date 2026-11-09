// Qwen answers in SSE events that carry the whole message so far.
//
// Content is cumulative per message, so only the growth is emitted; thinking
// arrives as a separate load beside it and stops being emitted once the answer
// has started.

const MARKERS = /\[\(deep_think\)\]|\[\(multimodal_chat_think_\d+\)\]/g;

export function newState() {
  return { text: "", reasoning: "", segments: {}, thinkingSent: false, stop: false, error: undefined };
}

/** Fold one event, answering only what grew. */
export function foldEvent(state, event) {
  let grewText = "";
  let grewReasoning = "";

  const payload = event?.data ?? event;

  if (payload?.error_code && Number(payload.error_code) !== 0) {
    state.error = { code: payload.error_code, message: payload.error_msg ?? "" };
    return { text: "", reasoning: "" };
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  messages.forEach((message, index) => {
    const thinking = thinkingOfLocal(message);
    if (!state.thinkingSent && !state.text && thinking.length > (state.segments["think"] ?? "").length) {
      const prior = state.segments["think"] ?? "";
      grewReasoning += thinking.slice(prior.length);
      state.segments["think"] = thinking;
    }

    const mime = message?.mime_type;
    if ((mime === "text/plain" || mime === "multi_load/iframe") && typeof message?.content === "string") {
      const cleaned = message.content.replace(MARKERS, "");
      if (cleaned.trim()) {
        const key = "msg:" + index;
        const prior = state.segments[key] ?? "";
        if (cleaned.length > prior.length) {
          grewText += cleaned.slice(prior.length);
          state.segments[key] = cleaned;
          state.thinkingSent = true;
        }
      }
    }

    if ((message?.status === "complete" || message?.status === "finished") && mime === "multi_load/iframe") {
      state.stop = true;
    }
  });

  state.text += grewText;
  state.reasoning += grewReasoning;
  return { text: grewText, reasoning: grewReasoning };
}

function thinkingOfLocal(message) {
  const loads = Array.isArray(message?.meta_data?.multi_load) ? message.meta_data.multi_load : [];
  let best = "";
  for (const load of loads) {
    if (load?.type !== "deep_think" && load?.type !== "multimodal_chat_think") continue;
    const text = load?.content?.think_content ?? load?.content?.content ?? "";
    if (typeof text === "string" && text.length > best.length) best = text;
  }
  return best;
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

/** The data payloads of an SSE document. */
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
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    foldEvent(state, event);
    if (state.error || state.stop) break;
  }
  return state;
}

export function completionBody(state, model) {
  return {
    id: "chatcmpl-" + Math.random().toString(36).slice(2, 12),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: state.text,
          ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
