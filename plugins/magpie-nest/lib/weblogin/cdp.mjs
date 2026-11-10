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

export async function cdpWatch({ port, channelId, loginUrl, targetDomains, tokenSources, timeoutMs, signal, extraCookies, extraQuery, triggerChat }) {
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
      if (extraQuery && /fp=verify_/.test(url)) {
        try {
          const q = new URL(url).searchParams;
          for (const key of ["device_id", "fp", "msToken", "a_bogus", "tea_uuid", "web_id"]) {
            const v = q.get(key);
            if (v) fpQuery[key] = v;
          }
        } catch {}
      }
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
    if (tokenFound && (!extraQuery || Object.keys(fpQuery).length > 0)) return;
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
  const fpQuery = {};

  await guard(() => send("Network.enable"));
  await guard(() => send("DOMStorage.enable"));
  await guard(() => send("Storage.enable"));
  await fullCheck();

  const poll = setInterval(() => {
    fullCheck().catch(() => {});
  }, FULL_CHECK_THROTTLE_MS);

  // 主令牌命中后仍可能要等指纹 query：渠道声明了 triggerChat 就在页面里发一条
  // 消息，让真实 chat 请求把 fp/msToken/a_bogus 带出来（豆包就是这样）。
  /**
   * 触发一次真实对话请求，好让指纹参数（fp/msToken/a_bogus）出现在 URL 里。
   * 步骤：可选导航到对话页 → 等输入框就绪 → 填字 → 回车/点发送。
   */
  async function triggerChatOnce() {
    const spec = typeof triggerChat === "string" ? { text: triggerChat } : triggerChat || {};
    try {
      if (spec.navigate) {
        await send("Page.navigate", { url: spec.navigate }).catch(() => {});
        await delay(3000);
      }
      const readyMs = Number(spec.readyMs) || 15000;
      const sel = String(spec.readySelector || "textarea");
      const started = Date.now();
      for (;;) {
        const probe = await send("Runtime.evaluate", {
          expression: "!!document.querySelector(" + JSON.stringify(sel) + ")",
          returnByValue: true,
        }).catch(() => null);
        if (probe?.result?.value === true) break;
        if (Date.now() - started > readyMs) return;
        await delay(700);
      }
      const typed = await send("Runtime.evaluate", {
        expression: `(() => {
          const ta = document.querySelector(${JSON.stringify(sel)});
          if (!ta) return 'no-input';
          ta.focus();
          const text = ${JSON.stringify(String(spec.text || "hi"))};
          if (ta.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, text);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('insertText', false, text);
          }
          return ta.value === text || ta.textContent.includes(text) ? 'typed' : 'typed-partial';
        })()`,
        returnByValue: true,
      }).catch(() => null);
      await delay(1200);
      await send("Runtime.evaluate", {
        expression: `(() => {
          const form = document.querySelector('form');
          if (form) {
            const btn = [...form.querySelectorAll('button')].filter((b) => !b.disabled && b.type === 'submit').pop();
            if (btn) { btn.click(); return 'clicked'; }
          }
          const ta = document.querySelector(${JSON.stringify(sel)});
          if (ta) {
            for (const type of ['keydown', 'keypress', 'keyup']) {
              ta.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
            return 'enter';
          }
          return 'no-action';
        })()`,
        returnByValue: true,
      }).catch(() => {});
    } catch {}
  }

  const onAbort = () => {
    try {
      ws.close();
    } catch {}
  };
  signal?.addEventListener?.("abort", onAbort);

  let triggered = false;
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const done = tokenFound && (!extraQuery || Object.keys(fpQuery).length > 0);
      if (done) break;
      if (tokenFound && extraQuery && !triggered) {
        triggered = true;
        await triggerChatOnce();
      }
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
  return {
    token: tokenFound,
    via: tokenVia,
    target,
    ...(extraCookies ? { cookieJar: collectCookies() } : {}),
    ...(extraQuery && Object.keys(fpQuery).length ? { fpQuery } : {}),
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
