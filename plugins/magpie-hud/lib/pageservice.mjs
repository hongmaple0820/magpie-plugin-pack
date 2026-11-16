// 鹊楼面板的本地服务（package.json 的 magpie.page.service）。
//
// 为什么需要它：magpie 自己服务的页面文件带 connect-src 'none'
// （internal/gui/pluginpage.go 的 pagePolicy），页面 fetch 不了任何东西；
// 唯一通路是 magpie.page.service 声明的本地服务——桌面窗口里页面直接
// 去 http://127.0.0.1:<port>/，magpie web 里经
// /_magpie/plugin/<token>/_magpie/service/ 反代（internal/gui/pageservice.go），
// 桥把该地址作为 magpie.service 交给页面（page/index.html 只是个 loader）。
//
// 数据引擎（会话扫描 / journal / 额度读取）由 index.mjs 从本插件 lib 注
// 入（engine 参数）；engine 为 null（引擎加载失败，通常是 fzstd 依赖
// 损坏）时 /api/state 与 /api/quotas 返回 requires: "engine"，面板明说
// 引擎不可用。
//
// 安全形状照 pageservice.go 的代理与 page-chat 先例：
//   - 只听 127.0.0.1；Host 必须是本机本端口（防 DNS rebinding）；
//   - Origin 只许缺失或 "null"（沙箱帧发的是 null），其余 403；
//   - 一律 Access-Control-Allow-Origin: *：沙箱帧是不透明 origin，对
//     本服务的 fetch 是跨源请求，没有 CORS 头会被浏览器拦掉；不带凭据
//     （代理也会摘掉 cookie）；
//   - HTML 带 CSP：sandbox allow-scripts，源显式命名本机本端口——
//     WebKit 对不透明 origin 的 'self' 匹配不了（#4198），web 模式下
//     代理的 serviceSelf 会在每个 'self' 后补上反代根；不写
//     frame-ancestors：桌面窗口的父帧是 wails 源，'self' 会把帧拒掉，
//     web 模式代理自己会加 frame-ancestors 'self'。
import { createServer } from "node:http";
import { burnRate } from "./usage/history.mjs";
import { annotateProviders, arbitrateQuotas } from "./usage/arbitrate.mjs";
import { desktopStatus, retryDesktop } from "./desktop.mjs";
import { readSettings, writeSettings } from "./settings.mjs";
import { hostTheme } from "./theme.mjs";
import { activity, answerAsk, beat, channelRoot, channelStatus, liveSessions, pendingAsks, promptResult, promptSession } from "./channel.mjs";
import { install as installDsh, status as dshStatus, uninstall as uninstallDsh } from "./dsh-plugin.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // lib/
const WEBAPP = join(HERE, "..", "webapp");
const QUOTA_CACHE_MS = 60_000;
// 会话快照的保鲜期。扫描本身已经是 stat 级（lib/sessions.mjs 有按文件
// size+mtime 的落盘缓存），所以这里可以勤刷一点，让「在跑」不滞后。
const SESSIONS_CACHE_MS = 10_000;
// 没有任何快照时，最多等扫描这么久；超时就先回空快照，别把面板/ HUD 拖死。
const STATE_WAIT_MS = 1500;

// 静态文件白名单：只认这几个名字，杜绝任何路径拼接。
// hud.* 是桌面 HUD 窗口加载的紧凑视图（window.ipc → Rust 外壳）。
const FILES = {
  "app.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
  "notify.mjs": "text/javascript; charset=utf-8",
  "hud.html": "text/html; charset=utf-8",
  "hud.js": "text/javascript; charset=utf-8",
  "hud.css": "text/css; charset=utf-8",
  "icon.svg": "image/svg+xml",
};

// package.json 的 magpie.page.service：默认端口 + 可搬动的 option 名。
// 端口取值照 plugin/page.go 的 portOf：整数或整数字符串，1..65535。
export function pageServicePort(options = {}) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).magpie?.page?.service;
  } catch {
    return null;
  }
  if (!spec || typeof spec !== "object") return null;
  const portOf = (v) => {
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };
  let port = portOf(spec.port);
  if (spec.option && portOf(options[spec.option]) != null) port = portOf(options[spec.option]);
  if (port && process.env.MAGPIE_HUD_PAGE_PORT === "0") port = 0; // 测试并行时拿临时端口
  return port;
}

// 造一个面板服务（测试可注入引擎、可用 0 号端口拿临时端口）。
// engine = { listSessions, journal: () => ({messages}), listQuotas } | null。
// 读 JSON 请求体：上限 64KB，形状必须是对象。失败返回 {code,error}，成功 {value}。
async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return { code: 413, error: "请求体太大（上限 64KB）。" };
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return { code: 400, error: "请求体不是合法 JSON。" };
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return { code: 400, error: "请求体必须是 JSON 对象。" };
  return { value: parsed };
}
export function createPageService({ port = 0, engine = null, quotaCacheMs = QUOTA_CACHE_MS } = {}) {
  let display = null; // 桥上报的显示器清单（内存）
  let quotaCache = null; // {at, value}
  let dshCache = null; // {at, value}：DSH 安装状态读两个小文件，10 秒缓存够了
  let sessionsCache = null; // {at, value}
  const origin = (p) => `http://127.0.0.1:${p} http://localhost:${p}`;
  const policy = (p) =>
    [
      "sandbox allow-scripts",
      "default-src 'none'",
      `script-src 'self' ${origin(p)}`,
      `style-src 'self' 'unsafe-inline' ${origin(p)}`,
      `connect-src 'self' ${origin(p)}`,
      `img-src 'self' data: ${origin(p)}`,
    ].join("; ");

  // 会话快照一律后台刷新、请求只读快照：扫描绝不能压在请求路径上
  // （症状就是这么来的：85 秒的扫描 + HUD 8 秒超时 = 屏幕上「0 个会话」）。
  let sessionsInflight = null;
  const refreshSessions = () => {
    if (sessionsInflight) return sessionsInflight; // single-flight：并发请求只触发一次扫描
    sessionsInflight = (async () => {
      try {
        const value = await engine.listSessions();
        sessionsCache = { at: Date.now(), value };
        return value;
      } finally {
        sessionsInflight = null;
      }
    })();
    return sessionsInflight;
  };
  // stateNow：新鲜快照直接用；有旧快照就先给旧的、后台续期；都没有才等（有上限）
  const stateNow = async () => {
    const fresh = sessionsCache && Date.now() - sessionsCache.at <= SESSIONS_CACHE_MS;
    if (fresh) return sessionsCache;
    const pending = refreshSessions().catch(() => null);
    if (sessionsCache) return sessionsCache;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), STATE_WAIT_MS));
    await Promise.race([pending, timeout]);
    return sessionsCache ?? { at: 0, value: null };
  };

  const server = createServer((req, res) => {
    const bound = server.listening ? server.address().port : port;
    const send = (status, type, body, extra = {}) => {
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-cache",
        ...extra,
      };
      if (type) headers["Content-Type"] = type;
      res.writeHead(status, headers);
      res.end(body);
    };
    // Host 必须是本机本端口（代理会把 Host 改成服务自己的；桌面窗口里
    // 浏览器发的也是它）。别的 Host 多半是 DNS rebinding。
    const host = String(req.headers.host || "").toLowerCase();
    const mine = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`]);
    if (bound !== 0 && !mine.has(host)) {
      send(403, "text/plain; charset=utf-8", "this is magpie-hud's page service: wrong host");
      return;
    }
    // Origin 只许：缺失（导航）、"null"（沙箱帧的 fetch）、或桌面桥的 wails 资源源
    // （http://wails.localhost —— 页面由 wails 服务时它就是这个源；该主机名只解析到
    // 本机的 wails 应用，不是外部站点）。其余一律拒。
    const heads = req.headers.origin;
    const originValue = Array.isArray(heads) ? heads.join(",") : heads;
    const wailsOrigin = /^https?:\/\/wails\.localhost(:\d+)?$/;
    if (originValue != null && originValue !== "null" && !wailsOrigin.test(String(originValue))) {
      send(403, "text/plain; charset=utf-8", "this is magpie-hud's page service: only its page asks it");
      return;
    }
    // 预检：页面在 CSP sandbox 里是不透明 origin，POST JSON 是跨源非简单
    // 请求，浏览器先发 OPTIONS；不答它，fetch 直接 Failed to fetch。
    if (req.method === "OPTIONS") {
      send(204, null, null, {
        "Access-Control-Allow-Methods": "GET, HEAD, POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
      });
      return;
    }
    const postPaths = new Set([
      "/api/send",
      "/api/settings",
      "/api/display",
      "/api/asks/answer",
      "/api/prompt",
      "/api/channel/install",
      "/api/desktop",
    ]);
    if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && postPaths.has((req.url || "").split("?")[0]))) {
      send(405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }
    const path = (req.url || "/").split("?")[0];
    const query = new URL(req.url || "/", "http://x").searchParams;
    if (path === "/" || path === "/app.html" || path === "/index.html") {
      send(200, FILES["app.html"], readFileSync(join(WEBAPP, "app.html")), {
        "Content-Security-Policy": policy(bound),
        "Cache-Control": "no-store",
      });
      return;
    }
    if (FILES[path.slice(1)] && path.startsWith("/")) {
      const name = path.slice(1);
      // no-store：插件更新后必须立刻生效。否则用户会看到旧界面，
      // 而且「我改了怎么没变」这种问题极难自查。
      send(200, FILES[name], readFileSync(join(WEBAPP, name)), { "Cache-Control": "no-store" });
      return;
    }
    // 面板发消息：body 是 {to, text, replyTo}，human 旗标由服务端定死
    // （面板是人，不是 agent 调用方）。上限 64KB——一条消息不该更大。
    if (path === "/api/send") {
      (async () => {
        if (!engine || typeof engine.send !== "function") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ requires: "engine" }));
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 * 1024) {
            send(413, "application/json; charset=utf-8", JSON.stringify({ error: "消息太长（上限 64KB）。" }));
            return;
          }
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "请求体不是合法 JSON。" }));
          return;
        }
        if (typeof body !== "object" || body == null || Array.isArray(body)) {
          send(400, "application/json; charset=utf-8", JSON.stringify({ error: "请求体必须是 JSON 对象。" }));
          return;
        }
        try {
          const out = await engine.send({
            to: typeof body.to === "string" ? body.to : "",
            text: typeof body.text === "string" ? body.text : "",
            replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
            human: true,
          });
          send(200, "application/json; charset=utf-8", JSON.stringify(out));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 消息状态与答案：面板轮询它看回复。
    if (path === "/api/message") {
      (async () => {
        if (!engine || typeof engine.getMessage !== "function") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ requires: "engine" }));
          return;
        }
        try {
          const id = String(query.get("id") ?? "");
          if (!id) {
            send(400, "application/json; charset=utf-8", JSON.stringify({ error: "需要 id 参数。" }));
            return;
          }
          send(200, "application/json; charset=utf-8", JSON.stringify(engine.getMessage(id)));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 显示器清单：桌面桥探测到几块屏就 POST 上来，页面用它渲染选择器。
    // 存内存不落盘——它是运行时事实，不是用户设置。
    if (path === "/api/display") {
      if (req.method === "POST") {
        (async () => {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16 * 1024) { send(413, "application/json; charset=utf-8", JSON.stringify({ error: "太大。" })); return; }
            chunks.push(chunk);
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            display = {
              screens: Array.isArray(body.screens) ? body.screens.slice(0, 16) : display?.screens ?? [],
              current: typeof body.current === "string" ? body.current : display?.current ?? "",
              // 页面自报的诊断，按 origin 分开记：桌面桥的 wails 页面与插件自己的
              // 页面会同时上报，互相覆盖就看不出「HUD 窗口里拖拽是否就绪」了
              pages: (() => {
                const pages = { ...(display?.pages ?? {}) };
                if (body.page && typeof body.page === "object") {
                  const key = typeof body.page.origin === "string" ? body.page.origin : "unknown";
                  pages[key] = { ...body.page, at: Date.now() };
                }
                return pages;
              })(),
              page: body.page && typeof body.page === "object" ? body.page : display?.page ?? null,
              at: Date.now(),
            };
            send(200, "application/json; charset=utf-8", JSON.stringify(display));
          } catch (error) {
            send(400, "application/json; charset=utf-8", JSON.stringify({ error: "请求体不是合法 JSON。" }));
          }
        })();
        return;
      }
      send(200, "application/json; charset=utf-8", JSON.stringify(display ?? { screens: [], current: "", at: null }));
      return;
    }
    // 桌面 HUD 的存活与失败原因：面板设置页要能回答「HUD 怎么没出来」。
    // 重试会把 .failed 标记删掉再拉一次，否则用户只能自己去找那个隐藏文件。
    if (path === "/api/desktop") {
      if (req.method === "POST") {
        send(200, "application/json; charset=utf-8", JSON.stringify(retryDesktop({ port: server.listening ? server.address().port : port })));
        return;
      }
      send(200, "application/json; charset=utf-8", JSON.stringify(desktopStatus()));
      return;
    }
    // HUD 设置：GET 读，POST 合并写。桌面桥与页面共用这一份。
    if (path === "/api/settings") {
      if (req.method === "POST") {
        (async () => {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16 * 1024) { send(413, "application/json; charset=utf-8", JSON.stringify({ error: "设置太大。" })); return; }
            chunks.push(chunk);
          }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {
            send(400, "application/json; charset=utf-8", JSON.stringify({ error: "请求体不是合法 JSON。" }));
            return;
          }
          try { send(200, "application/json; charset=utf-8", JSON.stringify(writeSettings(body))); } catch (error) {
            send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
          }
        })();
        return;
      }
      // 一并给出宿主主题：页面据此在 theme=auto 时跟随 magpie
      send(200, "application/json; charset=utf-8", JSON.stringify({ ...readSettings(), hostTheme: hostTheme() }));
      return;
    }
    // 一个会话的详情：元信息 + 消息线程 + 它的 token 时序。
    if (path === "/api/session") {
      (async () => {
        if (!engine || typeof engine.sessionDetail !== "function") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), requires: "engine" }));
          return;
        }
        try {
          const id = String(query.get("id") ?? "");
          if (!id) { send(400, "application/json; charset=utf-8", JSON.stringify({ error: "需要 id 参数。" })); return; }
          // 用 /api/state 那份快照里的会话，别在这里等一次扫描
          let hint = null;
          try { hint = ((await stateNow()).value?.sessions ?? []).find((s) => s.id === id) ?? null; } catch { /* 快照不可用就退回扫描 */ }
          const out = await engine.sessionDetail(id, Number(query.get("hours")) || 24, hint);
          if (!out) { send(404, "application/json; charset=utf-8", JSON.stringify({ error: "没有这个会话。" })); return; }
          send(200, "application/json; charset=utf-8", JSON.stringify(out));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 本机各 agent 的安装/活跃情况
    if (path === "/api/agents") {
      (async () => {
        try {
          const list = typeof engine?.agents === "function" ? engine.agents() : [];
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), agents: list }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 各账号各窗口的额度剩余走势（掉得多快 = 烧得多快）。
    if (path === "/api/quota-history") {
      (async () => {
        if (!engine || typeof engine.providerQuotaHistory !== "function") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), requires: "engine" }));
          return;
        }
        try {
          const hours = Number(query.get("hours")) || 168;
          const out = engine.providerQuotaHistory(Date.now() - hours * 3_600_000);
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), hours, ...out }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 额度时序：面板画 24h 走势与烧录率。since 可带（毫秒），缺省 24h。
    if (path === "/api/history") {
      (async () => {
        if (!engine || typeof engine.quotaHistory !== "function") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), requires: "engine" }));
          return;
        }
        try {
          const since = Number(query.get("since")) || Date.now() - 24 * 3_600_000;
          const series = engine.quotaHistory().window(since);
          send(200, "application/json; charset=utf-8", JSON.stringify({
            at: Date.now(),
            since,
            series: series.map((row) => ({ ...row, burn: burnRate(row) })),
          }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 令牌用量：24h / 7d / 30d。首次调用可能只返回部分（后台扫描），
    // scanning/parsed/total/skipped 让面板如实说明。
    if (path === "/api/tokens") {
      (async () => {
        if (!engine || typeof engine.tokenUsage !== "function") {
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), requires: "engine" }));
          return;
        }
        try {
          const period = String(query.get("period") || "24h");
          const out = engine.tokenUsage(period);
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), ...out }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 浏览器自动要的图标：给 204，别在控制台留 404 噪音
    if (path === "/favicon.ico") {
      send(204, null, null);
      return;
    }
    if (path === "/api/state") {
      (async () => {
        if (!engine) {
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), requires: "engine" }));
          return;
        }
        try {
          const snap = await stateNow();
          const found = snap.value ?? {};
          const log = engine.journal();
          const sessions = found.sessions ?? [];
          send(200, "application/json; charset=utf-8", JSON.stringify({
            at: Date.now(),
            // total/running 是按全部会话算的（列表封顶 50 是为了工具输出），
            // 桌面 HUD 用它们显示，才不会把 174 个会话说成 50 个。
            total: found.total ?? sessions.length,
            running: found.running ?? sessions.filter((s) => s.state === "running").length,
            ageMs: snap.at ? Date.now() - snap.at : null,
            refreshing: !!sessionsInflight,
            sessions,
            messages: [...log.messages].reverse(),
          }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    if (path === "/api/quotas") {
      (async () => {
        if (!engine) {
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: Date.now(), requires: "engine" }));
          return;
        }
        try {
          if (!quotaCache || Date.now() - quotaCache.at > quotaCacheMs) {
            const own = await engine.listQuotas().catch(() => ({ clients: [] }));
            const wide = typeof engine.providerQuotas === "function" ? engine.providerQuotas() : null;
            const at = Date.now();
            // 仲裁在服务端做一次就够：面板和工具看到的是同一组窗口与同一套来源诊断。
            // 现有 providers / clients 原样保留——桌面 HUD 与面板都在读它们。
            const arbitration = arbitrateQuotas({ clients: own?.clients, providers: wide?.providers, at });
            quotaCache = {
              at,
              value: {
                ...own,
                providers: annotateProviders(wide?.providers ?? [], arbitration.windows),
                providerTotals: wide?.totals ?? null,
                providerAt: wide?.at ?? null,
                windows: arbitration.windows,
                arbitration: { sources: arbitration.sources, conflicts: arbitration.conflicts },
              },
            };
          }
          send(200, "application/json; charset=utf-8", JSON.stringify({ at: quotaCache.at, ...quotaCache.value }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // ---- 通道：DSH 侧插件那一叠文件（见 lib/channel.mjs）----
    // 每次读都签一次到：插件据此判断「面板有人在看，值得等」。
    if (path === "/api/channel") {
      (async () => {
        try {
          const root = channelRoot();
          beat(root);
          if (!dshCache || Date.now() - dshCache.at > 10_000) dshCache = { at: Date.now(), value: dshStatus(process.env, root) };
          send(200, "application/json; charset=utf-8", JSON.stringify({
            at: Date.now(),
            channel: channelStatus(root),
            asks: pendingAsks(root),
            sessions: liveSessions(root),
            activity: activity(root, 30),
            dsh: dshCache.value,
          }));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    if (path === "/api/asks/answer") {
      (async () => {
        const body = await readBody(req);
        if (body.error) {
          send(body.code, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const out = answerAsk(String(body.value?.id ?? ""), body.value?.value, channelRoot());
          send(out.ok ? 200 : 400, "application/json; charset=utf-8", JSON.stringify(out));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    if (path === "/api/prompt") {
      if (req.method === "GET" || req.method === "HEAD") {
        send(200, "application/json; charset=utf-8", JSON.stringify(promptResult(String(query.get("session") ?? ""), String(query.get("id") ?? ""), channelRoot())));
        return;
      }
      (async () => {
        const body = await readBody(req);
        if (body.error) {
          send(body.code, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const out = promptSession(String(body.value?.session ?? ""), body.value?.text, {}, channelRoot());
          send(out.ok ? 200 : 400, "application/json; charset=utf-8", JSON.stringify(out));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    // 装/卸 DSH 侧插件：唯一往外写文件的路由，所以只认一个动作名。
    if (path === "/api/channel/install") {
      (async () => {
        const body = await readBody(req);
        if (body.error) {
          send(body.code, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const root = channelRoot();
          const action = String(body.value?.action ?? "");
          const out =
            action === "install"
              ? installDsh(root, process.env)
              : action === "uninstall"
                ? uninstallDsh(process.env)
                : { ok: false, error: "只支持 install / uninstall。" };
          dshCache = null;
          send(out.ok ? 200 : 400, "application/json; charset=utf-8", JSON.stringify(out));
        } catch (error) {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }
    send(404, "text/plain; charset=utf-8", "not found");
  });

  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
      if (engine) refreshSessions().catch(() => {}); // 预热：失败不拦服务
      resolve(server.address().port);
    });
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
    get port() {
      return server.listening ? server.address().port : port;
    },
  };
}

// 插件 host 部分用的启动器：读 package.json 的 service 规格 + 用户 option。
// 端口被占不算插件装载失败（页面会显示连不上），只把错误留给日志。
const started = [];
export async function startPageService(options, engine) {
  const port = pageServicePort(options);
  if (port == null) return null;
  const service = createPageService({ port, engine });
  try {
    await service.start();
  } catch (error) {
    return { port, error: String(error?.message ?? error) };
  }
  started.push(service);
  return service;
}
export async function stopPageServices() {
  await Promise.all(started.splice(0).map((s) => s.stop()));
}
