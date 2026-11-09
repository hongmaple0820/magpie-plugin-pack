// Folding an OpenAI-shaped SSE answer into one completion.
//
// The free lane is SSE-only, so a caller that did not ask to stream still gets
// a stream; this turns it back into the single answer it asked for.

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
  return { text: "", reasoning: "", finishReason: "stop", model: "", usage: undefined, error: undefined };
}

export function foldChunk(state, chunk) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string" && delta.content) state.text += delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning) state.reasoning += reasoning;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  if (chunk?.model) state.model = String(chunk.model);
  if (chunk?.usage) state.usage = chunk.usage;
  if (chunk?.error) state.error = chunk.error;
  return state;
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
  out += decoder.decode();
  return out;
}

export async function aggregate(response) {
  const state = newState();
  for (const payload of ssePayloads(await readAll(response))) {
    if (payload === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    foldChunk(state, chunk);
    if (state.error) break;
  }
  return state;
}

export function completionBody(state, model) {
  const prompt = state.usage?.prompt_tokens ?? 0;
  const completion = state.usage?.completion_tokens ?? 0;
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
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}
