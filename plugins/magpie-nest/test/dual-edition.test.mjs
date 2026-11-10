// 双版本渠道的回归：这 6 条每一条都是真机联网测试逼出来的集成 bug，
// 子代理的自测全绿却没拦住——因为自测不经过宿主重建的请求。
//
// 1. qoder 把上游路径当入站校验          → 全部 404
// 2. qoder-cn 的模型 key 与国际版不同     → 400 Unsupported model
// 3. trae 静态模型表猜不中               → 404 no such model
// 4. trae-global 把用量主机当模型主机     → 上游回 404 网页
// 5. workbuddy-ai 首条必须是 system      → 11128
// 6. 未枚举模型不得本地 404               → 厂商上新模型即失效

import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

/** 把 global fetch 换成桩，跑完恢复；返回桩收到的请求。 */
async function withStubbedFetch(responder, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    calls.push({ url, init, body: init?.body });
    return responder(url, init);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

const sse = () =>
  new Response('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const bearer = (n = 40) => ({ access: "a".repeat(n), key: "a".repeat(n), uid: "uid-1" });

// ---------- 1. qoder 入站路径 ----------

test("qoder: 宿主发来的 /chat/completions 必须被接受，而不是上游路径", async () => {
  const { QoderPlugin } = await import("../lib/qoder/index.mjs");
  const plugin = await QoderPlugin();
  await plugin.config({ provider: {} });
  const loader = await plugin.auth.loader(() => bearer());

  let status = null;
  await withStubbedFetch(
    () => new Response('{"error":"stub"}', { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const res = await loader.fetch("https://api3.qoder.sh/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qmodel_latest", messages: [{ role: "user", content: "hi" }], stream: false }),
      });
      status = res.status;
    },
  );
  // 桩回了非 SSE，解析会失败成 502——但绝不能是 404（那是路径判错）
  assert.notEqual(status, 404, "入站路径判据写成了上游 /agent_chat_generation");
});

test("qoder: 非 chat 路径仍然 404", async () => {
  const { QoderPlugin } = await import("../lib/qoder/index.mjs");
  const plugin = await QoderPlugin();
  await plugin.config({ provider: {} });
  const loader = await plugin.auth.loader(() => bearer());
  const res = await loader.fetch("https://api3.qoder.sh/algo/api/v2/model/list", { method: "GET" });
  assert.equal(res.status, 404);
});

// ---------- 2. qoder-cn 的模型 key ----------

test("qoder-cn 用 qmodel 族 key，不含国际版档位名", async () => {
  const { REGIONS } = await import("../lib/qoder/constants.mjs");
  const cn = REGIONS["qoder-cn"].models;
  // 联网实测：中国版网关对 ultimate/performance/efficient 一律 400
  for (const tier of ["ultimate", "performance", "efficient", "lite"]) {
    assert.equal(cn[tier], undefined, `中国版不该出现国际版档位 ${tier}`);
  }
  assert.ok(cn.qmodel_latest, "qmodel_latest 是实测可用的中国版模型");
  assert.ok(cn.qfmodel);
});

test("qoder 国际版保留档位名", async () => {
  const { REGIONS } = await import("../lib/qoder/constants.mjs");
  assert.ok(REGIONS.qoder.models.ultimate);
});

// ---------- 4. trae 主机映射 ----------

test("trae-global: 用量主机必须映射到模型主机", async () => {
  const { chatBaseOf } = await import("../lib/trae/index.mjs");
  const { REGIONS } = await import("../lib/trae/constants.mjs");
  const region = REGIONS["trae-global"];
  // api-sg-central / api-us-east / grow-* 都只服务用量或账号，只有 core* 能聊天
  for (const usage of [
    "https://api-sg-central.trae.ai",
    "https://api-us-east.trae.ai",
    "https://growsg-normal.trae.ai",
  ]) {
    const base = chatBaseOf(usage, region);
    assert.match(base, /core(sg|va)-normal\.trae\.ai/, `${usage} 应映射到模型主机，实得 ${base}`);
  }
  assert.equal(chatBaseOf("https://api-us-east.trae.ai", region), "https://coreva-normal.trae.ai");
  assert.equal(chatBaseOf("https://coresg-normal.trae.ai", region), "https://coresg-normal.trae.ai");
});

test("trae-cn: 账号自带的 API 主机就是模型主机", async () => {
  const { chatBaseOf } = await import("../lib/trae/index.mjs");
  const { REGIONS } = await import("../lib/trae/constants.mjs");
  assert.equal(
    chatBaseOf("https://trae-api-cn.mchost.guru", REGIONS["trae-cn"]),
    "https://trae-api-cn.mchost.guru",
  );
});

// ---------- 3 + 6. 未枚举模型放行 ----------

test("trae: 未枚举模型不再本地 404", async () => {
  const { TraeCnPlugin } = await import("../lib/trae/index.mjs");
  const plugin = await TraeCnPlugin();
  await plugin.config({ provider: {} });
  const loader = await plugin.auth.loader(() => ({
    access: "a".repeat(40),
    uid: "1713511876528812",
    machineId: "m1",
    deviceId: "d1",
  }));

  let status = null;
  await withStubbedFetch(
    () => sse(),
    async () => {
      const res = await loader.fetch("https://trae-api-cn.mchost.guru/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "brand-new-model-2099", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      status = res.status;
    },
  );
  assert.equal(status, 200, "账号目录随订阅变，静态表外的模型必须放行给上游");
});

test("qoder: 未枚举模型放行（静态表只用于展示）", async () => {
  const { QoderCnPlugin } = await import("../lib/qoder/index.mjs");
  const plugin = await QoderCnPlugin();
  await plugin.config({ provider: {} });
  const loader = await plugin.auth.loader(() => bearer());
  let status = null;
  await withStubbedFetch(
    () => new Response('{"error":"stub"}', { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const res = await loader.fetch("https://gateway.qoder.com.cn/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "never-listed-model", messages: [{ role: "user", content: "hi" }] }),
      });
      status = res.status;
    },
  );
  assert.notEqual(status, 404);
});

// ---------- 5. buddy 首条 system ----------

test("workbuddy-ai: 首条不是 system 时自动补一条", async () => {
  const { WorkBuddyAiPlugin } = await import("../lib/buddy/index.mjs");
  const plugin = await WorkBuddyAiPlugin();
  await plugin.config({ provider: {} });
  const loader = await plugin.auth.loader(() => ({ access: "a".repeat(40), key: "a".repeat(40) }));

  let sent = null;
  await withStubbedFetch(
    () => sse(),
    async () => {
      await loader.fetch("https://www.workbuddy.ai/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
    },
  ).then((calls) => {
    sent = calls[0]?.body;
  });

  assert.ok(sent, "应该发出了上游请求");
  const raw = typeof sent === "string" ? sent : Buffer.from(sent);
  let text;
  try {
    // 有的产品把请求体 gzip 后发出（product.gzip）
    text = gunzipSync(raw).toString("utf8");
  } catch {
    text = raw.toString("utf8");
  }
  const body = JSON.parse(text);
  assert.equal(body.messages[0].role, "system", "上游 11128：first message is not system prompt");
});

// ---------- 双版本 id 必须成对 ----------

test("有国内外两版的厂商，入口里两边都在", async () => {
  const pack = await import("../index.mjs");
  const pairs = [
    ["QwenAiPlugin", "QwenPlugin"],
    ["ZaiPlugin", "GlmPlugin"],
    ["QoderPlugin", "QoderCnPlugin"],
    ["TraeGlobalPlugin", "TraeCnPlugin"],
    ["WorkBuddyAiPlugin", "WorkBuddyPlugin"],
    ["AutoClawPlugin", "AutoClawCnPlugin"],
  ];
  for (const [intl, cn] of pairs) {
    assert.equal(typeof pack[intl], "function", `缺少国际版 ${intl}`);
    assert.equal(typeof pack[cn], "function", `缺少国内版 ${cn}`);
  }
});
