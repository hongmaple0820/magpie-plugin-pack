// MiniMax Code（中国版）渠道插件。
//
// 登录：设备码 OAuth（自动化）。
// 推理：把 magpie 给的 Chat Completions 转发到 Anthropic Messages 端点（Plain Bearer，无 COSY）。
// 入口只导出一个插件函数——magpie 会把导入的每个函数都当插件跑。

import { CHAT, modelRows, SITE } from "./constants.mjs";
import { deviceSignIn, refreshMinimaxCredential } from "./login.mjs";
import { fetchCatalog } from "./catalog.mjs";
import { ask } from "./chat.mjs";

function tokenOf(auth) {
  const value = auth?.key ?? auth?.access ?? auth?.token;
  return typeof value === "string" ? value.trim() : "";
}

function expired(message) {
  return Object.assign(new Error(message), { status: 401, signIn: "expired" });
}

// 照 zai 的 errorResponse 写法（lib/zai/index.mjs:35-48）：
// 抛出的本地错误（缺凭证、未知模型、非本 provider 路径）包成 OpenAI 错误，
// 并带 x-magpie-sign-in 头；上游非 2xx 的响应体在 chat.ask 里原样透传。
function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "minimax_error",
      },
    }),
    { status, headers },
  );
}

function makePlugin(site) {
  const ID = site.id;

  const deviceMethod = {
    type: "oauth",
    label: `登录 ${site.name}（浏览器设备码，推荐）`,
    authorize: () => deviceSignIn(site),
  };

  return async () => ({
    config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {};
      cfg.provider[ID].name ??= site.name;
      // ⚠️ 必须是 openai-compatible：本渠道自己把 /chat/completions 转成 Anthropic Messages。
      cfg.provider[ID].npm ??= CHAT;
      cfg.provider[ID].api ??= site.api;
      cfg.provider[ID].models = { ...(cfg.provider[ID].models ?? {}), ...modelRows() };
    },

    provider: {
      id: ID,
      // 有凭证就拉远端目录（5 分钟缓存，失败或无凭证时回退兜底表）。
      async models(p, { auth } = {}) {
        const token = tokenOf(auth);
        if (token) {
          const remote = await fetchCatalog(token, { site });
          if (remote) return { ...remote, ...(p?.models ?? {}) };
        }
        return p?.models ?? modelRows();
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: 3,
      methods: [deviceMethod],
      async refresh(auth) {
        if (!String(auth?.refresh ?? "").trim()) {
          throw expired(`${site.name}: the sign-in lapsed; sign in again`);
        }
        const refreshed = await refreshMinimaxCredential(site, auth.refresh);
        return refreshed;
      },
      async loader(getAuth) {
        return {
          baseURL: site.api,
          apiKey: "",
          async fetch(input, init) {
            try {
              const request = typeof input === "string" ? new Request(input, init) : input;
              const path = new URL(request.url).pathname;
              if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
                throw Object.assign(new Error(`${ID}: ${request.method} ${path} 不是本 provider 提供的路径`), { status: 404 });
              }

              const auth = await getAuth();
              const token = tokenOf(auth);
              if (!token) throw expired(`${ID}: 未登录或登录已过期，请重新登录`);
              // ⚠️ 不要要求 uid：设备码 OAuth 的令牌响应里根本没有用户信息
              // （login.mjs 的回调 uid 恒为 undefined），加了这道校验等于登录成功后
              // 每个请求都本地 401。OFM 的 minimaxHeaders 也只发 Authorization+Accept。

              const body = await request.json();
              return await ask(body, { access: token, token }, init, site);
            } catch (error) {
              return errorResponse(error);
            }
          },
        };
      },
    },
  });
}

export const MiniMaxPlugin = makePlugin(SITE);
