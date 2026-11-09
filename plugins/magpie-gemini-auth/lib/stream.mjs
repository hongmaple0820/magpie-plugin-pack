// v1internal streams Gemini frames: candidates carry parts, and a part is
// either the answer or a thought.

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
 * Peel one frame. Frames arrive either wrapped ({"response":{…}}) or bare, and
 * a frame with no candidates carries only usage -- still worth reading, because
 * usage often arrives in a trailing frame of its own.
 */
export function parseFrame(payload) {
  const trimmed = String(payload ?? "").trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const inner = typeof parsed.response === "object" && parsed.response !== null ? parsed.response : parsed;
  const candidate = Array.isArray(inner.candidates) ? inner.candidates[0] : undefined;
  return {
    parts: Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [],
    finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined,
    usage: inner.usageMetadata,
  };
}

export function newState() {
  return { text: "", reasoning: "", finishReason: "stop", usage: undefined };
}

/** Fold one frame, answering the deltas it carries. */
export function foldFrame(state, frame) {
  if (!frame) return { text: "", reasoning: "" };
  let text = "";
  let reasoning = "";
  for (const part of frame.parts) {
    if (typeof part?.text !== "string") continue;
    if (part.thought === true) reasoning += part.text;
    else text += part.text;
  }
  state.text += text;
  state.reasoning += reasoning;
  if (frame.finishReason) state.finishReason = frame.finishReason === "MAX_TOKENS" ? "length" : "stop";
  if (frame.usage) state.usage = mapUsage(frame.usage);
  return { text, reasoning };
}

/** Upstream usage counts the prompt inclusive of cache hits. */
export function mapUsage(raw) {
  if (!raw) return undefined;
  const prompt = typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : undefined;
  const completion = typeof raw.candidatesTokenCount === "number" ? raw.candidatesTokenCount : undefined;
  const total = typeof raw.totalTokenCount === "number" ? raw.totalTokenCount : undefined;
  if (prompt === undefined && completion === undefined) return undefined;
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total ?? (prompt ?? 0) + (completion ?? 0),
  };
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
    foldFrame(state, parseFrame(payload));
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
        finish_reason: state.finishReason || "stop",
      },
    ],
    ...(state.usage ? { usage: state.usage } : {}),
  };
}
