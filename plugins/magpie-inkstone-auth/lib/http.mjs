/**
 * 端砚 HTTP 基础：{code,msg,trace_id,data} 信封、统一错误类型、鉴权头。
 * 只依赖 Web 标准 fetch（Bun/Node 22 都有）。
 */
const QUOTA_RE = /墨点|额度|quota|insufficient|credit|balance|余额|耗尽/i;
const AUTH_RE = /登录|会话|凭据|unauthor|authentication|jwt|token.*(过期|失效|无效|expired|invalid)|session.*(过期|失效|expired)/i;

export class UpstreamError extends Error {
  constructor(message, { status = 0, code = "", reason = "", authExpired = false, quota = false, retryable = false } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.authExpired = authExpired;
    this.quota = quota;
    this.retryable = retryable;
  }
}

/** TokenPlan 管理面：/keys 只认 Cookie uaa-token，其它接口认 Bearer；两套都带上。 */
export function authHeaders(token, extra = {}) {
  const jwt = String(token ?? "");
  const uaaCookie = "uaa" + "-token=" + jwt;
  return {
    Authorization: `Bearer ${jwt}`,
    Cookie: uaaCookie,
    Accept: "application/json",
    "Accept-Language": "zh-CN",
    ...extra,
  };
}

/** Orbit 网关：Bearer JWT + 自己的 id 头。 */
export function orbitHeaders(token, uid, extra = {}) {
  return {
    Authorization: `Bearer ${String(token ?? "")}`,
    id: String(uid ?? ""),
    "Accept-Language": "zh-CN",
    ...extra,
  };
}

function envelopeOf(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** 校验 {code,msg,trace_id,data} 信封；非成功抛 UpstreamError。返回 envelope.data。 */
export async function readEnvelope(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  const envelope = envelopeOf(text);
  if (envelope !== null) {
    const ok = envelope.code === 0 || envelope.code === 200;
    if (response.ok && ok) return envelope.data ?? null;
    const msg = String(envelope.msg || `端砚网关 HTTP ${response.status}`);
    const code = String(envelope.code ?? response.status);
    const reason = String(envelope.data?.reason ?? "");
    throw new UpstreamError(msg, {
      status: response.status,
      code,
      reason,
      authExpired: response.status === 401 || code === "-10002" || reason === "AUTH_EXPIRED" || AUTH_RE.test(msg),
      quota: QUOTA_RE.test(`${msg} ${reason}`),
      retryable: response.status === 409 || response.status === 429 || response.status >= 500,
    });
  }
  if (!response.ok) {
    throw new UpstreamError(`端砚网关 HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  return text;
}

/** JSON 请求；调用方不传 signal 时给 20s 超时。 */
export async function jsonRequest(url, { method = "GET", headers = {}, body, signal } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: signal ?? AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  return readEnvelope(response);
}

export function isAuthFailure(error) {
  if (!error) return false;
  if (error.authExpired === true) return true;
  if (Number(error.status) === 401) return true;
  if (String(error.code) === "-10002") return true;
  const message = String(error?.message ?? "");
  return !QUOTA_RE.test(message) && AUTH_RE.test(message);
}
