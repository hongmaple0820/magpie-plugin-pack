// MiniMax 插件测试：模型表、PKCE、OAuth 流、chat 协议翻译、远端模型目录。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMinimaxPkce,
  parseMinimaxDeviceAuthorization,
  parseMinimaxTokenGrant,
  refreshMinimaxCredential,
  MinimaxLoginCancelledError,
  MinimaxLoginExpiredError,
} from "../lib/minimax/login.mjs";

import {
  CHAT,
  MODEL_ROWS,
  fallbackEntry,
  modelEntry,
  modelRows,
  stripModel,
  SITE,
  MINIMAX_MODELS_PATH,
  MINIMAX_TOKEN_PATH,
} from "../lib/minimax/constants.mjs";

import { buildAnthropicPayload } from "../lib/minimax/chat.mjs";

import {
  normalizeModel,
  parseModelsPayload,
  fetchCatalog,
  resetCatalog,
} from "../lib/minimax/catalog.mjs";

// ---------- 常量与站点 ----------

test("minimax constants: 站点常量（实测确定的端点）", () => {
  assert.equal(SITE.id, "minimax");
  assert.equal(SITE.name, "MiniMax Code");
  assert.equal(SITE.authBase, "https://account.minimax.cn");
  // ⚠️ 不要改成 api.minimaxi.com —— 那是开放平台 API-key 产品，不是本渠道。
  assert.equal(SITE.api, "https://agent.minimax.cn");
  assert.equal(SITE.clientId, "mcode-public");
  assert.equal(SITE.audience, "agent-backend");
  assert.equal(SITE.scope, "agent.default");
});

test("minimax constants: CHAT 必须是 openai-compatible（入站 /chat/completions）", () => {
  assert.equal(CHAT, "@ai-sdk/openai-compatible");
});

test("minimax constants: TOKEN 与 MODELS 路径", () => {
  assert.equal(MINIMAX_TOKEN_PATH, "/oauth2/token");
  assert.equal(MINIMAX_MODELS_PATH, "/mavis/api/v1/models");
});

// ---------- 兜底模型表 ----------

test("minimax constants: 兜底模型 4 条，顺序照远端 model_order", () => {
  assert.equal(MODEL_ROWS.length, 4);
  assert.deepEqual(
    MODEL_ROWS.map((m) => m.key),
    ["MiniMax-M3.1-Flash-Preview", "MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.7"],
  );
});

test("minimax constants: M3.1 forced_on —— 6 档、defaultEffort=default、alwaysThinks", () => {
  const m = MODEL_ROWS[0];
  assert.equal(m.alwaysThinks, true);
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.efforts, ["default", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(m.defaultEffort, "default");
  assert.equal(m.thinkingMode, "forced_on");
  // 窗口取档位表最大档（1M），不是 limit.context 的 512K
  assert.equal(m.limit.context, 1_000_000);
});

test("minimax constants: M3 switchable —— 追加 on/none 两态（on 在前），不擅自设默认档", () => {
  const m = MODEL_ROWS[1];
  assert.equal(m.alwaysThinks, false);
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.efforts, ["on", "none"]);
  assert.deepEqual(m.variants, {
    on: { reasoningEffort: "on" },
    none: { reasoningEffort: "none" },
  });
  // M3 远端没有 default_effort → 不设（保持服务端默认 = 不思考）
  assert.equal(m.defaultEffort, "");
  assert.equal(m.thinkingMode, "switchable");
});

test("minimax constants: M2.7 系 forced_on 但没有档位 —— 不声明 reasoning", () => {
  for (const m of [MODEL_ROWS[2], MODEL_ROWS[3]]) {
    assert.equal(m.alwaysThinks, true);
    assert.deepEqual(m.efforts, []);
    assert.equal(m.reasoning, false);
    assert.equal(m.variants, undefined);
    assert.equal(m.thinkingMode, "forced_on");
  }
});

test("minimax constants: modelRows() 返回按 id 键控的对象（magpie 约定）", () => {
  const rows = modelRows();
  assert.equal(Array.isArray(rows), false);
  assert.deepEqual(Object.keys(rows), MODEL_ROWS.map((m) => m.key));
  assert.equal(rows["MiniMax-M3"].name, "M3");
});

test("minimax constants: modelEntry 命中静态行、未枚举给中性条目", () => {
  assert.equal(modelEntry("MiniMax-M3.1-Flash-Preview").name, "M3.1-Flash-Preview");
  const unknown = modelEntry("MiniMax-Next");
  assert.equal(unknown.key, "MiniMax-Next");
  assert.equal(unknown.isVl, false);
});

test("minimax constants: fallbackEntry 给中性目录项", () => {
  const e = fallbackEntry("unknown-model");
  assert.equal(e.key, "unknown-model");
  assert.equal(e.isVl, false);
  assert.equal(e.isReasoning, false);
  assert.equal(e.tool_call, true);
});

test("minimax constants: stripModel 去掉 'minimax/' 前缀", () => {
  assert.equal(stripModel("minimax/MiniMax-M3"), "MiniMax-M3");
  assert.equal(stripModel("MiniMax-M3"), "MiniMax-M3");
  assert.equal(stripModel(""), "");
});

// ---------- PKCE ----------

test("minimax PKCE: createMinimaxPkce 返回 verifier + challenge", () => {
  const { verifier, challenge } = createMinimaxPkce();
  assert.ok(typeof verifier === "string" && verifier.length > 0);
  assert.ok(typeof challenge === "string" && challenge.length > 0);
  assert.notEqual(verifier, challenge);
});

test("minimax PKCE: 多次调用产出不同值", () => {
  const a = createMinimaxPkce();
  const b = createMinimaxPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

// ---------- 设备码解析 ----------

test("minimax device authorization 解析: 标准字段全部解析", () => {
  const parsed = parseMinimaxDeviceAuthorization({
    device_code: "dc_abc",
    user_code: "ABC-DEF",
    verification_uri: "https://account.minimax.cn/device",
    expires_in: 1800,
    interval: 5,
  });
  assert.ok(parsed);
  assert.equal(parsed.deviceCode, "dc_abc");
  assert.equal(parsed.userCode, "ABC-DEF");
  assert.equal(parsed.verificationUri, "https://account.minimax.cn/device");
  assert.equal(parsed.verificationUriComplete, "https://account.minimax.cn/device?user_code=ABC-DEF");
  assert.equal(parsed.expiresInSec, 1800);
  assert.equal(parsed.intervalSec, 5);
});

test("minimax device authorization 解析: verification_url 兼容", () => {
  const parsed = parseMinimaxDeviceAuthorization({
    device_code: "dc",
    user_code: "UC",
    verification_url: "https://alt.com/device",
    expires_in: 600,
  });
  assert.ok(parsed);
  assert.equal(parsed.verificationUri, "https://alt.com/device");
});

test("minimax device authorization 解析: 缺字段返回 undefined", () => {
  assert.equal(parseMinimaxDeviceAuthorization({ device_code: "dc" }), undefined);
  assert.equal(parseMinimaxDeviceAuthorization(null), undefined);
  assert.equal(parseMinimaxDeviceAuthorization("string"), undefined);
});

// ---------- 令牌授予 ----------

test("minimax token grant 解析: 完整响应解析出 expires_at", () => {
  const before = Date.now();
  const grant = parseMinimaxTokenGrant(
    {
      access_token: "mmoat_xxx",
      refresh_token: "mmort_yyy",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "agent.default",
    },
    undefined,
  );
  assert.equal(grant.token_type, "Bearer");
  assert.ok(Number(grant.expires_at) >= before + 3_500_000);
  assert.ok(Number(grant.expires_at) <= before + 3_700_000);
});

test("minimax token grant 解析: refresh_token 缺失时回退 previous", () => {
  const grant = parseMinimaxTokenGrant(
    { access_token: "mmoat_xxx", token_type: "Bearer", expires_in: 3600, scope: "agent.default" },
    "previous_refresh",
  );
  assert.equal(grant.refresh_token, "previous_refresh");
});

test("minimax token grant 解析: 缺 access_token 抛错", () => {
  assert.throws(
    () =>
      parseMinimaxTokenGrant(
        { refresh_token: "r", token_type: "Bearer", expires_in: 1, scope: "agent.default" },
        undefined,
      ),
    /missing access_token/,
  );
});

test("minimax token grant 解析: token_type 非 bearer 抛错", () => {
  assert.throws(
    () =>
      parseMinimaxTokenGrant(
        { access_token: "a", refresh_token: "r", token_type: "MAC", expires_in: 1, scope: "agent.default" },
        undefined,
      ),
    /token_type must be bearer/,
  );
});

test("minimax token grant 解析: expires_in 非正数抛错", () => {
  assert.throws(
    () =>
      parseMinimaxTokenGrant(
        { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 0, scope: "agent.default" },
        undefined,
      ),
    /invalid expires_in/,
  );
});

test("minimax token grant 解析: scope 不含 agent.default 抛错", () => {
  assert.throws(
    () =>
      parseMinimaxTokenGrant(
        { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 1, scope: "other" },
        undefined,
      ),
    /scope must include agent.default/,
  );
});

test("minimax login 错误类: Cancelled / Expired 都带 name", () => {
  assert.equal(new MinimaxLoginCancelledError().name, "MinimaxLoginCancelledError");
  assert.equal(new MinimaxLoginExpiredError().name, "MinimaxLoginExpiredError");
});

test("minimax refreshMinimaxCredential 是 async function", () => {
  assert.equal(typeof refreshMinimaxCredential, "function");
  assert.equal(refreshMinimaxCredential.constructor.name, "AsyncFunction");
});

test("minimax chat 协议翻译: 静态表的 key 都能被 stripModel 还原", () => {
  for (const m of MODEL_ROWS) {
    assert.equal(stripModel(`minimax/${m.key}`), m.key);
  }
});

// ---------- thinking 请求体（根级 output_config） ----------

test("minimax chat payload: M3.1 带档位 → thinking.adaptive + 根级 output_config", () => {
  const payload = buildAnthropicPayload("MiniMax-M3.1-Flash-Preview", {
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
  });
  assert.deepEqual(payload.thinking, { type: "adaptive" });
  // ⚠️ output_config 必须与 thinking 并列在根级，不能塞进 thinking 里面
  assert.deepEqual(payload.output_config, { effort: "high" });
});

test("minimax chat payload: M3.1 无档位 → 只发 adaptive（不传 disabled，会被硬 400）", () => {
  const payload = buildAnthropicPayload("MiniMax-M3.1-Flash-Preview", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(payload.thinking, { type: "adaptive" });
  assert.equal(payload.output_config, undefined);
});

test("minimax chat payload: M3.1 传 none → 仍退成 adaptive（服务端硬 400 2013）", () => {
  const payload = buildAnthropicPayload("MiniMax-M3.1-Flash-Preview", {
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "none",
  });
  assert.deepEqual(payload.thinking, { type: "adaptive" });
});

test("minimax chat payload: M3 none → thinking disabled；on → adaptive", () => {
  const off = buildAnthropicPayload("MiniMax-M3", {
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "none",
  });
  assert.deepEqual(off.thinking, { type: "disabled" });

  const on = buildAnthropicPayload("MiniMax-M3", {
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "on",
  });
  assert.deepEqual(on.thinking, { type: "adaptive" });
});

test("minimax chat payload: M3 不给档位 → 整个不发 thinking（= 不思考）", () => {
  const payload = buildAnthropicPayload("MiniMax-M3", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(payload.thinking, undefined);
  assert.equal(payload.output_config, undefined);
});

test("minimax chat payload: M2.7 系永不发 thinking", () => {
  for (const model of ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]) {
    const payload = buildAnthropicPayload(model, {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(payload.thinking, undefined);
  }
});

test("minimax chat payload: OpenAI messages 转 Anthropic 形态（tool 结果进 user 块）", () => {
  const payload = buildAnthropicPayload("MiniMax-M3", {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "调用工具" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "文件内容" },
    ],
  });
  assert.equal(payload.system, "sys");
  assert.equal(payload.messages[1].role, "assistant");
  assert.equal(payload.messages[1].content[0].type, "tool_use");
  assert.deepEqual(payload.messages[1].content[0].input, { path: "a" });
  assert.equal(payload.messages[2].role, "user");
  assert.equal(payload.messages[2].content[0].type, "tool_result");
  assert.equal(payload.messages[2].content[0].tool_use_id, "call_1");
});

// ---------- 远端模型目录 ----------

test("minimax catalog: normalizeModel 归一（窗口取档位表最大档）", () => {
  const entry = normalizeModel({
    id: "MiniMax-M3.1-Flash-Preview",
    name: "M3.1-Flash-Preview",
    limit: { context: 512000, output: 128000 },
    context_window_options: [512000, 1000000],
    modalities: { input: ["text", "image"] },
    effort_options: ["default", "low", "high"],
    default_effort: "high",
    thinking_config: { mode: "forced_on" },
  });
  assert.equal(entry.id, "MiniMax-M3.1-Flash-Preview");
  assert.equal(entry.name, "M3.1-Flash-Preview");
  assert.equal(entry.contextWindow, 1_000_000);
  assert.equal(entry.maxTokens, 128_000);
  assert.equal(entry.supportsImage, true);
  assert.deepEqual(entry.effortOptions, ["default", "low", "high"]);
  assert.equal(entry.defaultEffort, "high");
  assert.equal(entry.thinkingMode, "forced_on");
});

test("minimax catalog: normalizeModel —— 默认档不在档位表内就丢掉", () => {
  const entry = normalizeModel({
    id: "M",
    effort_options: ["low"],
    default_effort: "max",
  });
  assert.equal(entry.defaultEffort, undefined);
  assert.equal(entry.contextWindow, 0); // 未知窗口填 0，不编造
  assert.equal(entry.maxTokens, undefined);
  assert.equal(entry.thinkingMode, undefined);
});

test("minimax catalog: parseModelsPayload 取 minimax provider 并按 model_order 排序", () => {
  const entries = parseModelsPayload({
    providers: [
      {
        providerId: "minimax",
        config: {
          models: {
            "MiniMax-M2.7": { name: "M2.7", limit: { context: 200000, output: 128000 } },
            "MiniMax-M3": { name: "M3", limit: { context: 1000000, output: 128000 } },
          },
          model_order: ["MiniMax-M3", "MiniMax-M2.7"],
        },
      },
    ],
  });
  assert.deepEqual(entries.map((e) => e.id), ["MiniMax-M3", "MiniMax-M2.7"]);
});

test("minimax catalog: parseModelsPayload 无 minimax provider → 空数组", () => {
  assert.deepEqual(parseModelsPayload({ providers: [{ providerId: "other" }] }), []);
  assert.deepEqual(parseModelsPayload({}), []);
  assert.deepEqual(parseModelsPayload(null), []);
});

test("minimax catalog: fetchCatalog 失败返回 null（调用方保留兜底表）", async () => {
  resetCatalog();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 401 });
  try {
    assert.equal(await fetchCatalog("token-a"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("minimax catalog: fetchCatalog 成功返回按 id 键控的对象，并命中缓存", async () => {
  resetCatalog();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        providers: [
          {
            providerId: "minimax",
            config: {
              models: { "MiniMax-M3": { name: "M3", limit: { context: 1000000, output: 128000 } } },
              model_order: ["MiniMax-M3"],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const rows = await fetchCatalog("token-b");
    assert.deepEqual(Object.keys(rows), ["MiniMax-M3"]);
    assert.equal(rows["MiniMax-M3"].name, "M3");
    assert.equal(rows["MiniMax-M3"].limit.context, 1_000_000);
    // 缓存：第二次不再打网络
    await fetchCatalog("token-b");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    resetCatalog();
  }
});

test("minimax catalog: fetchCatalog 解析出 0 条也回退兜底表（返回 null）", async () => {
  resetCatalog();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ providers: [{ providerId: "minimax", config: { models: {} } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    assert.equal(await fetchCatalog("token-c"), null);
  } finally {
    globalThis.fetch = original;
    resetCatalog();
  }
});
