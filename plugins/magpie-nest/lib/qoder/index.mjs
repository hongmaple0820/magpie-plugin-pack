// Qoder 双版本渠道插件：qoder（国际版）+ qoder-cn（中国版）。
//
// 登录：设备码 OAuth（第一项，自动化）+ PAT 兑换（第二项）。
// 推理：把 magpie 给的 Chat Completions 转发到对应 region 的加密网关
//（lib/chat.mjs 的 ask 做 COSY 信封、编码与 SSE 反向翻译）。
// 入口只导出两个插件函数——magpie 会把导入的每个函数都当插件跑。

import { createHash } from "node:crypto";
import { CHAT, fallbackEntry, modelRows, regionOf, stripModel } from "./constants.mjs";
import { deviceSignIn, patSignIn, refreshDevice, refreshJob, SignInGone } from "./login.mjs";
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
        type: error?.signIn === "expired" ? "authentication_error" : "qoder_error",
      },
    }),
    { status, headers },
  );
}

// 稳定的 machine id：设备码登录会存随机 UUID；只有手动补的裸令牌才走这里。
function machineIdOf(token) {
  return "m" + createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function makePlugin(site) {
  const ID = site.id;
  const rows = () => modelRows(ID);

  const deviceMethod = {
    type: "oauth",
    label: "登录 " + site.name + "（浏览器设备码，推荐）",
    authorize: () => deviceSignIn(site),
  };

  const patMethod = {
    type: "oauth",
    label: "使用 " + site.name + " PAT 登录",
    prompts: [
      {
        type: "password",
        key: "pat",
        message: "你的 " + site.name + " Personal Access Token（在 " + site.web + "/account/integrations 创建）",
        placeholder: "pt-...",
        validate: (v) => (String(v ?? "").trim().startsWith("pt-") ? undefined : "PAT 必须以 pt- 开头"),
      },
    ],
    authorize: (inputs) => {
      const pat = String(inputs?.pat ?? "").trim();
      if (!pat) throw new Error("请输入 Personal Access Token");
      return {
        url: site.web + "/account/integrations",
        instructions: "若还没有 PAT：在该页面创建；创建后插件会用它兑换 job token 并完成登录。",
        method: "auto",
        async callback() {
          return patSignIn(site, pat);
        },
      };
    },
  };

  return async () => ({
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {};
      const provider = cfg.provider[ID];
      provider.name ??= site.name;
      provider.npm ??= CHAT;
      provider.api ??= site.api;
      // 本插件模型行覆盖：目录 key 是上游真实名字，不能让 magpie 已有
      // 记录里 models.dev 的猜测盖掉它。
      provider.models = { ...(provider.models ?? {}), ...rows() };
    },

    provider: {
      id: ID,
      async models(p) {
        return p?.models ?? rows();
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: 3,
      methods: [deviceMethod, patMethod],

      // magpie 会在 job/device token 到期前调 refresh 续期；返回的字段
      // 合并回账号。刷新令牌是一次性的：一次失败即抛 expired 让账号停下。
      async refresh(auth) {
        try {
          if (auth?.deviceChat) {
            const dt = await refreshDevice(site, auth.refresh ?? auth.deviceRefresh, true);
            return { access: dt.token, refresh: dt.refresh, expires: dt.expires, deviceToken: dt.token, deviceRefresh: dt.refresh };
          }
          const jt = await refreshJob(site, auth?.refresh, auth?.accountId || auth?.email || auth?.uid);
          return { access: jt.token, refresh: jt.refresh, expires: jt.expires };
        } catch (e) {
          if (e instanceof SignInGone && auth?.patAuth && auth?.pat) {
            const ex = await patSignIn(site, auth.pat);
            return { access: ex.access, refresh: ex.refresh, expires: ex.expires };
          }
          if (e instanceof SignInGone) throw expired(String(e?.message ?? e));
          throw e;
        }
      },

      async loader(getAuth) {
        return {
          baseURL: site.api,
          apiKey: "",
          async fetch(input, init) {
            const request = new Request(input, init);
            try {
              // 入站是 magpie 拼的 OpenAI 路径（baseURL + /chat/completions）；
              // /agent_chat_generation 是我们要发给 Qoder 网关的上游路径，不是这里的判据。
              const path = new URL(request.url).pathname;
              if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
                throw Object.assign(new Error(ID + ": " + request.method + " " + path + " 不是本 provider 提供的路径"), { status: 404 });
              }

              const auth = await getAuth();
              const token = tokenOf(auth);
              if (!token) throw expired(ID + ": 未登录或登录已过期，请重新登录");
              if (!String(auth?.uid ?? "").trim()) throw expired(ID + ": 账号缺少 uid，请重新登录");

              const body = await request.json();
              const model = stripModel(ID, body.model);
              if (!model) {
                throw Object.assign(new Error(ID + ": 请求没带 model"), { status: 400 });
              }
              // 静态表只用于展示与能力声明；账号的真实目录随计划变，未枚举的
              // 模型放行给上游判断——本地 404 会让新模型永远不可用。
              const entry = rows()[model] ?? fallbackEntry(model);

              const cred = {
                uid: String(auth.uid),
                name: String(auth?.name ?? ""),
                email: String(auth?.email ?? ""),
                access: token,
                machineId: String(auth?.machineId ?? "").trim() || machineIdOf(token),
              };
              const headers = new Headers(request.headers);
              const named =
                headers.get("x-magpie-qoder-session")?.trim().slice(0, 128) ??
                headers.get("x-deepseek-harness-session-id")?.trim().slice(0, 128) ??
                "";
              return await ask(body, cred, init, site, entry, named);
            } catch (error) {
              return errorResponse(error);
            }
          },
        };
      },
    },
  });
}

export const QoderPlugin = makePlugin(regionOf("qoder"));
export const QoderCnPlugin = makePlugin(regionOf("qoder-cn"));
