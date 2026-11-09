// Gemini Code Assist (Cloud Code) protocol facts.
//
// This is not Gemini's public API: it is the v1internal envelope the Cloud
// Code / Antigravity tooling speaks, and the gateway fingerprints the client
// identity as closely as the token.

// A subscription named gemini already exists in magpie, so this channel carries
// its own id: the two are different credentials against different services.
export const ID = "gemini-code-assist";
export const NAME = "Gemini Code Assist";
export const NPM = "@ai-sdk/google";

export const ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";

/** Byte-for-byte: extra fields get the client classified as third-party. */
export const LOAD_CODE_ASSIST_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}';

export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

/** Free-tier accounts answer no project; this is what the client falls back to. */
export const DEFAULT_PROJECT = "aicode-consumers";

/** The bare model name 404s: only <base>-<tier> is accepted. */
export const MODEL_BASE = "gemini-3.8-flash";
export const TIERS = ["low", "medium", "high", "tiered"];

/**
 * Identity headers, verbatim from the captured official client. Note the
 * deliberate absence of x-goog-api-key and x-goog-api-client.
 */
export const IDENTITY_HEADERS = {
  "User-Agent": "antigravity/4.3.0 (cmdc-pak)",
  "x-client-name": "antigravity",
  "x-client-version": "4.3.0",
  "x-machine-id": "cmdc-pak",
  "x-vscode-sessionid": "proxy",
};

export function modelRows() {
  const out = {};
  for (const tier of TIERS) {
    out[MODEL_BASE + "-" + tier] = { name: "Gemini 3.8 Flash (" + tier + ")", tool_call: true, reasoning: true };
  }
  return out;
}

/** Resolve a requested name to the wire name, refusing anything upstream would silently reroute. */
export function resolveModel(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const bare = raw.startsWith(ID + "/") ? raw.slice(ID.length + 1) : raw;
  if (TIERS.some((tier) => bare === MODEL_BASE + "-" + tier)) return bare;
  throw Object.assign(
    new Error("gemini: only " + MODEL_BASE + " with a -low/-medium/-high/-tiered suffix is served (got " + (bare || "(none)") + ")"),
    { status: 404 },
  );
}
