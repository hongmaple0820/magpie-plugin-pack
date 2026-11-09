import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, chatHeaders } from "../lib/bridge.mjs";

const CREDS = { token: "T" };
const SSE = [
  'data: {"model":"glm-5","choices":[{"delta":{"content":"你"}}]}',
  'data: {"choices":[{"delta":{"content":"好"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
  "data: [DONE]",
  "",
].join("\n");

function requestOf(body) {
  return new Request("https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const okSse = async () => new Response(SSE, { headers: { "content-type": "text/event-stream" } });

test("the two client headers the gateway gates on are sent", () => {
  const headers = chatHeaders("T", "text/event-stream");
  assert.equal(headers["X-LobsterAI-Client-Capabilities"], "kimi-k3-agentic-v1,thinking-level-control-v1");
  assert.equal(headers["X-LobsterAI-Client-Version"], "2026.9.4");
  assert.equal(headers.Authorization, "Bearer T");
  assert.equal(headers["User-Agent"], "LobsterAI/0.1.0");
});

test("every request goes upstream streaming, even when the caller did not ask", async () => {
  let sent;
  const fetcher = async (url, init) => {
    sent = JSON.parse(init.body);
    assert.equal(url, "https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions");
    assert.equal(init.headers["X-LobsterAI-Client-Capabilities"].includes("kimi-k3-agentic-v1"), true);
    return okSse();
  };
  const response = await chat(CREDS, requestOf({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }), fetcher);
  assert.equal(sent.stream, true);
  assert.equal(response.status, 200);
});

test("a non-streaming caller gets one completion, not a stream", async () => {
  const response = await chat(
    CREDS,
    requestOf({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }),
    okSse,
  );
  assert.equal(response.headers.get("content-type").includes("application/json"), true);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "你好");
  assert.equal(body.model, "glm-5");
});

test("a streaming caller gets the upstream bytes through", async () => {
  const response = await chat(
    CREDS,
    requestOf({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
    okSse,
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(await response.text(), SSE);
});

test("a 401 is handed back so magpie can mark the account", async () => {
  const response = await chat(
    CREDS,
    requestOf({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    async () => new Response('{"msg":"unauthorized"}', { status: 401 }),
  );
  assert.equal(response.status, 401);
});

test("an exhausted allowance becomes 429 so the next account is tried", async () => {
  for (const [status, body] of [
    [402, '{"code":402,"msg":"payment required"}'],
    [400, '{"code":1001,"msg":"您的额度已用尽"}'],
  ]) {
    const response = await chat(
      CREDS,
      requestOf({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      async () => new Response(body, { status }),
    );
    assert.equal(response.status, 429, "status " + status + " should become 429");
  }
});

test("an ordinary upstream fault keeps its status", async () => {
  const response = await chat(
    CREDS,
    requestOf({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    async () => new Response("boom", { status: 500 }),
  );
  assert.equal(response.status, 500);
});

test("a request with no messages is refused before it reaches upstream", async () => {
  let called = false;
  const fetcher = async () => {
    called = true;
    return okSse();
  };
  await assert.rejects(
    () => chat(CREDS, requestOf({ model: "m", messages: [] }), fetcher),
    (error) => error.status === 400,
  );
  assert.equal(called, false);
});

test("an unreachable upstream is a 502, not a crash", async () => {
  const fetcher = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(
    () => chat(CREDS, requestOf({ model: "m", messages: [{ role: "user", content: "hi" }] }), fetcher),
    (error) => error.status === 502,
  );
});
