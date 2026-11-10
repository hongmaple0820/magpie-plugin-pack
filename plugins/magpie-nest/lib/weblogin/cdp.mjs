// DevTools-protocol glue for the web-login engine: find or open the page
// on the channel's site, watch its cookies and storage for the token, and
// mirror what ChatLink's inAppLogin does for one provider at a time.
//
// Watch-then-poll: HttpOnly cookies never reach DOM events, so besides
// Network events a slow poll re-reads cookies and storage every interval.
// One full check per 1.5s, the throttle ChatLink found necessary.

import { listTargets } from "./browser.mjs";
import { wsConnect } from "./ws.mjs";

const FULL_CHECK_THROTTLE_MS = 1500;

export async function cdpWatch({ port, channelId, loginUrl, targetDomains, tokenSources, timeoutMs, signal, extraCookies }) {
  const domainMatch = (url) => {
    if (!url) return false;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return targetDomains.some((d) => host === d || host.endsWith("." + d));
  };

  let target = await findTarget(port, domainMatch);
  if (!target) target = await openTarget(port, loginUrl);
  if (!target) throw new Error("browser: no usable page on 127.0.0.1:" + port);

  const ws = await wsConnect(
    { host: "127.0.0.1", port, path: target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, "") },
    { timeoutMs: 10000 },
  );

  let nextId = 0;
  const pending = new Map();
  const reportedNetworkTokens = new Set();
  let lastFullCheck = 0;
  let tokenFound = null;
  let tokenVia = null;
  const startedAt = Date.now();

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!ws.open) return reject(new Error("cdp: connection closed"));
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.onMessage((raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error("cdp: " + msg.error.message));
      else resolve(msg.result);
      return;
    }
    handleEvent(msg.method, msg.params).catch(() => {});
  });

  const closedPromise = new Promise((resolve) => ws.onClose(resolve));

  ws.onClose(() => {
    for (const { reject } of pending.values()) {
      reject(new Error("cdp: connection closed"));
    }
    pending.clear();
  });

  const guard = (fn, ...args) =>
    fn(...args).catch((error) => {
      if (signal?.aborted) throw error;
      return undefined;
    });

  async function findTarget(port, domainMatch) {
    const targets = await listTargets(port);
    return (
      targets.find((t) => t.type === "page" && domainMatch(t.url)) ??
      targets.find((t) => t.type === "page")
    );
  }

  async function openTarget(port, url) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url), {
        method: "PUT",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function headerValue(headers, name) {
    for (const [k, v] of Object.entries(headers || {})) {
      if (k.toLowerCase() === name.toLowerCase()) return String(v);
    }
    return null;
  }

  async function handleEvent(method, params) {
    if (method === "Network.requestWillBeSent") {
      const url = params?.request?.url ?? "";
      const headers = params?.request?.headers ?? {};
      if (!domainMatch(url)) return;
      const source = tokenSources.find((s) => s.type === "networkHeader");
      if (!source) return;
      const raw = headerValue(headers, source.key);
      if (!raw) return;
      const token = extractFromPattern(raw, source);
      if (token && !reportedNetworkTokens.has(token)) {
        reportedNetworkTokens.add(token);
        acceptToken(token, "network header " + source.key);
      }
      return;
    }
    if (
      method === "Network.requestWillBeSentExtraInfo" ||
      method === "Network.responseReceivedExtraInfo"
    ) {
      const headers = params?.headers ?? {};
      const source = tokenSources.find((s) => s.type === "networkHeader");
      if (!source) return;
      const raw = headerValue(headers, source.key);
      if (!raw) return;
      const token = extractFromPattern(raw, source);
      if (token && !reportedNetworkTokens.has(token)) {
        reportedNetworkTokens.add(token);
        acceptToken(token, "network header " + source.key + " (extra)");
      }
      return;
    }
    if (method.startsWith("Storage.")) {
      await fullCheck();
      return;
    }
  }

  function extractFromPattern(raw, source) {
    const value = String(raw).trim();
    if (!value) return null;
    if (source.extractPattern) {
      const m = new RegExp(source.extractPattern, "i").exec(value);
      if (!m || !m[1]) return null;
      return m[1].trim();
    }
    return value;
  }

  async function readAll() {
    const entries = [];
    try {
      const { cookies } = await send("Network.getCookies", { urls: [target.url] });
      lastCookies = cookies ?? [];
      for (const c of cookies ?? []) {
        entries.push({ where: "cookie", key: c.name, value: c.value });
      }
    } catch {}
    try {
      const expr = "JSON.stringify(Object.entries(localStorage))";
      const result = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      for (const [key, value] of JSON.parse(result?.result?.value || "[]")) {
        entries.push({ where: "localStorage", key, value: String(value) });
      }
    } catch {}
    return entries;
  }

  async function fullCheck() {
    if (tokenFound) return;
    if (Date.now() - lastFullCheck < FULL_CHECK_THROTTLE_MS) return;
    lastFullCheck = Date.now();
    try {
      const entries = await readAll();
      for (const entry of entries) {
        for (const source of tokenSources) {
          if (source.type === "networkHeader") continue;
          if (source.key !== entry.key) continue;
          if ((source.type === "cookie") !== (entry.where === "cookie")) continue;
          acceptToken(entry.value, source.type + " " + entry.key, source);
        }
      }
    } catch {}
  }

  function acceptToken(rawValue, via, source) {
    if (tokenFound) return;
    let value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) return;
    if (value.startsWith("{")) {
      // AppKit-wrapped / 结构化值：{"value":"…","__version":"0"} 或声明了 jsonField
      try {
        const wrapped = JSON.parse(value);
        const field = source?.jsonField;
        if (field && typeof wrapped?.[field] === "string") value = wrapped[field].trim();
        else if (typeof wrapped?.value === "string") value = wrapped.value.trim();
      } catch {}
    }
    if (value.length < 16 || /^\d+$/.test(value)) return;
    tokenFound = value;
    tokenVia = via;
  }

  // WAF cookie 集：有的网关（chat.qwen.ai 走阿里 WAF）只认浏览器整套 cookie，
  // 裸 Bearer 会被挑战页拦下。登录时把它们收齐，随令牌一起落库。
  function collectCookies() {
    const out = [];
    for (const c of lastCookies) {
      const v = String(c.value ?? "");
      if (v) out.push(c.name + "=" + v);
    }
    return out.join("; ");
  }
  let lastCookies = [];

  await guard(() => send("Network.enable"));
  await guard(() => send("DOMStorage.enable"));
  await guard(() => send("Storage.enable"));
  await fullCheck();

  const poll = setInterval(() => {
    fullCheck().catch(() => {});
  }, FULL_CHECK_THROTTLE_MS);

  const onAbort = () => {
    try {
      ws.close();
    } catch {}
  };
  signal?.addEventListener?.("abort", onAbort);

  try {
    while (!tokenFound && Date.now() - startedAt < timeoutMs) {
      await Promise.race([closedPromise, delay(500)]);
    }
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    clearInterval(poll);
    try {
      ws.close();
    } catch {}
  }

  if (signal?.aborted) throw new Error("browser login: aborted");
  if (!tokenFound) {
    const seconds = Math.round(timeoutMs / 1000);
    throw Object.assign(new Error("browser login: " + channelId + " " + seconds + " 秒内没有出现令牌"), {
      timeout: true,
    });
  }
  return { token: tokenFound, via: tokenVia, target, ...(extraCookies ? { cookieJar: collectCookies() } : {}) };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
