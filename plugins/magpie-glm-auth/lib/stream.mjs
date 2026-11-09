// Reading GLM's assistant stream: cumulative parts, not deltas.
//
// Every event carries the whole current state of each part, keyed by logic_id,
// so the answer is recomputed from the parts and only the suffix that grew is
// emitted. Emitting the parts verbatim would repeat the whole answer per event.

export function ssePayloads(text) {
  const out = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload) out.push(payload);
  }
  return out;
}

export function newState() {
  return { parts: [], text: "", reasoning: "", conversationId: "", finished: false };
}

/** Fold one event, answering only what grew since the last one. */
export function foldEvent(state, event) {
  if (typeof event?.conversation_id === "string" && event.conversation_id) state.conversationId = event.conversation_id;
  if (event?.status === "finish" || event?.status === "intervene") state.finished = true;

  for (const part of Array.isArray(event?.parts) ? event.parts : []) {
    const at = state.parts.findIndex((existing) => existing.logic_id === part.logic_id);
    if (at >= 0) state.parts[at] = part;
    else state.parts.push(part);
  }

  let text = "";
  let reasoning = "";
  for (const part of state.parts) {
    for (const item of Array.isArray(part?.content) ? part.content : []) {
      if (item?.type === "text" && typeof item.text === "string") text += item.text;
      else if (item?.type === "think" && typeof item.think === "string") reasoning += item.think;
    }
  }

  const grewText = text.length > state.text.length ? text.slice(state.text.length) : "";
  const grewReasoning = reasoning.length > state.reasoning.length ? reasoning.slice(state.reasoning.length) : "";
  state.text = text;
  state.reasoning = reasoning;
  return { text: grewText, reasoning: grewReasoning };
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

/** Drain the whole stream into one answer. */
export async function drain(response) {
  const state = newState();
  for (const payload of ssePayloads(await readAll(response))) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    foldEvent(state, event);
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
