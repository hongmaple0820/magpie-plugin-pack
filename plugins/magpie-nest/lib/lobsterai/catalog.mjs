// The account's real model catalog: GET /api/models/available.
//
// The static table in constants.mjs is a snapshot of one day; the gateway is
// the authority on which models exist. Two protocol facts from the reference
// implementation (dsh-our-free-model lobsterai-auth.ts fetchModels):
//
//  1. The query string is the keyfrom identity payload (firstKeyfrom /
//     latestKeyfrom / version / uuid / userId) -- the same fields the refresh
//     body carries, minus refreshToken. Sending the refresh token in a URL
//     would leak it into access logs for nothing.
//  2. The two X-LobsterAI-Client-* headers are REQUIRED here, not metadata:
//     the server filters the model set by the declared capabilities, and
//     without kimi-k3-agentic-v1 the response is permanently missing kimi-k3
//     (measured 25 vs 26 models).
//
// Failure is never fatal: the caller falls back to the static table, because a
// catalog that cannot be fetched must not empty the model picker.

import { API_BASE, CLIENT_VERSION, USER_AGENT, CAPABILITIES, TIMEOUT_MS } from "./constants.mjs";

const MODELS_PATH = "/api/models/available";
const TTL_MS = 10 * 60 * 1000;
const CACHE = new Map();

/** The keyfrom identity payload as a query string; refreshToken never rides along. */
export function modelsQuery(creds) {
  const params = new URLSearchParams();
  const fields = {
    firstKeyfrom: creds?.firstKeyfrom,
    latestKeyfrom: creds?.latestKeyfrom,
    version: CLIENT_VERSION,
    uuid: creds?.uuid,
    userId: creds?.userId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.length > 0) params.set(key, value);
  }
  return params.toString();
}

/** Same header set as a chat turn, but Accept is JSON (the endpoint is not SSE). */
export function modelsHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-LobsterAI-Client-Capabilities": CAPABILITIES,
    "X-LobsterAI-Client-Version": CLIENT_VERSION,
  };
}

/**
 * Parse the response body: an array of { modelId, modelName, supportsImage?,
 * supportsThinking?, ... }. Entries without a modelId are dropped; nothing is
 * invented -- a field the server did not send stays absent.
 */
export function parseModels(body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.models) ? body.models : [];
  const out = [];
  for (const item of rows) {
    if (typeof item !== "object" || item === null) continue;
    const id = typeof item.modelId === "string" ? item.modelId.trim() : "";
    if (!id) continue;
    const name = typeof item.modelName === "string" && item.modelName.trim() ? item.modelName.trim() : id;
    const row = { id, name };
    if (typeof item.supportsImage === "boolean") row.attachment = item.supportsImage;
    if (typeof item.supportsThinking === "boolean") row.reasoning = item.supportsThinking;
    out.push(row);
  }
  return out;
}

/**
 * Fetch the account's model catalog. Returns [{ id, name, attachment?,
 * reasoning? }], or null when the endpoint could not be read (the caller then
 * keeps its static table). Cached per account for ten minutes.
 */
export async function fetchCatalog(creds, { signal, force = false, fetcher = fetch } = {}) {
  if (!creds?.token) return null;
  const key = [creds.token, creds?.uuid ?? "", creds?.userId ?? ""].join("|");
  const hit = CACHE.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const query = modelsQuery(creds);
  const url = API_BASE + MODELS_PATH + (query ? "?" + query : "");
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: modelsHeaders(creds.token),
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const value = parseModels(body);
  if (!value.length) return null;
  CACHE.set(key, { at: Date.now(), value });
  return value;
}

export function clearCatalogCache() {
  CACHE.clear();
}
