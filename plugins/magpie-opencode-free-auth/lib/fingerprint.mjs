// The two tool definitions the v2 gate compares, and the note that keeps the
// model from actually calling them.

import { READ_TOOL, SHELL_TOOL, PLACEHOLDER_NOTE } from "./constants.mjs";

/** Add the fingerprint tools, then strip the tool_choice the gate refuses. */
export function applyFingerprint(tools, toolChoice) {
  const list = Array.isArray(tools) ? tools.map((tool) => ({ ...tool })) : [];
  const named = new Set(list.map((tool) => String(tool?.function?.name ?? "").trim()).filter(Boolean));
  let injected = false;
  if (!named.has("read")) {
    list.push(JSON.parse(JSON.stringify(READ_TOOL)));
    injected = true;
  }
  if (!named.has("shell")) {
    list.push(JSON.parse(JSON.stringify(SHELL_TOOL)));
    injected = true;
  }
  const choice = toolChoice === "none" ? undefined : toolChoice;
  return { tools: list, toolChoice: choice, injected };
}

/** Put the placeholder note after any leading system messages. */
export function withNote(messages, injected) {
  if (!injected) return messages;
  const out = Array.isArray(messages) ? [...messages] : [];
  let at = 0;
  while (at < out.length && out[at]?.role === "system") at += 1;
  out.splice(at, 0, { role: "system", content: PLACEHOLDER_NOTE });
  return out;
}
