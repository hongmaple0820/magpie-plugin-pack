/**
 * 整个插件的端到端测试（纯 mock fetch，不碰真实厂商）。
 * 覆盖：入口导出、config、网页登录（SSO URL + 粘贴回跳地址）、双通道模型并集、
 *       usage 窗口、loader.fetch 的双通道路由、Orbit 协议桥、refresh。
 * 独立脚本：node test/integration.test.mjs 或 bun test/integration.test.mjs。
 */
import assert from "node:assert/strict";
import * as entry from "../index.mjs";
import { InkstoneAuthPlugin } from "../index.mjs";
import { authHeaders, orbitHeaders } from "../lib/http.mjs";
import { readSsoCallbackCode } from "../lib/sso.mjs";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✓ ${name}`);
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
const JWT = `hdr.${b64url({ ssoUid: "u-1", username: "ada", exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`;
const CALLS = [];

function json(data, status = 200) {
  return new Response(JSON.stringify({ code: 0, msg: "ok", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function sse(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}
const orbitFrame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const openaiFrame = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: "glm-5.2", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  CALLS.push({ url: u, init });
  if (u.includes("/users/auth")) return json({ token: JWT });
  if (u.includes("/users/getUserInfo")) return json({ ssoUid: "u-1", username: "ada" });
  if (u.endsWith("/tokenplan/v1/keys")) return json({ id: "key-1", name: "magpie-inkstone", key: "sk-test-123" });
  if (u.includes("/orbit/v1/local-agent/models")) {
    return json({ models: [
      { id: "agents-a1", canonical_id: "agents-a1-2026", display_name: "书生-Agents-A1", context_window: 200000, max_output_tokens: 8192, supports_thinking: true },
      { id: "glm-5.2", canonical_id: "glm-5.2", display_name: "GLM-5.2" },
      { id: "auto", canonical_id: "auto", display_name: "Auto" },
    ] });
  }
  if (u.includes("/tokenplan/v1/models")) {
    return json({ models: [
      { id: "glm-5.2", display_name: "GLM-5.2", supported_protocols: ["openai_chat"], capabilities: ["工具调用"], input_types: ["text"], context_length: 128000, input_uncached_price: 0, output_price: 0 },
      { id: "s2-api", display_name: "S2 API", supported_protocols: ["openai_chat"], capabilities_en: ["reasoning"], input_types: ["text", "image"], context_length: 200000, input_uncached_price: 3, output_price: 15 },
      { id: "responses-only", supported_protocols: ["openai_responses"] },
    ] });
  }
  if (u.includes("/credits/balance")) {
    return json({
      available_credits: 6291,
      usage_windows: {
        "5h": { remaining_credits: 630, limit_credits: 1000, next_recover_at: "2026-11-07T12:00:00Z" },
        "7d": { remaining_credits: 5000, limit_credits: 10000, next_recover_at: "2026-11-14T00:00:00Z" },
      },
    });
  }
  if (u.includes("/credits/packages")) {
    return json({ packages: [{ remark: "Pro", current_cycle: { end_at: "2026-12-01T00:00:00Z" } }] });
  }
  if (u.includes("/orbit/v1/chat/new")) return json({ id: 42 });
  if (u.includes("/orbit/v1/local-agent/messages")) {
    return sse([
      orbitFrame("content_delta", { text: "你好" }),
      orbitFrame("usage", { usage: { input_tokens: 7, output_tokens: 2 } }),
      orbitFrame("message_end", { stop_reason: "end_turn" }),
    ]);
  }
  if (u.includes("discovery-api.intern-ai.org.cn/v1/chat/completions")) {
    return sse([openaiFrame({ content: "API OK" }), openaiFrame({}, "stop"), "data: [DONE]\n\n"]);
  }
  throw new Error(`unexpected fetch: ${u}`);
};

/* ---- 0) 入口只导出一个插件函数（其它导出函数会被 magpie 当成插件调用） ---- */
{
  const fns = Object.entries(entry).filter(([, v]) => typeof v === "function");
  assert.equal(fns.length, 1, "入口不应导出辅助函数");
  assert.equal(fns[0][0], "InkstoneAuthPlugin");
  assert.equal(authHeaders("abc").Cookie, "uaa-token=abc", "管理面 Cookie 头");
  assert.equal(authHeaders("abc").Authorization, "Bearer abc");
  assert.equal(orbitHeaders("abc", "u-1").id, "u-1", "Orbit id 头");
  ok("入口单一导出 + 双鉴权头（Bearer / Cookie uaa-token / id）");
}

const hooks = await InkstoneAuthPlugin({}, undefined);
assert.ok(hooks.config && hooks.auth && hooks.provider);
assert.equal(hooks.auth.provider, "inkstone");
assert.equal(hooks.auth.methods.length, 2);

/* ---- 1) config ---- */
{
  const cfg = {};
  await hooks.config(cfg);
  const provider = cfg.provider.inkstone;
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.api, "https://discovery-api.intern-ai.org.cn/v1");
  assert.ok(Object.keys(provider.models).length >= 8);
  // 不覆盖用户已有配置
  const cfg2 = { provider: { inkstone: { name: "自定义" } } };
  await hooks.config(cfg2);
  assert.equal(cfg2.provider.inkstone.name, "自定义");
  ok("config: 供应商声明 + 静态模型 + ??= 不覆盖用户配置");
}

/* ---- 2) 网页登录（methods[1]，oauth/code） ---- */
let oauthAuth;
{
  const result = await hooks.auth.methods[1].authorize(undefined, {});
  assert.equal(result.method, "code");
  assert.match(result.url, /sso\.openxlab\.org\.cn\/authentication/);
  assert.match(result.instructions, /地址栏/);

  const back = "https://discovery.intern-ai.org.cn/?scenario=desktop&code=" + encodeURIComponent("uaa::code::abc");
  const login = await result.callback(back);
  assert.equal(login.type, "success");
  assert.equal(login.access, JWT);
  assert.equal(login.accountId, "ada");
  assert.equal(login.apiKey, "sk-test-123");
  assert.ok(login.expires > Date.now());
  oauthAuth = { type: "oauth", access: login.access, refresh: login.refresh, expires: login.expires,
    uid: login.uid, username: login.username, apiKey: login.apiKey, apiKeyId: login.apiKeyId,
    apiKeyName: login.apiKeyName, apiKeyError: login.apiKeyError };

  // 裸 code / 被 SPA 改写过的路径 / 带说明文字的一整段，都能提取出 code；
  // 每次重新登录都会删旧建新、拿到一份全新的完整 key（不会再「不可见」）。
  for (const pasted of [
    "uaa::code::abc",
    "https://discovery.intern-ai.org.cn/home?code=uaa%3A%3Acode%3A%3Aabc",
    `登录后地址栏是 ${back}`,
  ]) {
    const again = await result.callback(pasted);
    assert.equal(again.type, "success");
    assert.equal(again.apiKey, "sk-test-123");
  }
  const bad = await result.callback("这不是 code");
  assert.equal(bad.type, "failed");
  ok("网页登录：SSO URL + 粘贴回跳地址/裸 code/任意文本；换票、签发 Key");
}

/* ---- 2b) 第一种登录：本机端砚客户端导入（type:"api"，无网页 / 无扫码） ---- */
{
  const method = hooks.auth.methods[0];
  assert.equal(method.type, "api");
  assert.match(method.label, /端砚客户端/);
  assert.equal(typeof method.authorize, "function");
  ok("本机端砚客户端登录：api 方式，不打开浏览器、无需扫码与粘贴");
}

/* ---- 2a) 从用户粘贴的各种文本里抠出 code ---- */
{
  const cases = [
    ["uaa::code::abc", "uaa::code::abc"],
    ["https://discovery.intern-ai.org.cn/?code=uaa%3A%3Acode%3A%3Aabc&foo=1", "uaa::code::abc"],
    ["https://discovery.intern-ai.org.cn/home?code=uaa::code::abc", "uaa::code::abc"],
    ["我复制的地址：https://discovery.intern-ai.org.cn/?code=uaa::code::abc&x=2", "uaa::code::abc"],
    ["随便粘的 uaa::code::abc 这一段", "uaa::code::abc"],
    ["", null],
    ["不是 code", null],
  ];
  for (const [input, expected] of cases) assert.equal(readSsoCallbackCode(input), expected);
  ok("readSsoCallbackCode：完整/编码/被改写路径/带说明文字/裸 code/非法输入");
}

/* ---- 3) provider.models：两个通道的并集 ---- */
{
  const base = { models: { "agents-a1": { name: "静态占位" } } };
  const models = await hooks.provider.models(base, { auth: oauthAuth });
  assert.deepEqual(Object.keys(models).sort(), ["agents-a1", "glm-5.2", "s2-api"]);
  assert.match(models["agents-a1"].api.url, /\/api\/orbit\//, "Orbit 模型指向 Orbit 基址");
  assert.match(models["glm-5.2"].api.url, /discovery-api/, "重名模型走 API 通道");
  assert.equal(models["glm-5.2"].free, true, "厂商标价 0 才算免费");
  assert.equal(models["s2-api"].capabilities.attachment, true);
  assert.ok(models["agents-a1"].variants, "支持思考的模型给推理档位");
  assert.equal(models["agents-a1"].name, "书生-Agents-A1", "线上清单覆盖静态占位");
  ok("provider.models：并集 / 重名去重 / free / 能力 / 通道标记");
}

/* ---- 4) usage ---- */
{
  const usage = await hooks.auth.usage(async () => oauthAuth);
  assert.equal(usage.plan, "Pro");
  assert.equal(usage.user, "ada");
  assert.equal(usage.balance, "6291 墨点");
  assert.equal(usage.windows[0].amount, 370);
  assert.equal(usage.windows[0].limit, 1000);
  assert.equal(usage.windows[0].span, 18000);
  assert.equal(usage.signIn, undefined, "正常读用量不带 signIn，让 magpie 清除失效标记");
  assert.equal(usage.until, "2026-12-01T00:00:00Z");
  ok("usage：墨点余额 + 5h/7d 窗口（已用量换算）+ 正常读取不带 signIn");
}

/* ---- 5) loader.fetch：双通道路由 ---- */
{
  const loader = await hooks.auth.loader(async () => oauthAuth);
  assert.equal(typeof loader.fetch, "function");
  const headers = { "content-type": "application/json" };

  const api = await loader.fetch("https://discovery-api.intern-ai.org.cn/v1/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  assert.equal(api.status, 200);
  assert.match(await api.text(), /API OK/);
  const apiCall = CALLS.at(-1);
  assert.equal(apiCall.url, "https://discovery-api.intern-ai.org.cn/v1/chat/completions");
  assert.equal(new Headers(apiCall.init.headers).get("authorization"), "Bearer sk-test-123");
  ok("fetch → TokenPlan API 通道：标准 Chat Completions 原样转发 + Bearer key");

  const orbit = await loader.fetch("https://discovery.intern-ai.org.cn/api/orbit/v1/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({ model: "agents-a1", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], stream: true, max_tokens: 100 }),
  });
  assert.equal(orbit.status, 200);
  assert.match(orbit.headers.get("content-type"), /text\/event-stream/);
  const text = await orbit.text();
  assert.match(text, /你好/);
  assert.match(text, /\[DONE\]/);
  const newChatCall = CALLS.find((c) => c.url.includes("/chat/new"));
  assert.ok(newChatCall, "Orbit 通道要先开会话");
  const messagesCall = CALLS.find((c) => c.url.includes("/local-agent/messages"));
  assert.ok(messagesCall);
  const orbitBody = JSON.parse(messagesCall.init.body);
  assert.equal(orbitBody.protocol_version, "2.0");
  assert.equal(orbitBody.chat_id, 42);
  assert.equal(orbitBody.model, "agents-a1-2026", "用 canonical_id 作 API id");
  assert.deepEqual(orbitBody.system, ["sys"]);
  assert.equal(orbitBody.max_output_tokens, 100);
  assert.equal(new Headers(messagesCall.init.headers).get("id"), "u-1");
  ok("fetch → Orbit 通道：/chat/new + 协议 2.0 请求体 + SSE → Chat Completions 流");
}

/* ---- 5b) API 通道的错误语义：额度 → 429，401 原样交给 magpie ---- */
{
  const originalFetch = globalThis.fetch;
  const loader = await hooks.auth.loader(async () => oauthAuth);
  const request = () => loader.fetch("https://discovery-api.intern-ai.org.cn/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discovery-api.intern-ai.org.cn/v1/chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "墨点不足，请等待刷新" } }), {
          status: 402, headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };
    const quota = await request();
    assert.equal(quota.status, 429);
    assert.match((await quota.json()).error.message, /墨点不足/);

    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discovery-api.intern-ai.org.cn/v1/chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "API key 无效" } }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };
    const unauthorized = await request();
    assert.equal(unauthorized.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
  ok("API 通道：402 额度 → 429 换号（保留厂商原话），401 原样标记账号");
}

/* ---- 6) refresh ---- */
{
  const patch = await hooks.auth.refresh(oauthAuth);
  assert.deepEqual(patch, {}, "JWT 仍有效且已有 key 时不需要改动账号");
  const noToken = await hooks.auth.refresh({ type: "oauth" }).then(
    () => "NO_THROW",
    (e) => e,
  );
  assert.equal(noToken.signIn, "expired", "无凭证时要求重新登录");
  ok("refresh：有效账号原样 / 失效账号 signIn:expired");
}

console.log(`\nintegration.test: ${passed} 组通过`);
