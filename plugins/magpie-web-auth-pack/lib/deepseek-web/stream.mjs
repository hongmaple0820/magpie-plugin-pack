// DeepSeek's reply is a patch stream, not deltas and not plain snapshots.
//
//   {"v":{"response":{...}}}                    a whole snapshot
//   {"p":"response/fragments","o":"APPEND","v":{type,content}}
//   {"p":"response/fragments/-1/content","v":"…"}  more of the last fragment
//   {"p":"response/thinking_content","v":"…"}      older shape: thinking direct
//   {"p":"response/content","v":"…"}               older shape: answer direct
//   {"v":"…"} / {"o":"APPEND","v":"…"}             bare continuation of the last path
//
// A bare continuation belongs to whichever channel established it, so the
// channel is remembered. Dropping it (or defaulting it to the answer) puts
// thinking on screen as if the model had said it.

export function newState() {
  return { fragments: [], text: "", reasoning: "", sink: null, finished: false };
}

function isReasoningType(type) {
  return String(type ?? "").toUpperCase().includes("THINK");
}

/** Append a fragment and answer what it contributes. */
function appendFragment(state, fragment) {
  const type = String(fragment?.type ?? "RESPONSE");
  const content = typeof fragment?.content === "string" ? fragment.content : "";
  if (!content) return { text: "", reasoning: "" };
  state.fragments.push({ type, content });
  state.sink = "fragments";
  if (isReasoningType(type)) {
    state.reasoning += content;
    return { text: "", reasoning: content };
  }
  state.text += content;
  return { text: content, reasoning: "" };
}

/** Fold one patch event, answering the deltas it carries. */
export function foldEvent(state, event) {
  const none = { text: "", reasoning: "" };
  if (!event || typeof event !== "object") return none;

  const snapshot = event.v;
  if (snapshot && typeof snapshot === "object") {
    const response = snapshot.response && typeof snapshot.response === "object" ? snapshot.response : snapshot;
    if (Array.isArray(response.fragments)) {
      // A snapshot restates what is already on screen: take it as the new
      // baseline rather than emitting it again.
      let text = "";
      let reasoning = "";
      for (const fragment of response.fragments) {
        if (typeof fragment?.content !== "string") continue;
        if (isReasoningType(fragment.type)) reasoning += fragment.content;
        else text += fragment.content;
      }
      state.fragments = response.fragments
        .filter((fragment) => typeof fragment?.content === "string")
        .map((fragment) => ({ type: String(fragment.type ?? "RESPONSE"), content: fragment.content }));
      state.text = text;
      state.reasoning = reasoning;
      state.sink = "fragments";
      return none;
    }
  }

  const path = typeof event.p === "string" ? event.p : "";

  if (path === "response/fragments" && event.o === "APPEND") {
    return appendFragment(state, event.v);
  }

  if (path === "response/fragments/-1/content") {
    const value = typeof event.v === "string" ? event.v : "";
    if (!value) return none;
    const last = state.fragments[state.fragments.length - 1];
    if (last) last.content += value;
    if (last && isReasoningType(last.type)) {
      state.reasoning += value;
      return { text: "", reasoning: value };
    }
    state.text += value;
    return { text: value, reasoning: "" };
  }

  if (path === "response/thinking_content") {
    const value = typeof event.v === "string" ? event.v : "";
    if (!value) return none;
    state.reasoning += value;
    state.sink = "thinking";
    return { text: "", reasoning: value };
  }

  if (path === "response/content") {
    const value = typeof event.v === "string" ? event.v : "";
    if (!value) return none;
    state.text += value;
    state.sink = "content";
    return { text: value, reasoning: "" };
  }

  // Bare continuation: it belongs to the channel the last patch established.
  if (typeof event.v === "string" && event.v) {
    if (state.sink === "thinking") {
      state.reasoning += event.v;
      return { text: "", reasoning: event.v };
    }
    state.text += event.v;
    return { text: event.v, reasoning: "" };
  }

  return none;
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
