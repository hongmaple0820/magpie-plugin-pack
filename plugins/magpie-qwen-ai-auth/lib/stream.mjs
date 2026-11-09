// Qwen AI streams OpenAI-shaped chunks, but every delta carries a phase:
// think, thinking_summary, or answer. The reply is the answer phase; the rest
// is reasoning, kept apart so a client sees thinking where it expects it.

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
  return { text: "", reasoning: "", finished: false, model: "", usage: undefined, error: undefined };
}

export function foldChunk(state, chunk) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
  const delta = choice?.delta ?? {};
  const phase = delta.phase;
  const status = delta.status;
  const content = typeof delta.content === "string" ? delta.content : "";

  let grewText = "";
  let grewReasoning = "";

  if (phase === "think") {
    if (status !== "finished" && content) grewReasoning = content;
  } else if (phase === "thinking_summary") {
    if (content) grewReasoning = content;
  } else if (phase === "answer") {
    if (content) grewText = content;
    if (status === "finished") state.finished = true;
  } else if (phase === null || phase === undefined) {
    if (content) grewText = content;
    if (status === "finished") state.finished = true;
  }

  state.text += grewText;
  state.reasoning += grewReasoning;
  if (chunk?.model) state.model = String(chunk.model);
  if (chunk?.usage) state.usage = chunk.usage;
  if (chunk?.error) state.error = chunk.error;
  if (choice?.finish_reason) state.finished = true;
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

export async function drain(response) {
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
  return {
    id: "chatcmpl-" + Math.random().toString(36).slice(2, 12),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: state.model || model,
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
