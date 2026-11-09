// OpenCode's keyless lane: opencode.ai/inference/v1.
//
// No account and no key: every request carries Bearer public, the official
// CLI's own anonymous credential. What the gate actually fingerprints is the
// client shape -- a v2 user agent, four session headers that must all carry
// one canonical session id, and the CLI's own read/shell tool definitions.

export const ID = "opencode-free";
export const NAME = "OpenCode Free";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://opencode.ai/inference/v1";
export const CHAT_PATH = "/chat/completions";

/** The pooled anonymous credential. */
export const ANON_KEY = "public";

/** Whole-string match at the gate -- never decorate it. */
export const UA = "opencode/latest/2.0.26/cli";

/**
 * Only these accept Bearer public; the rest of the catalogue answers 401
 * (paid) or 403 FreeTierError. An unknown id is refused locally: upstream
 * answers one by quietly serving a different model, which would be a lie.
 */
const ROWS = [
  ["big-pickle", "Big Pickle"],
  ["space-bunny-free", "Space Bunny"],
  ["longcat-2.5-preview-free", "LongCat 2.5 Preview"],
  ["mimo-v2.6-flash-free", "MiMo V2.6 Flash"],
  ["mimo-v2.5-free", "MiMo V2.5"],
  ["deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash"],
  ["glm-5.3-flash-free", "GLM 5.3 Flash"],
  ["nemotron-3-ultra-free", "Nemotron 3 Ultra"],
  ["nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name, tool_call: true };
  return out;
}

export function isKnownModel(value) {
  const id = baseModelId(value);
  return Object.prototype.hasOwnProperty.call(modelRows(), id);
}

/** "big-pickle (Free)" and "opencode-free/big-pickle" both name big-pickle. */
export function baseModelId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const bare = raw.startsWith(ID + "/") ? raw.slice(ID.length + 1) : raw;
  return bare.replace(/\([^()]+\)\s*$/, "").trim();
}

/** The `read` tool, verbatim from the OpenCode v2.0.26 CLI. */
export const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

/** The `shell` tool, verbatim from the OpenCode v2.0.26 CLI. */
export const SHELL_TOOL = {
  type: "function",
  function: {
    name: "shell",
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout." },
        background: { type: "boolean", description: "Run the command in the background and return immediately." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/**
 * The injected tools are real tools the model would call, so they are told
 * not to: a "must not be used" stub makes the model refuse the caller's own
 * read/shell tools as well.
 */
export const PLACEHOLDER_NOTE =
  "Do not call the `read` or `shell` tools; they are placeholders that do nothing. Use the other tools you have been given instead.";
