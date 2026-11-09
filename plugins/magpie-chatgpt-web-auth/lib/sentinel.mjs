// The sentinel handshake: four steps before a conversation is allowed.
//
//   GET  /                                     page HTML -> proof resources
//   POST .../chat-requirements/prepare {p}     prepare_token + what must be solved
//   (local)                                    proof of work and/or turnstile
//   POST .../chat-requirements/finalize        token (+ so_token)
//
// A signed-in account uses /backend-api; an anonymous one /backend-anon. The
// algorithm is the same on both, only the path differs.

import { requirementsToken, solveProof, parseResources } from "./pow.mjs";
import { solveTurnstile } from "./turnstile.mjs";

export function requirementsPath(hasToken) {
  return hasToken ? "/backend-api/sentinel/chat-requirements" : "/backend-anon/sentinel/chat-requirements";
}

function jsonOrThrow(text, step) {
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("chatgpt: sentinel " + step + " answered a non-JSON body"), { status: 502 });
  }
}

function ensureOk(response, step) {
  if (response.ok) return;
  throw Object.assign(
    new Error("chatgpt: sentinel " + step + " failed (HTTP " + response.status + ") " + (response.status === 403 ? "-- the upstream refused this client" : "")),
    { status: response.status === 429 ? 429 : 502, ...(response.status === 401 ? { signIn: "expired" } : {}) },
  );
}

/**
 * Run the handshake. Everything it learns that the conversation request needs
 * is returned; nothing is cached, because the tokens have their own lifetime.
 */
export async function handshake({ base, token, headers, userAgent, fetcher = fetch, signal }) {
  const baseUrl = String(base).replace(/\/$/, "");

  let resources = {};
  try {
    const page = await fetcher(baseUrl + "/", {
      method: "GET",
      headers: { ...headers, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      ...(signal ? { signal } : {}),
    });
    if (page.ok) resources = parseResources(await page.text());
  } catch {
    /* the page is optional: the default script is a fine fallback */
  }

  const path = requirementsPath(Boolean(token));
  const p = requirementsToken(userAgent, resources);

  const prepareResponse = await fetcher(baseUrl + path + "/prepare", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ p }),
    ...(signal ? { signal } : {}),
  });
  ensureOk(prepareResponse, "prepare");
  const prepare = jsonOrThrow(await prepareResponse.text(), "prepare");

  if (prepare?.arkose?.required) {
    throw Object.assign(
      new Error("chatgpt: the upstream wants an arkose token (not implemented); this account or region is force-challenged"),
      { status: 502 },
    );
  }

  let proofToken = "";
  if (prepare?.proofofwork?.required) {
    try {
      proofToken = (await solveProof(String(prepare.proofofwork.seed ?? ""), String(prepare.proofofwork.difficulty ?? ""), userAgent, resources)).token;
    } catch (error) {
      throw Object.assign(new Error("chatgpt: the proof of work failed: " + String(error?.message ?? error)), { status: 502 });
    }
  }

  let turnstileToken = "";
  if (prepare?.turnstile?.required && prepare.turnstile.dx) {
    const solved = solveTurnstile(String(prepare.turnstile.dx), p);
    if (!solved) {
      throw Object.assign(new Error("chatgpt: the turnstile program could not be read (the upstream script may have changed)"), {
        status: 502,
      });
    }
    turnstileToken = solved;
  }

  const finalizeResponse = await fetcher(baseUrl + path + "/finalize", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      prepare_token: prepare?.prepare_token ?? "",
      proof_token: proofToken,
      turnstile_token: turnstileToken,
    }),
    ...(signal ? { signal } : {}),
  });
  ensureOk(finalizeResponse, "finalize");
  const finalize = jsonOrThrow(await finalizeResponse.text(), "finalize");

  const ready = String(finalize?.token ?? "");
  if (!ready) {
    throw Object.assign(new Error("chatgpt: sentinel finalize answered no token"), { status: 502 });
  }
  return {
    token: ready,
    proofToken,
    turnstileToken,
    soToken: String(finalize?.so_token ?? ""),
  };
}

/** The sentinel headers a conversation request carries. */
export function sentinelHeaders(result) {
  const headers = {
    "OpenAI-Sentinel-Chat-Requirements-Token": result.token,
  };
  if (result.proofToken) headers["OpenAI-Sentinel-Proof-Token"] = result.proofToken;
  if (result.turnstileToken) headers["OpenAI-Sentinel-Turnstile-Token"] = result.turnstileToken;
  if (result.soToken) headers["OpenAI-Sentinel-SO-Token"] = result.soToken;
  return headers;
}
