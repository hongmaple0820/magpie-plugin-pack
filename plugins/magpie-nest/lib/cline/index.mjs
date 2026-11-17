// Cline（cline.bot）渠道插件。
//
// 登录：WorkOS 设备码 OAuth（自动化，推荐）；也可以粘贴 Cline 客户端的
//       `workos:` 令牌兜底（填上 refresh token 就能自动续期）。
// 推理：上游就是 OpenAI Chat Completions + 标准 SSE，只做透传 + 两处补丁
//       （reasoning → reasoning_content、工具 schema 空 enum 清洗）。
// 入口只导出一个插件函数——magpie 会把导入的每个函数都当插件跑。

import {
  NPM,
  SITE,
  modelRows,
  stripModel,
} from "./constants.mjs";
import { deviceSignIn, refreshClineCredential } from "./login.mjs";
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
// 抛出的本地错误（缺凭证、非本 provider 路径）包成 OpenAI 错误，
// 并带 x-magpie-sign-in 头；上游非 2xx 的响应体在 chat.ask 里原样透传。
function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "cline_error",
      },
    }),
    { status, headers },
  );
}

/** 粘贴令牌兜底：主输入是 workos: 前缀的 access token，可选填 refresh token。 */
const PAY_TOKEN_PROMPTS = [
  {
    key: "refresh",
    type: "text",
    message: "Refresh Token（可选；来自同一份登录凭据，填了才能自动续期）",
    placeholder: "留空则过期后需重新粘贴",
  },
];

export const ClinePlugin = async () => ({
  async config(cfg) {
    cfg.provider ??= {};
    cfg.provider[SITE.id] ??= {};
    const provider = cfg.provider[SITE.id];
    provider.name ??= SITE.name;
    // 上游本来就是 openai-compatible：本插件不转协议，只透传。
    provider.npm ??= NPM;
    provider.api ??= SITE.api;
    provider.models = { ...(provider.models ?? {}), ...modelRows() };
  },

  provider: {
    id: SITE.id,
    // 推荐目录是匿名可读的（/api/v1/ai/cline/recommended-models），不需要凭证；
    // 拉不到就回退兜底表（只有实测免费的三条）。
    async models(p) {
      const remote = await fetchCatalog(SITE);
      if (remote) return remote;
      return p?.models ?? modelRows();
    },
  },

  auth: {
    provider: SITE.id,
    maxConcurrency: 3,
    methods: [
      {
        type: "oauth",
        label: `登录 ${SITE.name}（浏览器设备码，推荐）`,
        authorize: () => deviceSignIn(SITE),
      },
      {
        type: "api",
        label: "粘贴 Cline 令牌（workos: 开头）",
        placeholder: "workos:eyJ…",
        prompts: PAY_TOKEN_PROMPTS,
      },
    ],

    async refresh(auth) {
      if (!String(auth?.refresh ?? "").trim()) {
        throw expired(`${SITE.name}: the sign-in lapsed; sign in again`);
      }
      return refreshClineCredential(SITE, auth.refresh);
    },

    async loader(getAuth) {
      return {
        baseURL: SITE.api,
        apiKey: "",
        async fetch(input, init) {
          try {
            const request = typeof input === "string" ? new Request(input, init) : input;
            const path = new URL(request.url).pathname;
            if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
              throw Object.assign(
                new Error(`${SITE.id}: ${request.method} ${path} 不是本 provider 提供的路径`),
                { status: 404 },
              );
            }

            // 每个请求都重新读账号：magpie 会在请求之间刷新凭据，
            // 建 loader 时抓到的会是刷新前那一份。
            const auth = await getAuth();
            const token = tokenOf(auth);
            if (!token) throw expired(`${SITE.id}: 未登录或登录已过期，请重新登录`);

            const body = await request.json();
            const model = stripModel(body?.model);
            if (!model) {
              throw Object.assign(new Error(`${SITE.id}: 请求没带 model`), { status: 400 });
            }
            body.model = model;

            return await ask(body, { access: token }, init, SITE);
          } catch (error) {
            return errorResponse(error);
          }
        },
      };
    },
  },
});
