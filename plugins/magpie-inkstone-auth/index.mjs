/**
 * magpie / OpenCode v1 供应商插件：书生·端砚（Discovery）。
 *
 * 一个供应商 `inkstone`、一次登录、N 个账号：
 *   - 登录：① magpie 打开 OpenXLab SSO 网页 → 粘贴回跳地址 → uaa JWT；
 *           ② Windows 上直接读本机端砚客户端的 DPAPI 凭据，无需扫码；
 *           两种方式都自动签发 TokenPlan API Key；插件不 spawn 浏览器、不用 DevTools；
 *   - 模型：Orbit /local-agent/models 与 TokenPlan /models 的并集（重名走 API 通道）；
 *   - 请求：magpie 把 agent 的 API 转成 Chat Completions 交给 loader.fetch，
 *           本插件按模型把标准请求直发 TokenPlan，或经 lib/bridge.mjs 桥到 Orbit SSE；
 *   - 用量：墨点余额 + 5h/7d 窗口；401 标记账号，429/5xx 由 magpie 故障切换。
 *
 * 入口只导出一个插件函数（导入模块里的每个函数都会被当作插件调用）。
 */
import { PROVIDER, PROVIDER_NAME, API_BASE } from "./lib/constants.mjs";
import { isAuthFailure } from "./lib/http.mjs";
import {
  buildSsoLoginUrl,
  readSsoCallbackCode,
  exchangeCode,
  getUser,
  validateJwt,
  decodeJwt,
} from "./lib/sso.mjs";
import { ensureApiKey } from "./lib/tokenplan.mjs";
import { readDesktopCredential } from "./lib/desktop.mjs";
import { newChat, openMessages } from "./lib/orbit.mjs";
import {
  fallbackModels,
  normalizeAuth,
  accountKey,
  getCatalog,
  peekCatalog,
  toModel,
} from "./lib/catalog.mjs";
import { readUsage } from "./lib/usage.mjs";
import {
  toOrbitBody,
  orbitResponse,
  errorResponse,
  upstreamErrorToResponse,
} from "./lib/bridge.mjs";

const NPM = "@ai-sdk/openai-compatible";
const REFRESH_LEAD_MS = 2 * 60 * 1000;
const REFRESH_CACHE = new Map();

function expiredError(message = "Discovery 登录已过期，请重新登录") {
  return Object.assign(new Error(message), { signIn: "expired" });
}

function bodyTextOf(body) {
  if (typeof body === "string") return body;
  if (!body) return "";
  try {
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  } catch {
    /* 交给后面的 JSON.parse 报错 */
  }
  return "";
}

/**
 * 解析 JWT 并尽量签发 TokenPlan API Key，返回账号字段。
 * 拿不到 API Key 时只影响 API 通道（模型返回 403），Orbit 通道照常。
 */
async function buildAccount(jwt, { signal, session } = {}) {
  const user = session || await getUser(jwt, { signal });
  const decoded = decodeJwt(jwt);
  const uid = String(user?.uid || decoded.uid || "").trim();
  const username = String(user?.username || decoded.username || uid).trim();
  const expiresAtMs = Number(user?.expiresAtMs) || Number(decoded.expiresAtMs) || 0;
  const key = await ensureApiKey(jwt, { signal });
  return {
    uid,
    username,
    expiresAtMs,
    apiKey: key.apiKey,
    apiKeyId: key.apiKeyId,
    apiKeyName: key.apiKeyName,
    apiKeyError: key.error || "",
  };
}

/** oauth（网页登录）：落成 {type:"oauth", access, refresh, expires, …}。 */
async function finishOAuthLogin(jwt, ctx) {
  const account = await buildAccount(jwt, ctx);
  return {
    type: "success",
    access: jwt,
    refresh: jwt,
    expires: account.expiresAtMs,
    accountId: account.username || account.uid,
    ...(/@/.test(account.username) ? { email: account.username } : {}),
    ...account,
  };
}

/** api（本机客户端导入）：落成 {type:"api", key, metadata}，不打开任何网页。 */
async function finishApiLogin(jwt, ctx) {
  const account = await buildAccount(jwt, ctx);
  const accountId = account.username || account.uid;
  const email = /@/.test(account.username) ? account.username : undefined;
  // magpie 靠 accountId / email / uid 去重：同账号重登必须替换而不是新增。
  // api 方式的完整值只会存进 {type:"api", key, metadata}，所以去重字段
  // 顶层和 metadata 里各放一份，避免第一次的旧账号（只有 metadata.uid）对不上。
  return {
    type: "success",
    key: jwt,
    accountId,
    uid: account.uid,
    ...(email ? { email } : {}),
    metadata: {
      ...account,
      accountId,
      ...(email ? { email } : {}),
    },
  };
}

/**
 * 两种登录方式：
 *  1.（第一项，推荐）本机端砚客户端导入：type:"api"，不打开任何网页，直接读
 *     %APPDATA%\inkstone-desktop 的 DPAPI 凭据。仅 Windows，见 lib/desktop.mjs。
 *  2. 网页登录：type:"oauth" / method:"code"，magpie 打开 SSO 页，用户粘回跳地址。
 *     端砚 SSO 没有设备码 / 轮询端点，code 只在回跳 URL 里出现一次。
 * 把本地导入放第一，是因为 GUI/CLI 默认选第一个，且它完全不需要浏览器。
 */
const methods = [
  {
    type: "api",
    label: "从本机端砚客户端导入登录态（Windows，无需扫码）",
    async authorize(_inputs, context = {}) {
      const signal = context?.signal;
      try {
        const cred = await readDesktopCredential({ signal });
        return await finishApiLogin(cred.jwt, {
          signal,
          session: { uid: cred.uid, username: cred.username, expiresAtMs: cred.expiresAtMs },
        });
      } catch (error) {
        return { type: "failed", error: error?.message || "读取端砚客户端凭据失败" };
      }
    },
  },
  {
    type: "oauth",
    label: "网页登录 Discovery（SSO 扫码 / 账号密码）",
    async authorize(_inputs, context = {}) {
      return {
        url: buildSsoLoginUrl("zh"),
        instructions: [
          "magpie 会打开书生·端砚的 SSO 登录页，请用微信扫码或账号密码登录。",
          "登录成功跳回 https://discovery.intern-ai.org.cn/ 时，立刻复制整条地址栏（形如 …/?code=uaa::code::…）粘贴到下面的输入框；也可以只粘 uaa::code:: 开头的那一串。",
          "若页面把地址栏里的 code 清掉了：按浏览器「后退」一次，或从历史记录里找回带 code 的那条地址再复制。",
        ].join("\n"),
        method: "code",
        async callback(value, ctx = {}) {
          const code = readSsoCallbackCode(value);
          if (!code) {
            return { type: "failed", error: "没找到登录 code；请复制完整的回跳地址，或以 uaa::code:: 开头的那一串" };
          }
          const signal = ctx?.signal ?? context?.signal;
          const jwt = await exchangeCode(code, { signal });
          return finishOAuthLogin(jwt, { signal });
        },
      };
    },
  },
];

/** TokenPlan API 通道：标准 Chat Completions，原样转发（只换鉴权头）。 */
async function apiFetch(cred, init) {
  if (!cred.apiKey) {
    return errorResponse(403, cred.apiKeyError || "该账号没有可用的 TokenPlan API Key（详见用量卡片提示）", {
      type: "invalid_request_error",
    });
  }
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${cred.apiKey}`);
  headers.set("accept-language", "zh-CN");
  for (const name of ["host", "content-length", "content-encoding", "connection", "transfer-encoding"]) {
    headers.delete(name);
  }
  const response = await fetch(`${API_BASE}/chat/completions`, {
    ...init,
    headers,
    signal: init?.signal,
    cache: "no-store",
  });
  if (response.ok || response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
    return response; // 交给 magpie 的状态码规则：401 标记账号、429/5xx 故障切换
  }
  // 墨点耗尽：厂商可能回 402 或 4xx + 中文额度提示。转成 429 才能切到下一个账号，
  // 正文保留厂商原话，agent 看到的就是厂家的说明。
  const probe = response.clone();
  let text = "";
  try {
    text = await probe.text();
  } catch {
    /* 保留原 body */
  }
  if (response.status !== 402 && !/墨点|额度|quota|insufficient|credit|balance|余额|耗尽/i.test(text)) {
    return response;
  }
  const outHeaders = new Headers(response.headers);
  outHeaders.delete("content-length");
  outHeaders.delete("content-encoding");
  return new Response(text || response.body, { status: 429, headers: outHeaders });
}

/** Orbit Agent 通道：Chat Completions → Orbit 2.0 → Chat Completions SSE。 */
async function orbitFetch(cred, parsed, entry, init) {
  if (!parsed || !Array.isArray(parsed.messages)) {
    return errorResponse(400, "无法解析 Chat Completions 请求体", { type: "invalid_request_error" });
  }
  const signal = init?.signal;
  try {
    const chatId = await newChat(cred.token, cred.uid, { signal });
    const orbitBody = toOrbitBody({
      body: parsed,
      chatId,
      canonicalId: entry?.apiId || parsed.model,
      supportsThinking: entry?.supportsThinking === true,
    });
    const upstream = await openMessages(cred.token, cred.uid, orbitBody, { signal });
    return await orbitResponse(upstream, {
      model: parsed.model,
      stream: parsed.stream !== false,
      signal,
    });
  } catch (error) {
    return upstreamErrorToResponse(error);
  }
}

export const InkstoneAuthPlugin = async (_input, _options) => ({
  // 未登录时也先声明供应商，模型选择器里能看到一份静态清单。
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: PROVIDER_NAME,
      npm: NPM,
      api: API_BASE,
      models: fallbackModels(),
    };
  },

  auth: {
    provider: PROVIDER,
    methods,
    refreshLead: REFRESH_LEAD_MS,

    /**
     * 这个 SSO 没有 refresh token：refresh 用来在 JWT 到期前主动判失效并补签 API Key。
     * 返回字段会由 magpie 合并进账号；authExpired 时标 signIn:"expired" 让账号停下。
     */
    async refresh(auth) {
      const cred = normalizeAuth(auth);
      if (!cred.token) throw expiredError();
      const key = accountKey(cred);
      const hit = REFRESH_CACHE.get(key);
      if (hit && Date.now() - hit.at < 60_000) return hit.patch;
      try {
        await validateJwt(cred.token);
        const patch = {};
        if (!cred.apiKey) {
          const minted = await ensureApiKey(cred.token, { existingKeyId: cred.apiKeyId });
          if (minted.apiKey) {
            Object.assign(patch, {
              apiKey: minted.apiKey,
              apiKeyId: minted.apiKeyId,
              apiKeyName: minted.apiKeyName,
              apiKeyError: minted.error || "",
            });
          }
        }
        REFRESH_CACHE.set(key, { at: Date.now(), patch });
        return patch;
      } catch (error) {
        if (isAuthFailure(error)) throw expiredError(error?.message);
        throw error;
      }
    },

    /** 不设 baseURL：模型自己的 api.url 决定 magpie 拼出的 URL；本 fetch 按模型路由。 */
    async loader(getAuth) {
      const first = normalizeAuth(await getAuth());
      if (!first.token) return {};
      if (!peekCatalog(first)) {
        try {
          await getCatalog(first);
        } catch {
          /* 目录拉取失败不影响已经缓存的模型；请求时再试 */
        }
      }
      return {
        async fetch(input, init) {
          let cred = first;
          try {
            cred = normalizeAuth(await getAuth());
          } catch {
            /* 用 loader 启动时的账号 */
          }
          if (!cred.token) {
            return errorResponse(401, "请先登录 Discovery", { signIn: "expired", type: "authentication_error" });
          }
          let parsed = null;
          try {
            const text = bodyTextOf(init?.body);
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* 非 JSON 请求体交给通道自己报错 */
          }
          const modelId = String(parsed?.model ?? "");
          let catalog = peekCatalog(cred);
          if (!catalog) {
            try {
              catalog = await getCatalog(cred, { signal: init?.signal });
            } catch {
              /* 目录不可用时按 URL 兜底路由 */
            }
          }
          const entry = catalog?.entries?.get(modelId) ?? catalog?.entries?.get(modelId.toLowerCase());
          const url = String(input?.url ?? input ?? "");
          const channel = entry?.channel ?? (url.includes("/api/orbit/") ? "orbit" : "api");
          return channel === "orbit"
            ? orbitFetch(cred, parsed, entry, init)
            : apiFetch(cred, init);
        },
      };
    },

    async usage(getAuth) {
      const cred = normalizeAuth(await getAuth());
      if (!cred.token) return { error: "请先登录 Discovery", windows: [] };
      return readUsage(cred.token, cred.username || cred.uid, {
        apiKeyError: cred.apiKeyError,
      });
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (!auth) return provider.models;
      const cred = normalizeAuth(auth);
      if (!cred.token) return provider.models;
      try {
        const catalog = await getCatalog(cred, { force: true });
        if (!catalog.list.length) return provider.models;
        // 没有 API Key 时只列 Orbit 通道：API 通道模型必然会 403，干脆不出现。
        const list = cred.apiKey ? catalog.list : catalog.list.filter((entry) => entry.channel === "orbit");
        if (!list.length) return provider.models;
        const base = provider?.models ?? {};
        return Object.fromEntries(list.map((entry) => [entry.key, toModel(entry, base[entry.key])]));
      } catch (error) {
        if (isAuthFailure(error)) throw expiredError(error?.message);
        return provider.models; // 连不上厂商：保留原有清单
      }
    },
  },
});

