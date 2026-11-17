// LobsterAI dynamic model catalog: GET /api/models/available.
//
// Protocol facts under test (from dsh-our-free-model lobsterai-auth.ts):
//  - the query is the keyfrom identity payload, refreshToken never rides along;
//  - the two X-LobsterAI-Client-* headers are required: the server filters
//    the model set by declared capabilities (no kimi-k3-agentic-v1 => no
//    kimi-k3 in the response, measured 25 vs 26 models);
//  - a failed fetch is null, and the caller keeps its static table.
import { test } from "node:test";
import assert from "node:assert/strict";

import { modelsQuery, modelsHeaders, parseModels, fetchCatalog, clearCatalogCache } from "../lib/lobsterai/catalog.mjs";

const CREDS = {
  token: "tok",
  uuid: "u-1",
  userId: "42",
  firstKeyfrom: "fk",
  latestKeyfrom: "lk",
};

test("the query carries the keyfrom identity, never the refresh token", () => {
  const query = new URLSearchParams(modelsQuery({ ...CREDS, refresh: "SECRET" }));
  assert.equal(query.get("firstKeyfrom"), "fk");
  assert.equal(query.get("latestKeyfrom"), "lk");
  assert.equal(query.get("uuid"), "u-1");
  assert.equal(query.get("userId"), "42");
  assert.equal(query.get("version"), "2026.9.4");
  assert.equal(query.get("refreshToken"), null);
  assert.equal(query.get("refresh_token"), null);
});

test("the models headers gate the capability filter", () => {
  const headers = modelsHeaders("tok");
  assert.equal(headers["Authorization"], "Bearer tok");
  assert.equal(headers["Accept"], "application/json");
  assert.equal(headers["X-LobsterAI-Client-Capabilities"], "kimi-k3-agentic-v1,thinking-level-control-v1");
  assert.equal(headers["X-LobsterAI-Client-Version"], "2026.9.4");
});

test("parseModels reads modelId/modelName and keeps only real values", () => {
  const rows = parseModels([
    { modelId: "kimi-k3", modelName: "Kimi K3", supportsImage: true, supportsThinking: true },
    { modelId: "glm-5.2" },
    { modelName: "no id, dropped" },
    null,
    "not an object",
  ]);
  assert.deepEqual(rows, [
    { id: "kimi-k3", name: "Kimi K3", attachment: true, reasoning: true },
    { id: "glm-5.2", name: "glm-5.2" },
  ]);
});

test("parseModels accepts a body wrapped in { models: [...] }", () => {
  const rows = parseModels({ models: [{ modelId: "m", modelName: "M" }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "m");
});

test("fetchCatalog hits /api/models/available with the gated headers", async () => {
  clearCatalogCache();
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    return Response.json([{ modelId: "kimi-k3", modelName: "Kimi K3" }]);
  };
  const rows = await fetchCatalog(CREDS, { fetcher });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "kimi-k3");
  const call = calls[0];
  assert.ok(call.url.startsWith("https://lobsterai-server.youdao.com/api/models/available?"));
  assert.ok(call.url.includes("firstKeyfrom=fk"));
  assert.equal(call.headers["X-LobsterAI-Client-Capabilities"], "kimi-k3-agentic-v1,thinking-level-control-v1");
});

test("a failed catalog is null, not an error and not an empty list", async () => {
  clearCatalogCache();
  for (const status of [401, 403, 500]) {
    const rows = await fetchCatalog(CREDS, { fetcher: async () => new Response("nope", { status }) });
    assert.equal(rows, null);
  }
  const unreachable = await fetchCatalog(CREDS, { fetcher: async () => { throw new Error("network"); } });
  assert.equal(unreachable, null);
});

test("the catalog is cached per account for ten minutes", async () => {
  clearCatalogCache();
  let count = 0;
  const fetcher = async () => {
    count += 1;
    return Response.json([{ modelId: "m" }]);
  };
  await fetchCatalog(CREDS, { fetcher });
  await fetchCatalog(CREDS, { fetcher });
  assert.equal(count, 1);
  await fetchCatalog(CREDS, { fetcher, force: true });
  assert.equal(count, 2);
});

test("no token means no catalog to fetch", async () => {
  clearCatalogCache();
  const fetcher = async () => {
    throw new Error("must not be called");
  };
  assert.equal(await fetchCatalog({}, { fetcher }), null);
  assert.equal(await fetchCatalog(undefined, { fetcher }), null);
});
