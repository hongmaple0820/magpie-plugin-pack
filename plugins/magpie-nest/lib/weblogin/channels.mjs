// Per-channel web-login rules, ported from ChatLink's tokenExtractionConfig
// (F:/maple/ChatLink/src/main/oauth/tokenExtractionConfig.ts) and the nest's
// own channel constants. Each entry says: which page to open, which domains
// to watch, and where the token lives — cookie, localStorage, or a network
// header. The storage shape of each channel's plugin then decides which
// credentials the login lands as (access, ticket, sessionToken, …).

export const WEB_LOGIN_CHANNELS = {
  "zai-web": {
    provider: "zai",
    loginUrl: "https://chat.z.ai",
    targetDomains: ["z.ai", "chat.z.ai"],
    tokenSources: [
      { type: "localStorage", key: "token" },
      { type: "cookie", key: "token" },
    ],
    windowTitle: "Z.ai 一键登录",
    timeoutMs: 240000,
  },
  glm: {
    provider: "glm",
    loginUrl: "https://chatglm.cn",
    targetDomains: ["chatglm.cn"],
    tokenSources: [{ type: "cookie", key: "chatglm_refresh_token" }],
    windowTitle: "GLM 一键登录",
    timeoutMs: 240000,
  },
  qwen: {
    provider: "qwen",
    loginUrl: "https://www.qianwen.com",
    targetDomains: ["qianwen.com"],
    tokenSources: [{ type: "cookie", key: "tongyi_sso_ticket" }],
    windowTitle: "Qwen 一键登录",
    timeoutMs: 240000,
  },
  "qwen-ai": {
    provider: "qwen-ai",
    loginUrl: "https://chat.qwen.ai",
    targetDomains: ["qwen.ai", "chat.qwen.ai"],
    tokenSources: [
      { type: "networkHeader", key: "token", urlPattern: "*://*.qwen.ai/*", extractPattern: "^Bearer\\s+(.+)$" },
      { type: "localStorage", key: "token" },
      { type: "cookie", key: "token" },
    ],
    windowTitle: "Qwen AI 一键登录",
    timeoutMs: 240000,
  },
  kimi: {
    provider: "kimi",
    loginUrl: "https://www.kimi.com",
    targetDomains: ["kimi.com"],
    tokenSources: [
      { type: "networkHeader", key: "token", urlPattern: "*://*.kimi.com/*", extractPattern: "^Bearer\\s+(.+)$" },
    ],
    windowTitle: "Kimi 一键登录",
    timeoutMs: 240000,
  },
  doubao: {
    provider: "doubao",
    loginUrl: "https://www.doubao.com",
    targetDomains: ["doubao.com"],
    tokenSources: [{ type: "cookie", key: "sessionid" }],
    windowTitle: "Doubao 一键登录",
    timeoutMs: 240000,
  },
  perplexity: {
    provider: "perplexity",
    loginUrl: "https://www.perplexity.ai",
    targetDomains: ["perplexity.ai"],
    tokenSources: [
      { type: "cookie", key: "__Secure-next-auth.session-token" },
    ],
    windowTitle: "Perplexity 一键登录",
    timeoutMs: 240000,
  },
  raccoon: {
    provider: "raccoon",
    loginUrl: "https://xiaohuanxiong.com",
    targetDomains: ["xiaohuanxiong.com"],
    tokenSources: [
      { type: "cookie", key: "sessionid" },
      { type: "localStorage", key: "token" },
    ],
    windowTitle: "Raccoon 一键登录",
    timeoutMs: 240000,
  },
};

export function webLoginChannel(providerId) {
  return WEB_LOGIN_CHANNELS[providerId] ?? null;
}
