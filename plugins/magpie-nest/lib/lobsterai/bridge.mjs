// One chat turn: OpenAI in, the same shape out, over an SSE-only upstream.
//
// Two things the upstream insists on and a generic OpenAI client cannot know:
//
//  1. stream:false is answered 500 -- the endpoint is SSE-only. Every request
//     goes upstream as stream:true; a caller that asked for one answer gets the
//     stream folded into one.
//  2. The two X-LobsterAI-Client-* headers gate the model set and the
//     thinking-level control. Dropping them is not cosmetic: the gateway then
//     quietly serves a model list without kimi-k3, and reasoning_effort "off"
//     comes back 500.

import { CHAT_BASE, CHAT_PATH, CLIENT_VERSION, USER_AGENT, CAPABILITIES } from "./constants.mjs";
import { aggregate, completionBody } from "./sse.mjs";
import { LobsteraiError, looksLikeQuota } from "./http.mjs";

/** The identity headers the official client sends on every chat turn. */
export function chatHeaders(token, accept) {
  return {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    Accept: accept,
    "User-Agent": USER_AGENT,
    "X-LobsterAI-Client-Capabilities": CAPABILITIES,
    "X-LobsterAI-Client-Version": CLIENT_VERSION,
  };
}

/**
 * Relay a failure the way magpie reads it: 401/403 marks the account and moves
 * on, 429/5xx rests the account and moves on. An exhausted allowance arrives
 * as 402 or as a 4xx carrying the vendor's wording, and is turned into 429 so
 * the next account is tried instead of the reader seeing a quota error.
 */
async function relayFailure(response) {
  const text = await response.text().catch(() => "");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  const quota = response.status === 402 || (response.status < 500 && response.status !== 401 && response.status !== 403 && looksLikeQuota(text));
  return new Response(text, { status: quota ? 429 : response.status, headers });
}

function streamHeaders(upstream) {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  const requestId = upstream.headers.get("x-request-id");
  if (requestId) headers.set("x-request-id", requestId);
  return headers;
}

/**
 * Answer one chat completion. request is a Request whose body is the OpenAI
 * chat body; the caller has already established that there is a credential.
 */
export async function chat(creds, request, fetcher = fetch) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new LobsteraiError("the request body is not JSON", { status: 400 });
  }
  const model = String(body?.model ?? "");
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw new LobsteraiError("the request named no messages", { status: 400 });
  }

  const streaming = body.stream === true;
  const upstreamBody = { ...body, stream: true };

  let upstream;
  try {
    upstream = await fetcher(CHAT_BASE + CHAT_PATH, {
      method: "POST",
      headers: chatHeaders(creds.token, "text/event-stream, application/json"),
      body: JSON.stringify(upstreamBody),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new LobsteraiError("the caller went away", { status: 499 });
    throw new LobsteraiError("LobsterAI could not be reached: " + String(error?.message ?? error), { status: 502 });
  }

  if (!upstream.ok) return relayFailure(upstream);

  if (streaming) {
    return new Response(upstream.body, { status: 200, headers: streamHeaders(upstream) });
  }

  const state = await aggregate(upstream, model);
  if (state.error) {
    const message = typeof state.error === "string" ? state.error : JSON.stringify(state.error);
    throw new LobsteraiError("LobsterAI failed the turn: " + message.slice(0, 300), { status: 502 });
  }
  return Response.json(completionBody(state, model));
}
