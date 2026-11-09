// Perplexity's answer arrives as diff patches over cumulative chunks.
//
// Each event carries blocks; a markdown block's patch value either names the
// whole answer so far or a chunks array that is joined into it. Either way the
// text is cumulative, so the answer is recomputed and only the growth emitted.

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
  return { text: "", reasoning: "", segments: {}, finished: false };
}

function valueOf(patch) {
  let value = patch?.value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.chunks)) value = value.chunks.join("");
    else if (typeof value.answer === "string") value = value.answer;
    else value = "";
  }
  return typeof value === "string" ? value : "";
}

/** Fold one event, answering only what grew since the last one. */
export function foldEvent(state, event) {
  let grewText = "";
  let grewReasoning = "";

  for (const block of Array.isArray(event?.blocks) ? event.blocks : []) {
    if (block?.intended_usage === "sources_answer_mode" || block?.intended_usage === "media_items") continue;
    const diff = block?.diff_block;
    if (!Array.isArray(diff?.patches)) continue;
    const isMarkdown = diff.field === "markdown_block";

    for (const patch of diff.patches) {
      const path = String(patch?.path ?? "");
      if (path === "/progress") continue;
      const value = valueOf(patch);
      if (!value) continue;

      if (path.startsWith("/goals")) {
        // Reasoning is cumulative per path as well.
        const key = "goals:" + path;
        const prior = state.segments[key] ?? "";
        if (value.startsWith(prior)) {
          grewReasoning += value.slice(prior.length);
          state.segments[key] = value;
        }
        continue;
      }

      if (!isMarkdown) continue;
      const key = "md:" + path;
      const prior = state.segments[key] ?? "";
      if (value.startsWith(prior)) {
        grewText += value.slice(prior.length);
        state.segments[key] = value;
      }
    }
  }

  state.text += grewText;
  state.reasoning += grewReasoning;
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
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    foldEvent(state, event);
  }
  state.finished = true;
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
