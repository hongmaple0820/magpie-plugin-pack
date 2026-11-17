// Cline 插件测试：常量/档位、兜底模型表、设备码登录、续期、工具 schema 清洗、
// reasoning 搬家、远端推荐目录（含缓存与失败回退）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  API_BASE,
  CHAT_PATH,
  CLIENT_HEADERS,
  DEFAULT_REASONING_EFFORT,
  EFFORTS,
  EFFORT_IDS,
  MODEL_ROWS,
  NPM,
  RECOMMENDED_PATH,
  SITE,
  TOKEN_PREFIX,
  VARIANTS,
  WORKOS_CLIENT_ID,
  fallbackEntry,
  modelEntry,
  modelRows,
  nameFromId,
  stripModel,
  toModelRow,
} from "../lib/cline/constants.mjs";

import {
  ClineLoginCancelledError,
  ClineLoginExpiredError,
  deviceSignIn,
  parseClineAccountPayload,
  parseClineDeviceAuthorization,
  parseVendorTokenGrant,
  refreshClineCredential,
  toExpiresMs,
  withTokenPrefix,
} from "../lib/cline/login.mjs";

import {
  fetchCatalog,
  parseRecommended,
  resetCatalog,
  toRows,
} from "../lib/cline/catalog.mjs";

import {
  ask,
  rewriteChunk,
  rewriteReasoning,
  rewriteSseLine,
  sanitizeParameters,
} from "../lib/cline/chat.mjs";

// ---------- 常量与站点 ----------

test("cline constants: 实测端点与头族", () => {
  assert.equal(SITE.id, "cline");
  assert.equal(SITE.name, "Cline");
  assert.equal(SITE.api, "https://api.cline.bot");
  assert.equal(API_BASE, "https://api.cline.bot");
  assert.equal(CHAT_PATH, "/api/v1/chat/completions");
  assert.equal(RECOMMENDED_PATH, "/api/v1/ai/cline/recommended-models");
  assert.equal(WORKOS_CLIENT_ID, "client_01K3A541FN8TA3EPPHTD2325AR");
  assert.equal(TOKEN_PREFIX, "workos:");
  // 上游就是 openai-compatible：声明 anthropic 会让入站变成 /v1/messages
  assert.equal(NPM, "@ai-sdk/openai-compatible");
  assert.deepEqual(CLIENT_HEADERS, {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
  });
});

test("cline constants: 思考档位共用一张表，默认 High，键是 wire id", () => {
  assert.deepEqual(EFFORT_IDS, ["none", "low", "medium", "high", "max"]);
  assert.equal(DEFAULT_REASONING_EFFORT, "high");
  // 键必须是 wire id：magpie 只取 Object.keys 当档位名（值被丢弃），
  // 用显示名（None/Extra）会让 DSH 里一个档位都不显示。
  assert.deepEqual(Object.keys(VARIANTS), ["none", "low", "medium", "high", "max"]);
  assert.deepEqual(VARIANTS.max, { reasoningEffort: "max" });
  assert.deepEqual(VARIANTS.none, { reasoningEffort: "none" });
  assert.equal(EFFORTS.length, 5);
});

test("cline constants: 兜底表就是当日实测免费的三条", () => {
  assert.deepEqual(MODEL_ROWS.map((row) => row.key), [
    "cline-free/nemotron-3.5-super-vl",
    "cline-free/solar-mini4",
    "nvidia/nemotron-3.5-lightning-free",
  ]);
  // 第三条既不是 cline-free/ 前缀也不是 :free 后缀 —— 只能靠远端 free[] 判定
  assert.ok(!MODEL_ROWS[2].key.startsWith("cline-free/"));
  assert.ok(!MODEL_ROWS[2].key.endsWith(":free"));
});

test("cline constants: 模型行形态（magpie 约定的键控对象）", () => {
  const rows = modelRows();
  assert.equal(Object.keys(rows).length, 3);
  assert.ok(!Array.isArray(rows));

  const row = rows["cline-free/nemotron-3.5-super-vl"];
  assert.equal(row.name, "Nemotron 3.5 Super VL");
  assert.equal(row.limit.context, 200_000);
  assert.equal(row.limit.output, 0); // 未知就填 0，不编造
  assert.equal(row.attachment, true);
  assert.deepEqual(row.modalities.input, ["text", "image"]);
  assert.equal(row.reasoning, true);
  assert.deepEqual(row.efforts, ["none", "low", "medium", "high", "max"]);
  assert.equal(row.defaultEffort, "high");
  assert.equal(row.tool_call, true);
  assert.equal(row.key, "cline-free/nemotron-3.5-super-vl");
  assert.equal(row.source, "system");
  assert.equal(row.format, "openai");
  assert.equal(row.isVl, true);

  // 非多模态那条不给图片
  const text = rows["cline-free/solar-mini4"];
  assert.equal(text.attachment, false);
  assert.deepEqual(text.modalities.input, ["text"]);
});

test("cline constants: toModelRow 保存不确定的窗口而不编造", () => {
  const row = toModelRow({ id: "x/y", name: "" });
  assert.equal(row.limit.context, 200_000);
  assert.equal(row.limit.output, 0);
  assert.equal(row.name, "Y");
});

test("cline constants: nameFromId 剥 cline-free/ 与 :free 再转标题", () => {
  assert.equal(nameFromId("cline-free/solar-mini4"), "Solar Mini4");
  assert.equal(nameFromId("nvidia/nemotron-3.5-lightning-free"), "Nemotron 3.5 Lightning Free");
  assert.equal(nameFromId("meta/muse-ember"), "Muse Ember");
});

test("cline constants: modelEntry 命中兜底表，未枚举给中性项", () => {
  assert.equal(modelEntry("cline-free/solar-mini4").name, "Solar Mini 4");
  const neutral = modelEntry("anthropic/claude-sonnet-5.5");
  assert.equal(neutral.key, "anthropic/claude-sonnet-5.5");
  assert.equal(neutral.limit.output, 0);
  // 中立项也带共用档位表：远端对所有模型都认这张表
  assert.equal(neutral.reasoning, true);
  assert.deepEqual(fallbackEntry("a/b").efforts, EFFORT_IDS);
});

test("cline constants: stripModel 只剥自己的前缀", () => {
  assert.equal(stripModel("cline/cline-free/solar-mini4"), "cline-free/solar-mini4");
  assert.equal(stripModel("cline-free/solar-mini4"), "cline-free/solar-mini4");
  assert.equal(stripModel(undefined), "");
});

// ---------- 令牌前缀 ----------

test("cline login: withTokenPrefix 保留/补上 workos:（剥掉即 401）", () => {
  assert.equal(withTokenPrefix("eyJabc"), "workos:eyJabc");
  assert.equal(withTokenPrefix("workos:eyJabc"), "workos:eyJabc");
  assert.equal(withTokenPrefix("  workos: eyJ "), "workos: eyJ".replace(" ", " "));
  assert.equal(withTokenPrefix(""), "");
  assert.equal(withTokenPrefix(undefined), "");
});

test("cline login: toExpiresMs 接受 ISO / epoch 秒 / epoch 毫秒", () => {
  assert.equal(toExpiresMs("2026-11-17T10:00:00.000Z"), String(Date.parse("2026-11-17T10:00:00.000Z")));
  assert.equal(toExpiresMs(1_763_000_000), "1763000000000");
  assert.equal(toExpiresMs(1_763_000_000_000), "1763000000000");
  assert.equal(toExpiresMs("1763000000"), "1763000000000");
  assert.equal(toExpiresMs(""), undefined);
  assert.equal(toExpiresMs("not a date"), undefined);
});

// ---------- 设备码 ----------

test("cline login: 解析设备码响应（实测量到的形状）", () => {
  const parsed = parseClineDeviceAuthorization({
    device_code: "93R9iOq".padEnd(64, "x"),
    user_code: "ZGXQ-WQHW",
    verification_uri: "https://authkit.cline.bot/device",
    verification_uri_complete: "https://authkit.cline.bot/device?user_code=ZGXQ-WQHW",
    expires_in: 300,
    interval: 5,
  });
  assert.equal(parsed.userCode, "ZGXQ-WQHW");
  assert.equal(parsed.verificationUri, "https://authkit.cline.bot/device");
  assert.equal(parsed.verificationUriComplete, "https://authkit.cline.bot/device?user_code=ZGXQ-WQHW");
  assert.equal(parsed.expiresInSec, 300);
  assert.equal(parsed.intervalSec, 5);
});

test("cline login: 设备码缺字段返回 undefined，interval 缺省 5", () => {
  assert.equal(parseClineDeviceAuthorization(null), undefined);
  assert.equal(parseClineDeviceAuthorization({ device_code: "x" }), undefined);
  const parsed = parseClineDeviceAuthorization({
    device_code: "d",
    user_code: "u",
    verification_uri: "https://x/device",
    expires_in: 300,
  });
  assert.equal(parsed.intervalSec, 5);
  assert.equal(parsed.verificationUriComplete, "https://x/device?user_code=u");
});

test("cline login: WorkOS 令牌响应必须是 bearer", () => {
  assert.deepEqual(parseVendorTokenGrant({ access_token: "workos:a", refresh_token: "r", token_type: "bearer" }), {
    accessToken: "workos:a",
    refreshToken: "r",
    tokenType: "Bearer",
  });
  assert.throws(() => parseVendorTokenGrant({ refresh_token: "r" }), /access_token/);
  assert.throws(() => parseVendorTokenGrant({ access_token: "a", token_type: "mac" }), /bearer/);
});

test("cline login: 账号信封判据是 success && data.accessToken（失败信封不算成功）", () => {
  assert.equal(parseClineAccountPayload({ success: false, data: "" }), undefined);
  assert.equal(parseClineAccountPayload({ success: true, data: {} }), undefined);
  assert.equal(parseClineAccountPayload("nope"), undefined);

  const account = parseClineAccountPayload({
    success: true,
    data: {
      accessToken: "workos:acc",
      refreshToken: "ref",
      expiresAt: "2026-11-18T00:00:00.000Z",
      userInfo: { clineUserId: "u_1", email: "a@b.c", name: "Ada" },
    },
  });
  assert.equal(account.access, "workos:acc");
  assert.equal(account.refresh, "ref");
  assert.equal(account.expires, String(Date.parse("2026-11-18T00:00:00.000Z")));
  assert.equal(account.accountId, "u_1");
  assert.equal(account.email, "a@b.c");
  assert.equal(account.name, "Ada");
});

test("cline login: 信封字段容错下划线形态", () => {
  const account = parseClineAccountPayload({
    success: true,
    data: { access_token: "workos:u", refresh_token: "r2", expires_at: "2026-11-18T00:00:00Z", user_info: { user_id: "u_2" } },
  });
  assert.equal(account.access, "workos:u");
  assert.equal(account.refresh, "r2");
  assert.equal(account.accountId, "u_2");
  assert.ok(account.expires);
});

// ---------- 续期 ----------

test("cline login: 续期用驼峰表单 {refreshToken, grantType}", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      success: true,
      data: { accessToken: "workos:new", refreshToken: "ref2", expiresAt: "2026-11-18T00:00:00.000Z" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await refreshClineCredential(SITE, "ref");
    assert.equal(out.token, "workos:new");
    assert.equal(out.refresh, "ref2");
    assert.equal(out.expires, String(Date.parse("2026-11-18T00:00:00.000Z")));

    assert.equal(calls[0].url, "https://api.cline.bot/api/v1/auth/refresh");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { refreshToken: "ref", grantType: "refresh_token" });
  } finally {
    globalThis.fetch = original;
  }
});

test("cline login: 续期没有 refresh token 直接报错", async () => {
  await assert.rejects(() => refreshClineCredential(SITE, ""), /重新登录/);
});

test("cline login: 续期 200 但信封成功标记为 false → 报错（不把失败当成功）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: {} }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(() => refreshClineCredential(SITE, "ref"), /没有 accessToken/);
  } finally {
    globalThis.fetch = original;
  }
});

test("cline login: 续期 400 invalid_grant → 抛出上游原话", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: "", error: "failed to refresh token: invalid_grant", success: false }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(() => refreshClineCredential(SITE, "ref"), /invalid_grant/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- 设备码全流程 ----------

test("cline login: 设备码全流程（pending → 令牌 → register 换成账号凭据）", async () => {
  const original = globalThis.fetch;
  const seen = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push(`${init?.method ?? "GET"} ${u}`);
    if (u.endsWith("/user_management/authorize/device")) {
      return new Response(JSON.stringify({
        device_code: "dev-1",
        user_code: "CODE-1",
        verification_uri: "https://authkit.cline.bot/device",
        verification_uri_complete: "https://authkit.cline.bot/device?user_code=CODE-1",
        expires_in: 300,
        interval: 0.001,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/user_management/authenticate")) {
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: "raw-access", refresh_token: "raw-refresh", token_type: "bearer" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/v1/auth/register")) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          accessToken: "workos:reg-access",
          refreshToken: "reg-refresh",
          expiresAt: "2026-11-18T00:00:00.000Z",
          userInfo: { clineUserId: "u_9", email: "x@y.z" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const flow = deviceSignIn(SITE);
    assert.equal(flow.method, "auto");
    assert.equal(flow.url, "https://api.workos.com/user_management/authorize/device");
    const result = await flow.callback();
    assert.equal(result.type, "success");
    assert.equal(result.access, "workos:reg-access"); // register 的令牌带前缀
    assert.equal(result.refresh, "reg-refresh");
    assert.equal(result.uid, "u_9");
    assert.equal(result.email, "x@y.z");
    assert.ok(result.expires);
    assert.equal(polls, 2);
    // 认证请求带 device_code 与 client_id
    assert.ok(seen.some((line) => line.includes("authenticate")));
  } finally {
    globalThis.fetch = original;
  }
});

test("cline login: 用户拒绝 → CancelledError；invalid_grant → ExpiredError", async () => {
  const original = globalThis.fetch;
  const deviceRes = () => new Response(JSON.stringify({
    device_code: "dev-2",
    user_code: "CODE-2",
    verification_uri: "https://authkit.cline.bot/device",
    expires_in: 300,
    interval: 0.001,
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    let outcome = "access_denied";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/authorize/device")) return deviceRes();
      return new Response(JSON.stringify({ error: outcome }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    };
    await assert.rejects(() => deviceSignIn(SITE).callback(), ClineLoginCancelledError);

    // 2026-11-17 实测：假 device_code 就是 invalid_grant
    outcome = "invalid_grant";
    await assert.rejects(() => deviceSignIn(SITE).callback(), ClineLoginExpiredError);
  } finally {
    globalThis.fetch = original;
  }
});

test("cline login: register 挂了也用已经拿到的 WorkOS 令牌（前缀补齐）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/authorize/device")) {
      return new Response(JSON.stringify({
        device_code: "dev-3",
        user_code: "C-3",
        verification_uri: "https://authkit.cline.bot/device",
        expires_in: 300,
        interval: 0.001,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/user_management/authenticate")) {
      return new Response(JSON.stringify({ access_token: "bare-access", refresh_token: "bare-refresh", token_type: "bearer" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    // register 500（实测形态）
    return new Response(JSON.stringify({ error: "failed to refresh tokens: 500 boom", success: false }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await deviceSignIn(SITE).callback();
    assert.equal(result.access, "workos:bare-access");
    assert.equal(result.refresh, "bare-refresh");
    assert.equal(result.expires, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- 工具 schema 清洗 ----------

test("cline chat: enum 里的空字符串被删掉，数字/布尔枚举保留", () => {
  const cleaned = sanitizeParameters({
    type: "object",
    properties: {
      mode: { type: "string", enum: ["", "fast", "slow"] },
      only: { type: "string", enum: [""] },
      num: { type: "number", enum: [0, 1, 2] },
      flag: { type: "boolean", enum: [true, false] },
      nested: {
        type: "object",
        properties: { deep: { type: "string", enum: ["", "x"] } },
      },
    },
  });
  assert.deepEqual(cleaned.properties.mode.enum, ["fast", "slow"]);
  // 清完为空 → 整个 enum 键删掉（不是留 enum: []）
  assert.ok(!("enum" in cleaned.properties.only));
  assert.deepEqual(cleaned.properties.num.enum, [0, 1, 2]);
  assert.deepEqual(cleaned.properties.flag.enum, [true, false]);
  assert.deepEqual(cleaned.properties.nested.properties.deep.enum, ["x"]);
});

test("cline chat: sanitizeParameters 不动没有 enum 的 schema", () => {
  const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  assert.deepEqual(sanitizeParameters(schema), schema);
});

// ---------- reasoning 搬家 ----------

test("cline chat: delta.reasoning → reasoning_content（旧键删掉，不双份）", () => {
  const holder = rewriteReasoning({ reasoning: "想一下", content: "答案" });
  assert.equal(holder.reasoning_content, "想一下");
  assert.ok(!("reasoning" in holder));
  assert.equal(holder.content, "答案");
});

test("cline chat: 已有 reasoning_content 时不覆盖；空 reasoning 不补写", () => {
  const keep = rewriteReasoning({ reasoning: "上游", reasoning_content: "已有" });
  assert.equal(keep.reasoning_content, "已有");
  const empty = rewriteReasoning({ reasoning: "" });
  assert.equal(empty.reasoning_content, undefined);
});

test("cline chat: rewriteChunk 同时处理 delta 与 message", () => {
  const chunk = rewriteChunk({
    choices: [
      { index: 0, delta: { reasoning: "r" } },
      { index: 1, message: { reasoning: "m" } },
      { index: 2 },
    ],
  });
  assert.equal(chunk.choices[0].delta.reasoning_content, "r");
  assert.equal(chunk.choices[1].message.reasoning_content, "m");
  assert.deepEqual(chunk.choices[2], { index: 2 });
  // 非 chunk 形状原样返回
  assert.deepEqual(rewriteChunk({ ok: 1 }), { ok: 1 });
});

test("cline chat: rewriteSseLine 只动 data: 帧，其它原样", () => {
  assert.equal(rewriteSseLine(""), "");
  assert.equal(rewriteSseLine("event: message"), "event: message");
  assert.equal(rewriteSseLine("data: [DONE]"), "data: [DONE]");
  assert.equal(rewriteSseLine("data: not json"), "data: not json");

  const line = rewriteSseLine('data: {"choices":[{"index":0,"delta":{"reasoning":"hmm"}}]}');
  assert.ok(line.startsWith("data: "));
  const frame = JSON.parse(line.slice(5));
  assert.equal(frame.choices[0].delta.reasoning_content, "hmm");
  assert.ok(!("reasoning" in frame.choices[0].delta));
});

// ---------- 推理透传 ----------

test("cline chat: ask 发 workos: 前缀的 Bearer + Cline 头族，并清洗工具 schema", async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({
      id: "x",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi", reasoning: "think" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await ask(
      {
        model: "cline/cline-free/solar-mini4",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: { e: { type: "string", enum: ["", "a"] } } } } }],
      },
      { access: "eyJtok" },
      undefined,
      SITE,
    );
    assert.equal(captured.url, "https://api.cline.bot/api/v1/chat/completions");
    assert.equal(captured.init.headers.Authorization, "Bearer workos:eyJtok");
    assert.equal(captured.init.headers["X-TITLE"], undefined);
    assert.equal(captured.init.headers["X-Title"], "Cline");
    assert.equal(captured.init.headers["X-CLIENT-TYPE"], "cline-sdk");

    const sent = JSON.parse(captured.init.body);
    assert.equal(sent.model, "cline-free/solar-mini4"); // 前缀已剥
    assert.deepEqual(sent.tools[0].function.parameters.properties.e.enum, ["a"]);

    const out = await res.json();
    assert.equal(out.choices[0].message.reasoning_content, "think");
    assert.ok(!("reasoning" in out.choices[0].message));
    assert.equal(out.choices[0].message.content, "hi");
  } finally {
    globalThis.fetch = original;
  }
});

test("cline chat: 流式响应把 reasoning 帧改成 reasoning_content（其余字节不变）", async () => {
  const original = globalThis.fetch;
  const sseBody = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"reasoning":"step 1"}}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"content":"答"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  globalThis.fetch = async () => new Response(sseBody, {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
  try {
    const res = await ask({ model: "m", stream: true, messages: [] }, { access: "workos:t" }, undefined, SITE);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.match(text, /"reasoning_content":"step 1"/);
    assert.doesNotMatch(text, /"reasoning":/);
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /"content":"答"/);
  } finally {
    globalThis.fetch = original;
  }
});

test("cline chat: 无 token → 本地 401 且带 sign-in 头", async () => {
  await assert.rejects(() => ask({ model: "m", messages: [] }, {}, undefined, SITE), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.signIn, "expired");
    return true;
  });
});

test("cline chat: 401 上游 → expired；403 地域限制 → kept 并带原话", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account." }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    const res = await ask({ model: "m", messages: [] }, { access: "workos:t" }, undefined, SITE);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired");

    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "Cline is not available in your region." }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    const blocked = await ask({ model: "m", messages: [] }, { access: "workos:t" }, undefined, SITE);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("x-magpie-sign-in"), "kept");
    assert.match((await blocked.json()).error.message, /本地区不可用/);
  } finally {
    globalThis.fetch = original;
  }
});

test("cline chat: 402/429 判为额度问题（可换号，不判登录过期）", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "insufficient credits" }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const res = await ask({ model: "m", messages: [] }, { access: "workos:t" }, undefined, SITE);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept");
    assert.match((await res.json()).error.message, /额度用尽/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- 远端推荐目录 ----------

test("cline catalog: parseRecommended 取 free/recommended/clinePass", () => {
  const lists = parseRecommended({
    recommended: ["meta/muse-ember", { id: "anthropic/claude-sonnet-5.5" }],
    free: ["cline-free/solar-mini4"],
    clinePass: ["cline-pass/deepseek-v4-pro"],
    clineCloud: ["x"],
  });
  assert.deepEqual(lists.free, ["cline-free/solar-mini4"]);
  assert.deepEqual(lists.recommended, ["meta/muse-ember", "anthropic/claude-sonnet-5.5"]);
  assert.deepEqual(lists.clinePass, ["cline-pass/deepseek-v4-pro"]);
  assert.equal(parseRecommended({}), undefined);
  assert.equal(parseRecommended(null), undefined);
});

test("cline catalog: toRows 免费优先、去重、兜底表元数据优先", () => {
  const rows = toRows({
    free: ["nvidia/nemotron-3.5-lightning-free", "cline-free/solar-mini4"],
    recommended: ["cline-free/solar-mini4", "meta/muse-ember"],
    clinePass: [],
  });
  assert.deepEqual(Object.keys(rows), [
    "nvidia/nemotron-3.5-lightning-free",
    "cline-free/solar-mini4",
    "meta/muse-ember",
  ]);
  // 兜底表认识的 id 用兜底表元数据（有名字）
  assert.equal(rows["cline-free/solar-mini4"].name, "Solar Mini 4");
  // 不认识的由 id 派生
  assert.equal(rows["meta/muse-ember"].name, "Muse Ember");
  assert.equal(rows["meta/muse-ember"].limit.output, 0);
});

test("cline catalog: fetchCatalog 成功写入缓存，第二次不再请求", async () => {
  resetCatalog();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), "https://api.cline.bot/api/v1/ai/cline/recommended-models");
    return new Response(JSON.stringify({
      recommended: ["meta/muse-ember"],
      free: ["cline-free/solar-mini4"],
      clinePass: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const first = await fetchCatalog(SITE);
    assert.deepEqual(Object.keys(first), ["cline-free/solar-mini4", "meta/muse-ember"]);
    const second = await fetchCatalog(SITE);
    assert.deepEqual(Object.keys(second), ["cline-free/solar-mini4", "meta/muse-ember"]);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    resetCatalog();
  }
});

test("cline catalog: 过期后重新请求", async () => {
  resetCatalog();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ free: ["cline-free/solar-mini4"] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const t0 = 1_000_000;
    await fetchCatalog(SITE, { now: t0 });
    await fetchCatalog(SITE, { now: t0 + 300_001 });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    resetCatalog();
  }
});

test("cline catalog: 非 2xx / 解析出 0 条 → null（调用方保留兜底表）", async () => {
  resetCatalog();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    assert.equal(await fetchCatalog(SITE), null);

    globalThis.fetch = async () => new Response(JSON.stringify({ recommended: [], free: [], clinePass: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    assert.equal(await fetchCatalog(SITE), null);
  } finally {
    globalThis.fetch = original;
    resetCatalog();
  }
});
