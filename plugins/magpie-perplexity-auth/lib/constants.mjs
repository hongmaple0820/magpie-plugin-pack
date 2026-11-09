// Perplexity (www.perplexity.ai) web protocol facts.

import { randomUUID } from "node:crypto";

export const ID = "perplexity";
export const NAME = "Perplexity 网页版";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://www.perplexity.ai";
export const ASK_PATH = "/rest/sse/perplexity_ask";

/** The cookie the web app keeps its session in. */
export const SESSION_COOKIE = "__Secure-next-auth.session-token";

export const CLIENT_HEADERS = {
  Accept: "text/event-stream",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Origin: API_BASE,
  Referer: API_BASE + "/",
  "Sec-Ch-Ua": '"Chromium";v="134", "Not=A-Brand";v="24", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
};

const ROWS = [
  ["auto", "Auto"],
  ["turbo", "Turbo"],
  ["sonar", "Sonar"],
  ["pplx_pro", "PPLX Pro"],
  ["gpt-5.4", "GPT-5.4"],
  ["gemini-3.0-pro", "Gemini 3.0 Pro"],
  ["gemini-3.0-flash", "Gemini 3.0 Flash"],
  ["claude-4.6-sonnet", "Claude Sonnet 4.6"],
  ["claude-4.6-opus", "Claude Opus 4.6"],
  ["grok-4.1", "Grok 4.1"],
  ["nemotron", "Nemotron"],
];

export function modelRows() {
  const out = {};
  for (const [id, name] of ROWS) out[id] = { name };
  return out;
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(ID + "/") ? id.slice(ID.length + 1) : id;
}

/** The blocks the web client asks to be told about. Trimming this list changes
 *  what the browser session is allowed to return, so it travels whole. */
export const SUPPORTED_BLOCK_USE_CASES = [
  "answer_modes",
  "media_items",
  "knowledge_cards",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "inline_images",
  "inline_assets",
  "placeholder_cards",
  "diff_blocks",
  "inline_knowledge_cards",
  "entity_group_v2",
  "refinement_filters",
  "canvas_mode",
  "maps_preview",
  "answer_tabs",
  "price_comparison_widgets",
  "preserve_latex",
  "in_context_suggestions",
  "inline_claims",
];

/** One question, one body: the web app takes the last user message verbatim. */
export function requestBody(query, model) {
  return {
    params: {
      attachments: [],
      language: "en-US",
      timezone: "America/Los_Angeles",
      search_focus: "internet",
      sources: ["web"],
      search_recency_filter: null,
      frontend_uuid: randomUUID(),
      mode: "copilot",
      model_preference: model,
      is_related_query: false,
      is_sponsored: false,
      frontend_context_uuid: randomUUID(),
      prompt_source: "user",
      query_source: "home",
      is_incognito: false,
      time_from_first_type: 18361,
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: SUPPORTED_BLOCK_USE_CASES,
      client_coordinates: null,
      mentions: [],
      dsl_query: query,
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      source: "default",
      always_search_override: false,
      override_no_search: false,
      should_ask_for_mcp_tool_confirmation: true,
      browser_agent_allow_once_from_toggle: false,
      force_enable_browser_agent: false,
      supported_features: ["browser_agent_permission_banner_v1.1"],
      version: "2.18",
    },
    query_str: query,
  };
}

/** The question is the last user turn; earlier turns become context lines. */
export function queryOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const textOf = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : "";
  let lastUser = "";
  const earlier = [];
  for (const message of list) {
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (message?.role === "user") lastUser = text;
    else earlier.push((message?.role === "assistant" ? "Assistant: " : "System: ") + text);
  }
  if (!earlier.length) return lastUser;
  return earlier.join("\n\n") + "\n\nUser: " + lastUser;
}
