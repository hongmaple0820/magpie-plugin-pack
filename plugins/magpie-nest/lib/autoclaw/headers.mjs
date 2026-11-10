// AutoClaw request fingerprint + body shaping. Ported from the verified
// community implementation @magpie-community/opencode-autoclaw-auth@0.2.21
// index.mjs (bizHeaders:527, official chat headers:583, managed chat
// headers:1302, body rewrite:440/1321). Both chat gateways answer 406 with
// an empty body unless the request carries the official client fingerprint,
// the "You are AutoClaw..." system prefix, and no max_tokens.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  APP_ID, APP_KEY, PRODUCT, CHANNEL, CLIENT_VERSION,
  CN_CHANNEL, CN_CLIENT_VERSION, OFFICIAL_CHANNEL, OFFICIAL_CLIENT_VERSION,
  OFFICIAL_LANG, OPENAI_SDK_VERSION, OFFICIAL_NODE_VERSION,
  OFFICIAL_SYSTEM_PROMPT,
} from "./constants.mjs";

export function md5Hex(input) {
  return createHash("md5").update(input).digest("hex");
}

export function randomHex(n) {
  return randomBytes(n).toString("hex");
}

/** 64 位十六进制 device_id（官方客户端形态，reference index.mjs:522）。 */
export function newDeviceId() {
  return randomHex(32);
}

export function platformTm(platform = process.platform) {
  return platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
}

export function bareToken(v) {
  let t = String(v ?? "").trim();
  while (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  return t;
}

export function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 验证码必须按数字发送（reference index.mjs:679）。 */
export function codeValue(code) {
  const s = (code ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : s;
}

function jwtClaim(token, key) {
  const raw = bareToken(token);
  const part = raw.split(".")[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json)[key];
  } catch {
    return undefined;
  }
}

export function jwtExpiresAtMs(token) {
  const exp = jwtClaim(token, "exp");
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

const OAUTH_EXPIRY_SKEW_MS = 10 * 60 * 1000;
const FALLBACK_EXPIRES_IN_S = 5 * 3600;

/** token 响应 → magpie 凭据字段（reference index.mjs:685）。 */
export function tokenFields(data) {
  const access = bareToken(nonEmptyString(data.access_token));
  if (!access) throw new Error("AutoClaw token response contained no access_token");
  const refresh = bareToken(nonEmptyString(data.refresh_token));
  if (!refresh) throw new Error("AutoClaw token response contained no refresh_token");
  const jwtExpires = jwtExpiresAtMs(access);
  const expiresInS = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : undefined;
  const expires = jwtExpires !== undefined
    ? jwtExpires - OAUTH_EXPIRY_SKEW_MS
    : Date.now() + (expiresInS ?? FALLBACK_EXPIRES_IN_S) * 1000 - OAUTH_EXPIRY_SKEW_MS;
  return { access, refresh, expires };
}

const PLATFORM = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
const USER_AGENT = "AutoClaw/" + CLIENT_VERSION + " (" + PLATFORM + "-" + process.arch + ")";

/** 业务签名头（登录/积分等 envelope 接口，reference index.mjs:527）。 */
export function bizHeaders() {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "User-Agent": USER_AGENT,
    "X-Version": CLIENT_VERSION,
    "X-Tm": platformTm(),
    "X-Product": PRODUCT,
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": md5Hex(APP_ID + "&" + ts + "&" + APP_KEY),
    "X-Trace-Id": randomHex(16),
    "X-Lang": "zh-CN",
    "X-Channel": CHANNEL,
    "Origin": "http://localhost:18432",
    "Referer": "http://localhost:18432/",
  };
}

function stainlessOs(platform = process.platform) {
  const p = String(platform).toLowerCase();
  if (p.includes("ios")) return "iOS";
  if (p === "android") return "Android";
  if (p === "darwin") return "MacOS";
  if (p === "win32") return "Windows";
  if (p === "freebsd") return "FreeBSD";
  if (p === "openbsd") return "OpenBSD";
  if (p === "linux") return "Linux";
  return p ? "Other:" + p : "Unknown";
}

function stainlessArch(arch = process.arch) {
  if (arch === "x32") return "x32";
  if (arch === "x86_64" || arch === "x64") return "x64";
  if (arch === "arm") return "arm";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return arch ? "other:" + arch : "unknown";
}

/** UUID-shaped X-Session-Id, stable per conversation (reference index.mjs:573). */
export function conversationSessionId(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const first = messages.find((m) => m && m.role !== "system");
  if (!first) return randomUUID();
  const h = createHash("sha256").update(JSON.stringify([first.role, first.content ?? null])).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-" + variant + h.slice(17, 20) + "-" + h.slice(20, 32);
}

/** 国际版对话头：官方 AutoClaw 2.0.3 desktop fingerprint（reference index.mjs:583）。 */
export function setOfficialChatHeaders(headers, { accessToken, model, sessionId, now = Date.now }) {
  const ts = String(Math.floor(now() / 1000));
  const rid = randomUUID();
  headers.set("Accept", "application/json");
  headers.set("User-Agent", "OpenAI/JS " + OPENAI_SDK_VERSION);
  headers.set("X-Stainless-Retry-Count", "0");
  headers.set("X-Stainless-Timeout", "600");
  headers.set("X-Stainless-Lang", "js");
  headers.set("X-Stainless-Package-Version", OPENAI_SDK_VERSION);
  headers.set("X-Stainless-OS", stainlessOs());
  headers.set("X-Stainless-Arch", stainlessArch());
  headers.set("X-Stainless-Runtime", "node");
  headers.set("X-Stainless-Runtime-Version", OFFICIAL_NODE_VERSION);
  headers.set("X-Version", OFFICIAL_CLIENT_VERSION);
  headers.set("X-Tm", platformTm());
  headers.set("X-Product", PRODUCT);
  headers.set("X-Auth-Appid", APP_ID);
  headers.set("X-Auth-TimeStamp", ts);
  headers.set("X-Auth-Sign", md5Hex(APP_ID + "&" + ts + "&" + APP_KEY));
  headers.set("X-Lang", OFFICIAL_LANG);
  headers.set("X-Channel", OFFICIAL_CHANNEL);
  headers.set("X-Trace-Id", rid);
  headers.set("X-Request-Id", rid);
  if (model) headers.set("X-Request-Model", model);
  headers.set("X-Client-Type", "pc");
  headers.set("x_trace_id", "autoclaw-desktop");
  headers.set("X-Session-Id", sessionId);
  headers.delete("Authorization");
  headers.delete("X-Harness-Type");
  headers.set("X-Authorization", "Bearer " + accessToken);
  return headers;
}

/** 国内版对话头：AutoClaw 2.1.0 managed gateway（reference index.mjs:1302）。 */
export function managedChatHeaders(token, model) {
  const ts = String(Math.floor(Date.now() / 1000));
  const rid = randomHex(16);
  const headers = new Headers(bizHeaders());
  headers.set("Accept", "application/json");
  headers.set("User-Agent", "AutoClaw/" + CN_CLIENT_VERSION + " (" + PLATFORM + "-" + process.arch + ")");
  headers.set("X-Channel", CN_CHANNEL);
  headers.set("X-Version", CN_CLIENT_VERSION);
  headers.set("X-Trace-Id", rid);
  headers.set("X-Request-Id", rid);
  headers.set("X-Request-Model", model);
  headers.set("X-Client-Type", "pc");
  headers.set("x_trace_id", "autoclaw-desktop");
  headers.set("X-Agent-Id", "main");
  headers.set("X-Authorization", "Bearer " + bareToken(token));
  headers.delete("Authorization");
  return headers;
}

// The gateway 406s a system prompt that names another harness/product. This
// is the subset that matters for the harnesses magpie connects (reference
// index.mjs:66-145 FLAGGED).
const FLAGGED = [
  [/You are a Claude agent, built on Anthropic's Claude Agent SDK\.?/gi, "You are a coding assistant."],
  [/(?:Anthropic's |the )?Claude Agent SDK/gi, "the agent framework"],
  [/You are an AI agent,?\s+powered by DeepSeek\s+Harness\.?/gi, "You are an AI agent powered by a local coding harness."],
  [/\bDeepSeek\s+Harness\b/gi, "DeepSeek"],
  [/You are Claude Code/gi, "You are the Claude Code CLI"],
  [/an agent for Claude Code(?! CLI)/gi, "an agent for the Claude Code CLI"],
  [/You are Codex/gi, "You are the Codex agent"],
  [/Codex CLI/gi, "Codex command-line tool"],
  [/You are opencode/gi, "You are the opencode agent"],
  [/You are Cursor/gi, "You are the Cursor agent"],
  [/You are Cline/gi, "You are the Cline agent"],
  [/You are Qwen Code/gi, "You are the Qwen Code agent"],
  [/You are ZCode/gi, "You are the ZCode agent"],
  [/This conversation is powered by GLM-([\w-]+(?:\.[\w-]+)*)/gi, "This conversation is powered by the GLM-$1 model"],
  [/(powered by )the model GLM-([\w-]+(?:\.[\w-]+)*)(\s*\[[\w-]+\])?/gi, "$1the GLM-$2 model"],
  [/(powered by )the GLM-([\w-]+(?:\.[\w-]+)*)(\s*\[[\w-]+\])?(\s+model\b)/gi, "$1the GLM-$2$4"],
  [/You are CodeBuddy Code/gi, "You are the CodeBuddy Code CLI"],
  [/You are Gemini CLI/gi, "You are the Gemini CLI agent"],
  [/You are Kimi Code CLI/gi, "You are the Kimi Code CLI agent"],
  [/You are goose\b/gi, "You are the goose agent"],
  [/You are Grok((?: \d[\w.-]*)?) released by xAI/gi, "You are the Grok$1 assistant released by xAI"],
];

function unflagged(text) {
  for (const [re, to] of FLAGGED) text = text.replace(re, to);
  return text;
}

function unflag(messages) {
  for (const m of messages) {
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    if (typeof m.content === "string") {
      m.content = unflagged(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part?.text === "string") part.text = unflagged(part.text);
      }
    }
  }
}

function tidyBody(payload) {
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const out = { ...m };
      if (out.content == null) out.content = "";
      delete out.reasoning_content;
      if (Array.isArray(out.tool_calls)) {
        out.tool_calls = out.tool_calls.map((c) => {
          const args = c?.function?.arguments;
          if (!c?.function || typeof args === "string") return c;
          return { ...c, function: { ...c.function, arguments: args == null ? "{}" : JSON.stringify(args) } };
        });
      }
      return out;
    });
  }
  if ("tools" in payload && !(Array.isArray(payload.tools) && payload.tools.length)) {
    delete payload.tools;
    delete payload.tool_choice;
  }
  return payload;
}

function prefixSystem(messages) {
  const idx = messages.findIndex((m) => m && m.role === "system");
  if (idx >= 0) {
    const cur = messages[idx].content;
    if (typeof cur === "string") {
      if (!cur.startsWith(OFFICIAL_SYSTEM_PROMPT)) {
        messages[idx] = { ...messages[idx], content: OFFICIAL_SYSTEM_PROMPT + "\n\n" + cur };
      }
    } else if (Array.isArray(cur)) {
      messages[idx] = { ...messages[idx], content: [{ type: "text", text: OFFICIAL_SYSTEM_PROMPT }, ...cur] };
    } else {
      messages[idx] = { ...messages[idx], content: OFFICIAL_SYSTEM_PROMPT };
    }
  } else {
    messages = [{ role: "system", content: OFFICIAL_SYSTEM_PROMPT }, ...messages];
  }
  return messages;
}

/** 国际版请求整形（reference index.mjs:440）。 */
export function rewriteOverseasBody(rawBody) {
  let payload;
  try {
    payload = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return null;
  tidyBody(payload);
  unflag(payload.messages);
  payload.messages = prefixSystem(payload.messages);
  delete payload.max_tokens;
  delete payload.max_completion_tokens;
  return payload;
}

/** 国内版请求整形（reference index.mjs:1321）。 */
export function rewriteManagedBody(rawBody) {
  const payload = tidyBody(JSON.parse(String(rawBody ?? "{}")));
  const model = typeof payload.model === "string" ? payload.model : "zai_auto";
  payload.model = model;
  delete payload.max_tokens;
  delete payload.max_completion_tokens;
  if (Array.isArray(payload.messages)) {
    unflag(payload.messages);
    payload.messages = prefixSystem(payload.messages);
  }
  return { payload, model };
}

const REFUSED_HINT =
  "AutoClaw refuses chats whose system prompt carries another agent's identity line (Claude Code, Claude Agent SDK, Codex, opencode, Cursor, Cline, Qwen Code, ZCode, DeepSeek Harness); this plugin rewrites the ones it knows, so an unknown one needs another provider in this group";

/** 非 2xx 把上游响应体原样返回并带 X-Magpie-Sign-In: kept（reference index.mjs:246）。 */
export async function explained(res) {
  if (res.status < 400) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("X-Magpie-Sign-In", "kept");
  const text = await res.text().catch(() => "");
  if (res.status !== 406) return new Response(text, { status: res.status, statusText: res.statusText, headers });
  let said = "";
  try {
    said = JSON.parse(text)?.error?.message ?? "";
  } catch {}
  headers.set("content-type", "application/json");
  return new Response(
    JSON.stringify({ error: { message: (said || "406 Not Acceptable") + " — " + REFUSED_HINT, type: "permission_error", code: null } }),
    { status: res.status, statusText: res.statusText, headers },
  );
}

// A 403 is not always the sign-in (reference index.mjs:271-341): quota is
// 810000 / 额度 wording, a banned account is 410004 / banned wording. Both
// keep the sign-in, so magpie must not mark the account expired.
const QUOTA_CODES = new Set(["810000"]);
const QUOTA_WORDS = /额度|余额不足|用完|用尽|quota|insufficient[_ ]?(balance|credit)|exhausted/i;
const BANNED_CODES = new Set(["410004"]);
const BANNED_WORDS = /\bbanned\b|封禁|封号|账号异常|账户异常|account (has been |is |was )?(suspended|frozen|disabled|blocked|restricted)|账[号户](已|已被|被)?(冻结|停用|禁用)/i;

function said(d) {
  if (!d || typeof d !== "object") return { code: null, message: "" };
  return {
    code: d.code ?? d.error?.code ?? null,
    message: String(d.message ?? d.msg ?? d.error?.message ?? "").trim(),
  };
}

async function parseBody(res) {
  const text = await res.clone().text().catch(() => "");
  try { return JSON.parse(text); } catch { return null; }
}

async function quotaRefusal(res) {
  if (res.status !== 403) return null;
  const d = await parseBody(res);
  if (!d || typeof d !== "object") return null;
  const { code, message } = said(d);
  if (!QUOTA_CODES.has(String(code)) && !(message && QUOTA_WORDS.test(message))) return null;
  try { res.body?.cancel?.(); } catch {}
  return new Response(JSON.stringify({ error: { message: "AutoClaw: " + (message || "quota exhausted"), type: "rate_limit_error", code } }), {
    status: 429,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  });
}

async function accountRefusal(res) {
  if (res.status !== 401 && res.status !== 403) return null;
  const d = await parseBody(res);
  const { code, message } = said(d);
  let ban = "";
  if (BANNED_CODES.has(String(code))) ban = message || "account refused (code " + code + ")";
  else if (message && BANNED_WORDS.test(message)) ban = message;
  if (!ban) return null;
  try { res.body?.cancel?.(); } catch {}
  return new Response(JSON.stringify({ error: { message: "AutoClaw: " + ban, type: "permission_error", code } }), {
    status: 403,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  });
}

export async function refusedNotSignIn(res) {
  return (await quotaRefusal(res)) ?? (await accountRefusal(res));
}

export function expiredResponse(message) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status: 401,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
  });
}

export function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const headers = { "content-type": "application/json" };
  if (error?.signIn) headers["x-magpie-sign-in"] = String(error.signIn);
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message ?? error),
        type: error?.signIn === "expired" ? "authentication_error" : "autoclaw_error",
      },
    }),
    { status, headers },
  );
}

/** envelope 接口调用（登录/验证码，reference index.mjs:651）。 */
export async function callEnvelope(path, { method = "GET", body, base }) {
  let response, text;
  try {
    response = await fetch(base + path, {
      method,
      headers: bizHeaders(),
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    text = await response.text();
  } catch (cause) {
    throw Object.assign(new Error("AutoClaw request failed: " + (cause?.message ?? cause)), { cause });
  }
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!parsed || (parsed.code === undefined && response.status >= 400)) {
    const err = new Error("AutoClaw " + path.split("?")[0] + " non-envelope response (HTTP " + response.status + "): " + text.slice(0, 200));
    if (response.status === 401 || response.status === 403) err.signIn = "expired";
    throw err;
  }
  return { status: response.status, code: parsed.code, msg: parsed.msg ?? parsed.message, data: parsed.data };
}
