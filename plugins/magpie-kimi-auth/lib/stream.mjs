// Reading Kimi's framed chat stream.
//
// Every frame is a JSON message. A heartbeat carries nothing. A block text is
// an increment, and its flags say whether it is the answer or the thinking
// that precedes it.

export function newState() {
  return { text: "", reasoning: "", chatId: "", error: undefined, finished: false };
}

/** Fold one frame, answering the deltas it carries. */
export function foldMessage(state, data) {
  if (!data || typeof data !== "object") return { text: "", reasoning: "" };
  if (data.heartbeat) return { text: "", reasoning: "" };
  if (data.error) {
    state.error = data.error;
    return { text: "", reasoning: "" };
  }
  if (data.chat?.id && !state.chatId) state.chatId = String(data.chat.id);

  const text = data.block?.text;
  const content = typeof text?.content === "string" ? text.content : "";
  if (!content) return { text: "", reasoning: "" };

  // "set" replaces the block, so a set after a partial answer would duplicate
  // it; the web app only sets on the first frame, which carries the question.
  if (data.op === "set" && state.text) return { text: "", reasoning: "" };

  if (text.flags === "thinking") {
    state.reasoning += content;
    return { text: "", reasoning: content };
  }
  state.text += content;
  return { text: content, reasoning: "" };
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
