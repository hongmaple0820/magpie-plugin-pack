// Server-sent events, read the way LobsterAI writes them.
//
// The upstream is OpenAI-shaped, so a streaming caller is answered by passing
// the bytes through untouched. Only a caller that did not ask to stream needs
// this: the reply is drained into text and answered once.

/** The data payloads of a whole SSE document, in order. */
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

/**
 * Fold one OpenAI chat chunk into the accumulating answer. Reasoning models
 * send their thinking beside the answer; both are kept, the answer separate.
 */
export function foldChunk(state, chunk, fallbackModel) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string" && delta.content) state.text += delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning) state.reasoning += reasoning;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  if (chunk?.model) state.model = String(chunk.model);
  if (chunk?.usage) state.usage = chunk.usage;
  if (chunk?.error) state.error = chunk.error;
  if (!state.model && fallbackModel) state.model = fallbackModel;
  return state;
}

export function newState() {
  return { text: "", reasoning: "", finishReason: "stop", model: "", usage: undefined, error: undefined };
}

/** Read a Response body as text, tolerating a stream that is not chunk-aligned. */
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
  out += decoder.decode();
  return out;
}

/** Drain a streaming answer into the one completion a non-streaming caller wants. */
export async function aggregate(response, fallbackModel) {
  const state = newState();
  for (const payload of ssePayloads(await readAll(response))) {
    if (payload === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    foldChunk(state, chunk, fallbackModel);
    if (state.error) break;
  }
  return state;
}

/** The completion body an OpenAI client expects for a non-streamed answer. */
export function completionBody(state, model) {
  const promptTokens = state.usage?.prompt_tokens ?? 0;
  const completionTokens = state.usage?.completion_tokens ?? 0;
  return {
    id: "chatcmpl-" + Math.random().toString(36).slice(2, 12),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: state.model || model || "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: state.text,
          ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
        },
        finish_reason: state.finishReason || "stop",
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}
