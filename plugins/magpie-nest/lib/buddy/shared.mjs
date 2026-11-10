// 三个腾讯渠道共用的 loader / 授权逻辑，产品参数来自 constants.mjs 的 PRODUCTS。
// 协议事实出处见 README.md 与 constants.mjs 头注释。

import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { NPM, modelRows, stripModelFor, uaDefault, uaForModel } from "./constants.mjs";

const POLL_MS = 1000;
const SIGN_IN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const SESSION_HEADER = "x-magpie-buddy-session";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = () => randomBytes(16).toString("hex");

// auth/token 的响应字段是 accessToken/refreshToken/domain（驼峰），转成
// magpie 落库的 access/refresh/domain；时间字段 accepts at-ms 或 in-seconds。
// opencode-workbuddy-auth/index.mjs:230-243
function mergeToken(got) {
  const now = Date.now();
  const out = { access: got.accessToken };
  if (got.refreshToken) out.refresh = got.refreshToken;
  if (got.domain) out.domain = got.domain;
  if (got.tokenType) out.tokenType = got.tokenType;
  if (got.expiresAt > 0) out.expires = got.expiresAt;
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000;
  return out;
}

function domainOf(product, auth) {
  // token.domain 可能为空串 —— 回退产品 apiDomain（ChatLink oauth/adapters/codebuddy.ts:26-28）。
  return (auth?.domain ? String(auth.domain).trim() : "") || new URL(product.endpoint).host;
}

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function enterpriseHeaders(auth) {
  const id = typeof auth?.enterpriseId === "string" ? auth.enterpriseId.trim() : "";
  return id ? { "X-Enterprise-Id": id, "X-Tenant-Id": id } : {};
}

function expired(product) {
  return Object.assign(new Error(product.name + " 登录已过期，请重新登录"), { status: 401, signIn: "expired" });
}

function notServed(product, method, path) {
  return Object.assign(new Error(product.name + ": " + method + " " + path + " 不在本供应商服务范围内"), { status: 404 });
}

function noSuchModel(product, model) {
  return Object.assign(new Error(product.name + ": 没有这个模型: " + model), { status: 404 });
}

// 照抄 zai 的 errorResponse 写法：抛出的插件错误统一转 JSON Response，并带
// x-magpie-sign-in 头让宿主把账号标成过期。
function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "buddy_error",
      },
    }),
    { status, headers },
  );
}

// 控制面请求：应答 {code,msg,data}；code 非 0 或 HTTP 非 2xx 都抛错。
// opencode-workbuddy-auth/index.mjs:199-223
async function call(product, method, path, headers = {}, body) {
  const response = await fetch(product.endpoint + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": uaDefault(product),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let env = {};
  try {
    env = JSON.parse(text);
  } catch {
    // 非 JSON 应答留给下面的 HTTP 状态处理。
  }
  const code = Number.parseInt(env.code, 10) || 0;
  if (!response.ok) {
    throw Object.assign(
      new Error(product.name + ": " + (env.msg || env.message || text.slice(0, 200) || response.statusText) + " (HTTP " + response.status + ")"),
      { status: response.status, code },
    );
  }
  if (code) {
    throw Object.assign(new Error(product.name + ": " + (env.msg || "error") + " (" + code + ")"), { status: response.status, code });
  }
  return env.data;
}

// 轮询：11217（token 未就绪）/ 12151（账户未就绪）不是错误，继续等；408/429 同样。
// opencode-workbuddy-auth/index.mjs:1740-1751
async function poll(product, path, headers, retryCodes, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error(product.name + " 登录超时（5 分钟）");
    try {
      const data = await call(product, "GET", path, headers);
      if (data && Object.keys(data).length) return data;
    } catch (error) {
      if (!(retryCodes.includes(error?.code) || error?.status === 408 || error?.status === 429)) throw error;
    }
    await sleep(POLL_MS);
  }
}

function accountName(product, who, auth) {
  const uid = (who?.uid ? String(who.uid) : "") || (auth?.uid ? String(auth.uid) : "");
  const nickname = who?.nickname ? String(who.nickname) : "";
  if (nickname) return nickname;
  return uid ? product.name + " 用户 " + uid.slice(-4) : product.name;
}

// 一键登录：POST /v2/plugin/auth/state?platform=… → 打开 authUrl（腾讯域内完成授权，
// 无本地回调、无 code）→ 轮询 auth/token → 轮询 login/account。
// ChatLink oauth/adapters/codebuddy.ts:8-32；opencode-workbuddy-auth/index.mjs:1753-1796。
async function buddyAuthorize(product) {
  const state = await call(
    product,
    "POST",
    "/v2/plugin/auth/state?platform=" + encodeURIComponent(product.platform),
    {
      // 5 个 X-No-* 头是硬约束：声明「本请求无身份」，否则控制面按已登录请求拒绝。
      // ChatLink oauth/adapters/codebuddy.ts:23-25
      "X-Domain": new URL(product.endpoint).host,
      "X-No-Authorization": "true",
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
    },
    {},
  );
  if (!state?.state || !state?.authUrl) throw new Error(product.name + " 没有给出登录页");
  const url = new URL(state.authUrl);
  if (url.protocol !== "https:") throw new Error(product.name + " 的登录页不是 https");
  // WorkBuddy 两版要追加 version + loginSessionId（对齐桌面端 openAuthUrl）；
  // CodeBuddy 原样返回。ChatLink oauth/adapters/codebuddy.ts:279-295。
  if (product.appendSessionParams) {
    url.searchParams.set("version", product.app);
    url.searchParams.set("loginSessionId", hex());
  }
  return {
    url: url.toString(),
    instructions: "在打开的腾讯授权页完成登录（扫码 / 账号密码均可）。登录成功后插件会自动轮询令牌，全程无需复制粘贴。",
    method: "auto",
    async callback() {
      try {
        const deadline = Date.now() + SIGN_IN_MS;
        const q = encodeURIComponent(state.state);
        const token = await poll(product, "/v2/plugin/auth/token?state=" + q, {}, [11217], deadline);
        if (!token?.accessToken) return { type: "failed", error: product.name + " 没有发回令牌" };
        const auth = mergeToken(token);
        let who = {};
        try {
          who = await poll(
            product,
            "/v2/plugin/login/account?state=" + q,
            {
              // token.domain 可能为空串，必须回退产品 apiDomain（见 domainOf）。
              Authorization: "Bearer " + auth.access,
              "X-Domain": domainOf(product, auth),
              "X-No-User-Id": "true",
              "X-No-Enterprise-Id": "true",
            },
            [12151],
            deadline,
          );
        } catch {
          // 拿不到账户信息不挡登录：令牌本身可用，用户名回退 uid 尾号。
        }
        const uid = who?.uid ? String(who.uid) : "";
        const enterpriseId = who?.enterpriseId ? String(who.enterpriseId) : "";
        return {
          type: "success",
          access: auth.access,
          refresh: auth.refresh ?? "",
          expires: auth.expires ?? 0,
          accountId: accountName(product, who, auth),
          ...(uid ? { uid } : {}),
          ...(auth.domain ? { domain: auth.domain } : {}),
          ...(enterpriseId ? { enterpriseId } : {}),
          ...(auth.tokenType ? { tokenType: auth.tokenType } : {}),
        };
      } catch (error) {
        return { type: "failed", error: error?.message ?? String(error) };
      }
    },
  };
}

// 会话 → X-Conversation-ID 的内存表：同一 magpie 会话保持同一个会话 id。
const conversationIds = new Map();

function buildHeaders(product, auth, request, body, token) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    Authorization: "Bearer " + token,
    "X-User-Id": auth?.uid ? String(auth.uid) : "",
    "X-Domain": domainOf(product, auth),
    "X-Product-Code": product.productCode,
    "X-Product": product.product,
    "X-Agent-Purpose": "conversation",
    "X-IDE-Name": product.ideName,
    "X-IDE-Type": product.ideType,
    "X-IDE-Version": product.app,
    "User-Agent": uaForModel(product, body.model),
  };
  if (product.requestedWith) headers["X-Requested-With"] = "XMLHttpRequest";
  if (product.agentIntent) headers["X-Agent-Intent"] = "craft";
  if (product.agentType) headers["X-Agent-Type"] = "main";
  if (product.runtime) headers["X-Agent-Runtime"] = product.runtime;
  Object.assign(headers, enterpriseHeaders(auth));

  // 桌面端每会话三个身份头（ChatLink builtin/workbuddy.ts:19-24）：会话 id 稳定，
  // message/request id 每请求刷新。这里按 magpie 会话头取会话名，取不到就不缓存
  // 会话 id（每次随机，等价于「没名字的新会话」）。
  if (product.conversation) {
    const session = String(request.headers.get(SESSION_HEADER) ?? "").trim().slice(0, 128);
    let conversationId = session ? conversationIds.get(session) : "";
    if (!conversationId) {
      conversationId = hex();
      if (session) conversationIds.set(session, conversationId);
    }
    const messageId = hex();
    headers["X-Conversation-ID"] = conversationId;
    headers["X-Conversation-Message-ID"] = messageId;
    headers["X-Conversation-Request-ID"] = hex();
    headers["X-Request-ID"] = messageId;
    // prefix-cache key = 同一会话 id（ChatLink builtin/workbuddy.ts:80-84）。
    if (product.cacheKey && !body.prompt_cache_key) body.prompt_cache_key = conversationId;
  }
  return headers;
}

/** 一个产品的完整 plugin 函数工厂（config / provider / auth 三段式）。 */
export function buddyPlugin(product) {
  const ID = product.id;
  const API_BASE = product.endpoint + "/v2";
  const CHAT_PATH = "/chat/completions";
  const rows = modelRows(product);

  return async () => ({
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {};
      const provider = cfg.provider[ID];
      provider.name ??= product.name;
      provider.npm ??= NPM;
      provider.api ??= API_BASE;
      // 本插件覆盖：已有记录不能压掉这份模型表。
      provider.models = { ...(provider.models ?? {}), ...rows };
    },

    provider: {
      id: ID,
      async models(provider) {
        return provider?.models ?? rows;
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: product.maxConcurrency ?? 3,
      methods: [
        {
          type: "oauth",
          label: product.name + " 账号（浏览器一键登录，推荐）",
          authorize: () => buddyAuthorize(product),
        },
        {
          // 控制面没有「拿 access token 直接验证」的端点（ChatLink oauth/adapters/codebuddy.ts:432-439），
          // 所以只能贴令牌，真失效会在首次推理时暴露。enterpriseId 由一键登录自动带回；
          // api 形态只有令牌一个字段（magpie plugin.Method 结构，internal/plugin/providers.go:28-36）。
          type: "api",
          label: "粘贴 " + product.name + " IDE 访问令牌",
          placeholder: "eyJ…",
        },
      ],

      async loader(getAuth) {
        return {
          baseURL: API_BASE,
          apiKey: "",
          async fetch(input, init) {
            const request = new Request(input, init);
            try {
              const path = new URL(request.url).pathname;
              if (!path.endsWith(CHAT_PATH)) throw notServed(product, request.method, path);

              const auth = await getAuth();
              const token = tokenOf(auth);
              if (!token) throw expired(product);

              const body = await request.json();
              body.model = stripModelFor(product, body.model);
              // 静态表只属于展示：账号真实目录更大，未枚举的模型放行给上游判断。
              if (!body.model) throw noSuchModel(product, body.model);
              // 两版网关都要求首条是 system，否则 11128 "first message is not
              // system prompt"（社区 index.mjs:967,982-985）。
              if (Array.isArray(body.messages) && body.messages[0]?.role !== "system") {
                body.messages.unshift({ role: "system", content: "You are a helpful assistant." });
              }

              const headers = buildHeaders(product, auth, request, body, token);
              let payload = JSON.stringify(body);
              if (product.gzip && payload) {
                // WorkBuddy 自己的客户端把模型请求 gzip 后发出（两版 product.json 的
                // RequestBodyGzip）。opencode-workbuddy-auth/README.md:313-315
                payload = gzipSync(payload);
                headers["Content-Encoding"] = "gzip";
              }
              const upstream = await fetch(API_BASE + CHAT_PATH, {
                method: "POST",
                headers,
                body: payload,
                ...(request.signal ? { signal: request.signal } : {}),
              });

              if (!upstream.ok) {
                // 非 2xx：上游响应体原样返回；401 时带 x-magpie-sign-in 头标记账号。
                const text = await upstream.text().catch(() => "");
                const out = new Headers(upstream.headers);
                out.delete("content-length");
                out.delete("content-encoding");
                if (upstream.status === 401) out.set("x-magpie-sign-in", "expired");
                return new Response(text, { status: upstream.status, headers: out });
              }

              const out = new Headers();
              out.set("content-type", upstream.headers.get("content-type") ?? "application/json");
              out.set("cache-control", "no-cache");
              return new Response(upstream.body, { status: 200, headers: out });
            } catch (error) {
              return errorResponse(error);
            }
          },
        };
      },
    },
  });
}
