// 页面内请求：把对话请求放到真实浏览器页面里发。
//
// 为什么要这么做：有些网关（豆包）除了 cookie 和指纹 query，还按「请求是不是
// 真浏览器发的」做风控——同样的 cookie、同样的指纹，Node 直接 fetch 会被判
// STREAM_ERROR 710022004 rate limited / subtype: slide（滑块验证）。页面内
// fetch 带着真实的 TLS 指纹、UA、sec-ch-ua、referrer 与 JS 上下文，风控放行。
//
// 代价：需要常驻一个浏览器实例。这里按 profile 复用同一个窗口，闲置超时后
// 自动关闭，避免留下僵尸窗口。

import { findBrowser, freePort, killProfileHolders, launchBrowser, killBrowser, profileDirFor, waitCdp } from "./browser.mjs";
import { listTargets } from "./browser.mjs";
import { wsConnect } from "./ws.mjs";

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const sessions = new Map(); // profileDir -> { port, child, ws, send, ready }

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** 建立（或复用）一个带 DevTools 的浏览器会话。 */
async function openSession(profileDir, startUrl) {
  const existing = sessions.get(profileDir);
  if (existing?.ws?.open) {
    existing.idleAt = Date.now();
    return existing;
  }

  const exe = findBrowser();
  if (!exe) throw new Error("页面内请求需要 Chrome 或 Edge；设置 MAGPIE_NEST_BROWSER 指向可执行文件");

  await killProfileHolders(profileDir);
  const port = await freePort();
  const child = launchBrowser({ exe, profileDir, port, startUrl });
  await waitCdp(port, 25000);

  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("页面内请求：浏览器没有可用页面");

  const ws = await wsConnect(
    { host: "127.0.0.1", port, path: page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, "") },
    { timeoutMs: 10000 },
  );

  let nextId = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!ws.open) return reject(new Error("页面内请求：连接已断开"));
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.onMessage((raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  ws.onClose(() => {
    for (const { reject } of pending.values()) reject(new Error("页面内请求：连接已断开"));
    pending.clear();
    sessions.delete(profileDir);
    killBrowser(child).catch(() => {});
  });

  await send("Page.enable").catch(() => {});
  await send("Runtime.enable").catch(() => {});

  const session = { port, child, ws, send, ready: false, idleAt: Date.now() };
  sessions.set(profileDir, session);
  return session;
}

/** 等到页面停在目标域上，并且 localStorage 里能看到该渠道的令牌。 */
async function ensureLoggedIn(session, targetDomains, tokenKeys, timeoutMs) {
  const started = Date.now();
  const onDomain = (url) => {
    try {
      const host = new URL(url).hostname;
      return targetDomains.some((d) => host === d || host.endsWith("." + d));
    } catch {
      return false;
    }
  };
  for (;;) {
    const targets = await listTargets(session.port).catch(() => []);
    const page = targets.find((t) => t.type === "page" && onDomain(t.url));
    if (page) {
      if (!tokenKeys?.length) return page;
      const probe = await session
        .send("Runtime.evaluate", {
          expression: "JSON.stringify(Object.keys(localStorage))",
          returnByValue: true,
        })
        .catch(() => null);
      const keys = (() => {
        try {
          return JSON.parse(probe?.result?.value || "[]");
        } catch {
          return [];
        }
      })();
      if (tokenKeys.every((k) => keys.includes(k))) return page;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("页面内请求：" + timeoutMs / 1000 + " 秒内浏览器没有停在已登录的页面");
    }
    await delay(700);
  }
}

/**
 * 在页面里发一个请求。
 * 返回 { status, contentType, text }——SSE 由调用方自己投影。
 */
export async function pageRequest({
  channelId,
  profileDir,
  targetDomains,
  loginUrl,
  tokenKeys = [],
  url,
  body,
  headers = {},
  loginWaitMs = 300000,
  timeoutMs = 180000,
}) {
  const dir = profileDir ?? profileDirFor(channelId);
  const session = await openSession(dir, loginUrl);

  try {
    await ensureLoggedIn(session, targetDomains, tokenKeys, loginWaitMs);

    // 页面可能停在别的路由（登录跳转、落地页）：先导航到对话页再发请求，
    // 否则同源检查会让 fetch 直接 TypeError: Failed to fetch。
    const current = await session
      .send("Runtime.evaluate", { expression: "location.href", returnByValue: true })
      .catch(() => null);
    const here = String(current?.result?.value || "");
    const sameOrigin = (() => {
      try {
        const host = new URL(here).hostname;
        return targetDomains.some((d) => host === d || host.endsWith("." + d));
      } catch {
        return false;
      }
    })();
    if (!sameOrigin) {
      await session.send("Page.navigate", { url: loginUrl }).catch(() => {});
      await delay(4000);
      await ensureLoggedIn(session, targetDomains, tokenKeys, loginWaitMs);
    }

    const expression = `(async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        method: "POST",
        credentials: "include",
        headers: Object.assign({ "Content-Type": "application/json" }, ${JSON.stringify(headers)}),
        body: ${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))},
      });
      const text = await res.text();
      return JSON.stringify({ status: res.status, contentType: res.headers.get("content-type") || "", text });
    })()`;

    const result = await session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    });

    if (result?.exceptionDetails) {
      throw new Error("页面内请求失败：" + (result.exceptionDetails.text || "脚本异常"));
    }
    const value = result?.result?.value;
    if (!value) throw new Error("页面内请求：页面没有返回内容");
    session.idleAt = Date.now();
    return JSON.parse(value);
  } catch (error) {
    // 一次失败就关掉会话：下次重新拉起，避免带着半死窗口继续撞墙。
    await closePageSession(dir).catch(() => {});
    throw error;
  }
}

export async function closePageSession(profileDir) {
  const session = sessions.get(profileDir);
  if (!session) return;
  sessions.delete(profileDir);
  try {
    session.ws.close();
  } catch {}
  await killBrowser(session.child).catch(() => {});
}

/** 闲置回收：宿主进程里没有定时任务的地方，由每次调用顺手清理。 */
export function reapIdleSessions() {
  const now = Date.now();
  for (const [dir, session] of sessions) {
    if (now - session.idleAt > IDLE_CLOSE_MS) {
      closePageSession(dir).catch(() => {});
    }
  }
}
