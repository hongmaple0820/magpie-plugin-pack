/**
 * Discovery / OpenXLab SSO：登录 URL、回跳 code、换票与读用户。
 * JWT 里的 ssoUid 是 Orbit 网关必需的 `id` 头。
 */
import { AUTH_BASE, SSO_CLIENT_ID, SSO_ORIGIN, SSO_REDIRECT, SSO_SOURCE } from "./constants.mjs";
import { jsonRequest, UpstreamError, isAuthFailure } from "./http.mjs";

/** 拼装 SSO 登录页地址（redirect 是 discovery 首页 + scenario=desktop）。 */
export function buildSsoLoginUrl(locale = "zh") {
  const url = new URL("/authentication", SSO_ORIGIN);
  const parameters = new URLSearchParams();
  parameters.set("clientId", SSO_CLIENT_ID);
  parameters.set("source", SSO_SOURCE);
  parameters.set("lang", locale === "en" ? "en" : "zh");
  const redirectUrl = new URL(SSO_REDIRECT);
  redirectUrl.searchParams.set("scenario", "desktop");
  url.search = `?redirect=${redirectUrl.toString()}&${parameters.toString()}`;
  return url.toString();
}

const CODE_RE = /uaa::code::[^\s"'<>&#?%]+/i;
const CODE_PREFIX = "uaa::code::";

function validCode(code) {
  return typeof code === "string"
    && code.startsWith(CODE_PREFIX)
    && code.length > CODE_PREFIX.length
    && code.length <= 2048;
}

/**
 * 从用户粘贴的内容里取出登录 code。
 * 优先精确解析回跳 URL；页面若用 history.replaceState 改写过地址、
 * 或用户只粘了 code / 粘了带说明文字的一整段，用正则兜底。
 * 浏览器复制地址栏时可能带百分号编码，所以先试原文、再试解码后的文本。
 */
export function readSsoCallbackCode(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  // 1) 文本里含 URL 时交给 URL 解析器：query 里的 %XX 自动解码，
  //    也不受登录页 replaceState 改写 pathname 的影响。
  const found = /https?:\/\/[^\s"'<>]+/i.exec(raw);
  if (found) {
    try {
      const candidate = new URL(found[0]);
      const codes = candidate.searchParams.getAll("code");
      if (codes.length === 1 && validCode(codes[0])) return codes[0];
    } catch {
      /* 不是合法 URL，走正则兜底 */
    }
  }

  // 2) 裸 code、或只粘了带说明文字的一段（code 不在 query 里）
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* 原文里有非法百分号编码，保留原文 */
  }
  const hit = CODE_RE.exec(raw) || CODE_RE.exec(decoded);
  return hit && validCode(hit[0]) ? hit[0] : null;
}

function unpaddedBase64(token, index) {
  const part = String(token).split(".")[index];
  if (!part) return "";
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

/** 解 JWT payload（不验签，只读声明）；失败返回空字段而不是抛错。 */
export function decodeJwt(token) {
  const json = new TextDecoder().decode(unpaddedBase64(token, 1));
  let payload = null;
  try {
    payload = json ? JSON.parse(json) : null;
  } catch {
    payload = null;
  }
  const p = payload && typeof payload === "object" ? payload : {};
  let uid = "";
  for (const key of ["ssoUid", "uid", "sub", "user_id", "userId", "id"]) {
    if (typeof p[key] === "string" && p[key].trim()) {
      uid = p[key].trim();
      break;
    }
  }
  let username = "";
  for (const key of ["username", "name", "preferred_username", "email"]) {
    if (typeof p[key] === "string" && p[key].trim()) {
      username = p[key].trim();
      break;
    }
  }
  const exp = Number(p.exp);
  return { uid, username, expiresAtMs: Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0 };
}

/** code 换 uaa JWT。 */
export async function exchangeCode(code, { signal } = {}) {
  const data = await jsonRequest(`${AUTH_BASE}/users/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal,
  });
  const token = typeof data?.token === "string" ? data.token.trim() : "";
  if (!token) throw new UpstreamError("登录成功但未返回凭证");
  return token;
}

/** 读用户（ssoUid、username）。 */
export async function getUser(jwt, { signal } = {}) {
  const data = await jsonRequest(`${AUTH_BASE}/users/getUserInfo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
    signal,
  });
  const uid = String(data?.ssoUid || data?.sso_uid || "").trim();
  if (!uid) {
    const decoded = decodeJwt(jwt);
    if (decoded.uid) return { uid: decoded.uid, username: decoded.username };
    throw new UpstreamError("登录成功但未返回 SSO UID");
  }
  const username = String(data?.username || data?.ssoUsername || data?.sso_username || data?.nickname || "").trim() || uid;
  return { uid, username };
}

/**
 * 校验 JWT 是否仍有效（refresh 钩子用）。
 * 失效时抛出的错误带 authExpired 标记，调用方据此决定标不标 signIn:"expired"。
 */
export async function validateJwt(jwt, { signal } = {}) {
  try {
    const user = await getUser(jwt, { signal });
    return user;
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new UpstreamError("Discovery 登录已失效", { status: error.status || 401, authExpired: true });
    }
    throw error;
  }
}
