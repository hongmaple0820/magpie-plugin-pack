// 鹊楼面板 UI。数据全部来自本服务（/api/*），不走 magpie /api：
// 插件页面 CSP 是 connect-src 'none'，页面自身 fetch 不了任何东西，所以
// page/index.html 的 loader 把窗口导航到本服务，由这里画。
//
// 两种上下文：
//   - 页面（侧栏「鹊楼」）：frame 填满视图，不需要报高度；
//   - 面板（magpie 的 Agents / Usage 页内嵌）：frame 初始 48px，由本页
//     主动 postMessage 高度撑开。magpie 的 pluginpages.js 只校验
//     ev.source === frame.contentWindow，不校验 origin，所以服务页自己
//     报高度是被接受的（上限 PANEL_MAX = 2400）。
//
// 无框架、无依赖：el() 工厂 + 分区渲染。每个分区先算内容 key，未变则跳过
// DOM 重建 —— 30 秒轮询不会闪。所有文本走 textContent，无 innerHTML 拼接。

"use strict";
import { pendingReplies, quotaAlerts, TERMINAL, STATE_TEXT } from "./notify.mjs";

// ── 客户端身份（品牌色 + 字标），照 agent-hud-open 的 AgentPalette 取色 ──
const CLIENTS = {
  claude: { name: "Claude Code", short: "Claude", color: "#d97757", mark: "C" },
  codex: { name: "Codex", short: "Codex", color: "#10a37f", mark: "◎" },
  dsh: { name: "DeepSeek Harness", short: "DSH", color: "#4d6bfe", mark: "D" },
  deepseek: { name: "DeepSeek Harness", short: "DSH", color: "#4d6bfe", mark: "D" },
  antigravity: { name: "Antigravity", short: "Anti-g", color: "#a78bfa", mark: "A" },
  gemini: { name: "Gemini CLI", short: "Gemini", color: "#4285f4", mark: "G" },
  cursor: { name: "Cursor", short: "Cursor", color: "#7c3aed", mark: "Cu" },
  opencode: { name: "OpenCode", short: "OpenCode", color: "#f59e0b", mark: "O" },
  copilot: { name: "Copilot", short: "Copilot", color: "#238636", mark: "Co" },
  human: { name: "你", short: "你", color: "#8e8e93", mark: "你" },
  magpie: { name: "magpie", short: "magpie", color: "#8e8e93", mark: "M" },
};
const client = (id) => CLIENTS[id] ?? { name: id || "unknown", color: "#8e8e93", mark: "?" };

// 状态来源徽标（v7 §5 P1 三档）。事件源（events / tap）本身就是证据，行上不另标——
// 50 行同款「证据」只是噪声；registry 和 mtime 必须自报档位，别让「未知」看起来像「空闲」。
function srcBadge(s) {
  const kind = s.source?.kind ?? "none";
  if (kind === "events" || kind === "tap") return null;
  const mins = s.recent?.lastWriteMs ? Math.max(0, Math.round((Date.now() - s.recent.lastWriteMs) / 60000)) : null;
  const def =
    kind === "registry"
      ? s.presence === "online"
        ? { cls: "src live", text: "在线", title: "有插件签到（20 秒内）：证明进程活着，证不了是在跑还是在等人" }
        : { cls: "src", text: "签到过期", title: "插件签过到，但已经超过 20 秒没再写：进程可能已经退了" }
      : kind === "mtime"
        ? {
            cls: "src",
            text: "近似",
            title: "只有文件写入时间：能证明最近写过，证明不了是否在跑" + (mins == null ? "" : "；" + mins + " 分钟前有写入"),
          }
        : { cls: "src", text: "无来源", title: "没有任何状态证据，这一行的状态是空的" };
  const n = el("span", def.cls, def.text);
  n.title = def.title;
  return n;
}

// ── 小工具 ───────────────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) + "%" : "—");

// 等级：照参考产品的 70 / 90 分界
function level(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "off";
  if (v >= 90) return "bad";
  if (v >= 70) return "warn";
  return "ok";
}
const LEVEL_COLOR = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", off: "var(--muted)" };

// 相对时间：刚刚 / N 分钟 / N 小时 / N 天
function ago(ms) {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return Math.round(d / 60_000) + " 分钟前";
  if (d < 86_400_000) return Math.round(d / 3_600_000) + " 小时前";
  return Math.round(d / 86_400_000) + " 天前";
}
// 重置时间：还剩多久
function until(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = t - Date.now();
  if (d <= 0) return "已重置";
  const h = d / 3_600_000;
  if (h < 1) return Math.max(1, Math.round(d / 60_000)) + " 分钟后重置";
  if (h < 48) return h.toFixed(h < 10 ? 1 : 0) + " 小时后重置";
  return Math.round(h / 24) + " 天后重置";
}

// ── 数据 ─────────────────────────────────────
// 桌面桥把页面放在 wails 资源源上，此时 /api 是跨源的，必须用桥传进来的 base；
// 在插件自己的服务里则用相对路径。
const API_BASE = (() => {
  try { return new URLSearchParams(location.search).get("base") || ""; } catch { return ""; }
})();

async function getJSON(path, init) {
  const res = await fetch(API_BASE + path, init);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}
const loadState = () => getJSON("/api/state");
const loadQuotas = () => getJSON("/api/quotas");
const loadHistory = () => getJSON("/api/history").catch(() => null);
const loadQuotaHistory = () => getJSON("/api/quota-history?hours=168").catch(() => null);
const loadAgents = () => getJSON("/api/agents").catch(() => null);

let tokenPeriod = "24h";
const loadTokens = () => getJSON("/api/tokens?period=" + tokenPeriod).catch(() => null);

// 数目缩写：1.2M / 24.5K
function short(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

// ── 面板高度自报（只在被嵌入时）──────────────
// 诊断标记：wails 运行时是否注入、拖拽是否就绪。挂成 <html> 的 class，
// 出问题时一眼能看出来（也能被自动化验证读到）。
function probeWails(tag, extra) {
  const w = window._wails;
  const cls = !w ? "no-runtime" : w.flags?.nonClientRegionTracking ? "drag-ready" : "drag-off";
  document.documentElement.classList.remove("no-runtime", "drag-ready", "drag-off");
  document.documentElement.classList.add(cls);
  // 上报给服务，这样在宿主侧也能确认「真实 HUD 窗口里拖拽是否就绪」
  try {
    fetch(API_BASE + "/api/display", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: {
        tag,
        extra: extra ?? null,
        drag: cls,
        url: location.href,
        origin: location.origin,
        os: w?.environment?.OS ?? null,
        hasWails: !!w,
        hasWebview: !!window.chrome?.webview,
        hasRuntimeGlobal: typeof window.runtime !== "undefined",
        // wails 注入的是 runtime.Core；若它跑了，这些键会出现
        wailsKeys: w ? Object.keys(w).slice(0, 8) : null,
        csp: (document.querySelector('meta[name="csp"]')?.content) ?? null,
      } }),
    }).catch(() => {});
  } catch { /* 上报失败不影响渲染 */ }
}

probeWails("early");
// wails 在导航完成后才注入运行时，所以 load 后再探一次才准
addEventListener("load", () => setTimeout(() => probeWails("after-load"), 1500));

const embedded = (() => {
  try { return window.parent !== window; } catch { return true; }
})();
if (embedded) document.documentElement.classList.add("embedded");
function reportHeight() {
  if (!embedded) return;
  let told = -1;
  const send = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h === told) return;
    told = h;
    try { window.parent.postMessage({ magpie: 1, method: "size", params: { height: h } }, "*"); } catch { /* 无父窗口 */ }
  };
  new ResizeObserver(send).observe(document.documentElement);
  send();
}

// ── 额度环（照 usage-meter/arcs.ts：1 个整环，2-4 个同心环）──
// 引擎给的是 percent（不是 usedPercent）——只认一个字段的话环永远是空的「—%」
const percentOf = (w) => {
  const v = w?.percent ?? w?.usedPercent;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

function quotaRing(windows, size = 68) {
  const svg = svgEl("svg", { class: "ring", width: size, height: size, viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" });
  const list = windows.map((w) => ({ ...w, percent: percentOf(w) })).filter((w) => w.percent != null).slice(0, 4);
  const center = size / 2;
  const band = size / 2 - 6;
  const width = list.length <= 1 ? 6 : Math.min(5, band / (list.length + (list.length - 1) * 0.5));
  list.forEach((w, i) => {
    const radius = list.length <= 1 ? center - width / 2 - 4 : center - width / 2 - 4 - i * width * 1.6;
    if (radius <= 0) return;
    const circ = 2 * Math.PI * radius;
    const frac = clamp(w.percent, 0, 100) / 100;
    svg.append(svgEl("circle", { cx: center, cy: center, r: radius, fill: "none", stroke: "var(--line)", "stroke-width": width }));
    if (frac > 0.003) {
      const arc = svgEl("circle", {
        cx: center, cy: center, r: radius, fill: "none",
        stroke: LEVEL_COLOR[level(w.percent)], "stroke-width": width, "stroke-linecap": "round",
        "stroke-dasharray": `${circ * frac} ${circ}`,
        transform: `rotate(-90 ${center} ${center})`,
      });
      svg.append(arc);
    }
  });
  // 中心：最满窗口的数字
  const most = list.reduce((a, b) => (!a || b.percent > a.percent ? b : a), null);
  const val = svgEl("text", { x: center, y: center + 1, "text-anchor": "middle", "dominant-baseline": "middle", class: "val" });
  // 「%」曾经是另一个 <text> 放在 center+12 上：字号一大就跟数字压在一起。
  // 现在挂在同一个 text 里的 tspan，位置由基线决定，不会撞。
  val.textContent = most ? String(Math.round(most.percent)) : "—";
  if (most) {
    const unit = svgEl("tspan", { class: "lbl" });
    unit.textContent = "%";
    val.append(unit);
  }
  svg.append(val);
  return svg;
}

// ── sparkline（24h 走势；点 <2 不画）─────────
function sparkline(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const W = 260, Hh = 30, PAD = 3;
  const svg = svgEl("svg", { class: "spark", viewBox: `0 0 ${W} ${Hh}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  const xs = points.map((_, i) => PAD + (i / (points.length - 1)) * (W - 2 * PAD));
  const ys = points.map((p) => Hh - PAD - (clamp(p.v, 0, 100) / 100) * (Hh - 2 * PAD));
  const d = xs.map((x, i) => (i ? "L" : "M") + x.toFixed(1) + " " + ys[i].toFixed(1)).join(" ");
  svg.append(svgEl("path", { class: "fill", d: `${d} L${xs[xs.length - 1].toFixed(1)} ${Hh - PAD} L${xs[0].toFixed(1)} ${Hh - PAD} Z` }));
  svg.append(svgEl("path", { class: "line", d }));
  return svg;
}

// ── 分区渲染（带内容 key，未变跳过）──────────
const drawn = {};

// 按 provider 的用量（账簿里每条请求都带真实 provider）
function renderByProvider(tokens) {
  const host = document.getElementById("by-provider");
  if (!host) return;
  const rows = Object.entries(tokens?.byProvider ?? {})
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.total - a.total);
  const sig = JSON.stringify(rows.map((r) => [r.provider, Math.round(r.total), Math.round(r.cost)]));
  if (drawn.byProvider === sig) return;
  drawn.byProvider = sig;

  host.replaceChildren();
  if (!rows.length) {
    host.append(el("div", "empty-state", "还没有经 magpie 的请求记录。"));
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.total));
  for (const r of rows) {
    const row = el("div", "prow");
    const name = el("span", "pn", r.provider);
    const bar = el("div", "pbar");
    const fill = el("i");
    fill.style.width = Math.round((r.total / max) * 100) + "%";
    bar.append(fill);
    const val = el("span", "pv", short(r.total) + (r.cost ? " · $" + r.cost.toFixed(2) : ""));
    const cnt = el("span", "pc", typeof r.requests === "number" ? r.requests + " 次" : "");
    row.append(name, bar, val, cnt);
    host.append(row);
  }
}

function renderQuotas(quotas, history, quotaHistory) {
  const host = document.getElementById("quota-cards");
  const hint = document.getElementById("quota-hint");
  // 默认只显示「真的在用」的 provider：账簿里出现过、或有会话的客户端。
  // magpie 采集了 15 个 provider，用户可能只登录其中两个——其余是噪音。
  const usedProviders = new Set([
    ...Object.keys(window.__byProvider ?? {}),
    ...(window.__sessions ?? []).map((x) => x.client),
  ]);
  const allProviders = quotas?.providers ?? [];
  const accounts = hudSettings?.showAllProviders || usedProviders.size === 0
    ? allProviders
    : allProviders.filter((a) => usedProviders.has(a.provider));
  // 走势索引：账号键（provider|user）+ 窗口名 → 该窗口的剩余量曲线
  const histIndex = new Map();
  for (const s of quotaHistory?.series ?? []) histIndex.set(s.account + "\u0000" + s.window, s);
  const totals = quotas?.providerTotals ?? null;
  if (!accounts.length) {
    // 没有 magpie 采集的数据：退回自家 CLI 读取的两家（若可用）
    return renderOwnQuotas(quotas, history);
  }

  const key = JSON.stringify(accounts.map((a) => [a.provider, a.user, a.windows.length, Math.max(-1, ...a.windows.map((w) => w.percent ?? -1))]));
  if (drawn.quotas === key) return;
  drawn.quotas = key;

  host.replaceChildren();
  // 可算进度的窗口里最吃紧的那个，用来给 hint 一句摘要
  const pcts = accounts.flatMap((a) => a.windows.map((w) => w.percent).filter((v) => v != null));
  const worst = pcts.length ? Math.max(...pcts) : null;
  // 计数可能缺（老引擎/刚启动）：缺了就少印一节，别印 undefined
  const counts = [totals?.providers, totals?.accounts, totals?.windows].filter((v) => typeof v === "number");
  hint.textContent = counts.length
    ? `${counts[0]} 个 provider` + (counts.length > 1 ? ` · ${counts[1]} 个账号 · ${counts[2]} 个窗口` : "") + (worst != null ? ` · 最高 ${Math.round(worst)}%` : "")
    : "";

  // 按 provider 分组：21 个账号平铺太吵，用户先看「哪一家」，需要时再展开到账号
  const groups = new Map();
  for (const a of accounts) {
    const list = groups.get(a.provider) ?? (groups.set(a.provider, []), groups.get(a.provider));
    list.push(a);
  }

  for (const [providerId, list] of groups) {
    const meta = client(providerId);
    // 这一家最吃紧的窗口（跨账号），环画它
    const measured = list.flatMap((a) => a.windows.filter((w) => w.percent != null));
    const worst = measured.reduce((x, y) => (y.percent > (x?.percent ?? -1) ? y : x), null);
    const card = el("div", "card");
    const top = el("div", "card-top");
    if (worst) top.append(quotaRing([worst], 62));
    else {
      const dot = el("div", "mark big", meta.mark);
      dot.style.background = meta.color;
      top.append(dot);
    }
    const id = el("div", "card-id");
    id.append(el("h3", "", list[0].name || providerId));
    const bits = [];
    if (list[0].plan) bits.push(list[0].plan);
    if (list.length > 1) bits.push(list.length + " 个账号");
    const lastRead = list.map((a) => a.readAt).filter(Boolean).sort().pop();
    // 仲裁可能用了比台账更新的一次读数（CLI 直连）：那就报那个时刻，
    // 别让「读于 10 分钟前」跟旁边刚取的数打架。
    const arbAt = Math.max(0, ...list.flatMap((a) => a.windows.map((w) => w.arb?.observedAt ?? 0)));
    const readAt = Math.max(lastRead ? Date.parse(lastRead) : 0, arbAt);
    if (readAt) bits.push("读于 " + ago(readAt));
    if (bits.length) id.append(el("div", "sub", bits.join(" · ")));
    top.append(id);
    card.append(top);

    // 每账号一段：账号名 + 它最吃紧/全部窗口
    for (const a of list) {
      if (list.length > 1 && a.user) card.append(el("div", "acc", a.user));
      // 结构不符 ≠ 没有额度：账上有这个账号，只是这里的字段读不认。
      if (a.drift) {
        card.append(el("p", "sub", `这个账号的额度这次读不出来（${a.drift}），先不显示——不代表没有额度。`));
        continue;
      }
      const wins = el("ul", "wins");
      for (const w of a.windows) {
        const li = el("li", "win");
        li.append(el("span", "nm", w.name));
        if (w.percent != null) {
          li.append(el("span", "pct", pct(w.percent)));
          li.append(el("span", "rt" + (w.runsOut ? " warn" : ""), w.runsOut || (w.resetsAt ? until(w.resetsAt) : "")));
          if (w.limit != null && w.amount != null) {
            const bar = el("div", "bar");
            const fill = el("i");
            fill.style.width = clamp(w.percent, 0, 100) + "%";
            fill.style.background = LEVEL_COLOR[level(w.percent)];
            bar.append(fill);
            li.append(bar);
          }
        } else {
          li.append(el("span", "pct", w.left != null ? `剩 ${w.left}${w.unit ?? ""}` : (w.display || "—")));
          li.append(el("span", "rt", w.resetsAt ? until(w.resetsAt) : ""));
        }
        // 仲裁层把多个来源合成了一个窗口：把「几条来源在说同一件事」露出来。
        // 只在有交叉来源或读不出百分比时出现，平时一行不占。
        if (w.arb && (w.arb.cross > 0 || w.arb.quality === "unknown")) {
          const tag = el("span", "rt tag-arb", w.arb.cross > 0 ? `${w.arb.cross + 1} 源${w.arb.mismatch ? " · 不一致" : ""}` : "读不出百分比");
          tag.title = `取 ${w.arb.source} 的读数（${w.arb.quality}）`;
          li.append(tag);
        }
        const hist = histIndex.get((a.provider + "|" + (a.user ?? "")) + "\u0000" + w.name);
        if (hist && hist.points.length >= 2) {
          const spark = sparkline(hist.points.map((pt) => ({ at: pt.at, v: pt.left })));
          if (spark) { spark.classList.add("mini"); li.append(spark); }
          if (hist.dropPerHour != null && hist.dropPerHour > 0) li.append(el("span", "rt burn", `▼${hist.dropPerHour.toFixed(2)}/h`));
        }
        wins.append(li);
      }
      if (wins.childElementCount) card.append(wins);
    }
    host.append(card);
  }
}

// 自家 CLI 读取的两家（claude / codex）：magpie 采集的数据里没有时兜底。
function renderOwnQuotas(quotas, history) {
  const host = document.getElementById("quota-cards");
  const hint = document.getElementById("quota-hint");
  const clients = quotas?.clients ?? [];
  const series = history?.series ?? [];
  host.replaceChildren();
  const notes = [];
  let okCards = 0;
  for (const c of clients) {
    const meta = client(c.client);
    if (c?.status === "ok" && Array.isArray(c.quotas) && c.quotas.length) {
      okCards++;
      const card = el("div", "card");
      const top = el("div", "card-top");
      top.append(quotaRing(c.quotas));
      const id = el("div", "card-id");
      id.append(el("h3", "", meta.name));
      const account = [c.account?.label, c.account?.plan].filter(Boolean).join(" · ") || "已登录";
      id.append(el("div", "sub", account));
      top.append(id);
      card.append(top);

      const wins = el("ul", "wins");
      for (const q of c.quotas) {
        const lv = level(q.usedPercent);
        const li = el("li", "win");
        li.append(el("span", "nm", q.name || q.id), el("span", "pct", pct(q.usedPercent)), el("span", "rt", until(q.resetAt)));
        const bar = el("div", "bar");
        const fill = el("i");
        fill.style.width = clamp(q.usedPercent, 0, 100) + "%";
        fill.style.background = LEVEL_COLOR[lv];
        bar.append(fill);
        li.append(bar);
        wins.append(li);
      }
      card.append(wins);

      const row = series.find((s) => s.client === c.client);
      if (row) {
        const spark = sparkline(row.points);
        if (spark) card.append(spark);
        if (row.burn) {
          const hours = row.burn.fullInMs ? row.burn.fullInMs / 3_600_000 : 0;
          const text = hours
            ? `烧录 ${row.burn.percentPerHour.toFixed(1)}%/h · ${hours < 1 ? Math.max(1, Math.round(row.burn.fullInMs / 60_000)) + " 分钟后满" : hours.toFixed(1) + "h 后满"}`
            : `烧录 ${row.burn.percentPerHour.toFixed(1)}%/h`;
          card.append(el("p", "burn " + (hours && hours < 2 ? "over" : hours && hours < 6 ? "hot" : ""), text));
        }
      }
      host.append(card);
      continue;
    }
    notes.push(c);
  }
  if (!okCards) {
    hint.textContent = "";
    const empty = el("div", "empty-state");
    empty.append(el("b", "", "还没有可读的额度。"));
    const why = notes.map((c) => {
      const n = client(c.client).name;
      if (c?.status === "no_plan_limits") return n + "：未使用套餐";
      if (c?.status === "signed_out") return n + "：未登录";
      if (c?.status === "failed") return n + "：" + (c.notice || "读取失败");
      return n + "：状态未知";
    });
    empty.append(el("div", "", why.join(" · ") || "装好并登录 magpie 的 provider 后，这里会显示各家的额度。"));
    host.append(empty);
    return;
  }
  hint.textContent = okCards + " 个已登录 · 60s 缓存";
}
// 设置里选了只看某几个客户端时，会话/统计都按它过滤（空 = 全部）。
function agentsOf() {
  return Array.isArray(hudSettings?.agents) ? hudSettings.agents : [];
}
function installedAgents() {
  const list = window.__agents ?? [];
  // 检测不到任何 agent 时不过滤，宁多勿空
  return list.length ? new Set(list.filter((a) => a.installed).map((a) => a.id)) : null;
}

function filterByAgent(rows) {
  const want = agentsOf();
  let out = want.length ? rows.filter((r) => want.includes(r.client)) : rows;
  // 只保留本机确实装了的 agent（用户抱怨过没安装的也显示）
  const installed = installedAgents();
  if (installed) out = out.filter((r) => installed.has(r.client === "deepseek" ? "dsh" : r.client));
  // 「只看活跃」：在跑、等你、或最近 2 小时有动静。默认关——
  // 但用户抱怨「没在工作的 agent 也显示」时，这一个开关就解决。
  if (hudSettings?.onlyActive) {
    const cutoff = Date.now() - 2 * 3600_000;
    out = out.filter((r) => r.pending || r.state === "running" || (r.mtimeMs ?? 0) >= cutoff);
  }
  return out;
}

const PAGE_SIZE = 20;
let sessionQuery = "";
let sessionPage = 0;

// 搜索框（只在完整面板显示；HUD 不显示）
function renderSessionSearch() {
  const box = document.getElementById("session-search");
  if (!box) return;
  box.replaceChildren();
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "搜索标题 / 项目 / 客户端…";
  input.value = sessionQuery;
  input.setAttribute("aria-label", "搜索会话");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sessionQuery = input.value;
      sessionPage = 0;
      drawn.sessions = undefined;
      renderSessions(window.__sessions ?? []);
    }, 150);
  });
  box.append(input);
}


// 四块瓦片：一眼看完全局。点它滚到对应分区。
function renderTiles(state, tokens, quotas, sessions) {
  const host = document.getElementById("tiles");
  if (!host) return;
  const visible = filterByAgent(sessions ?? []);
  const running = visible.filter((s) => s.state === "running").length;
  const waiting = visible.filter((s) => s.pending).length;

  // 最紧的额度窗口
  let worst = null;
  for (const a of quotas?.providers ?? []) {
    for (const w of a.windows ?? []) {
      const p = typeof w.percent === "number" ? w.percent : null;
      if (p === null) continue;
      if (!worst || p > worst.percent) worst = { percent: p, provider: a.provider, window: w.name };
    }
  }
  const level = (p) => (p >= 90 ? "bad" : p >= 70 ? "warn" : "ok");
  const cost = tokens?.cost?.usd;

  const tiles = [
    {
      k: "最紧额度",
      v: worst ? Math.round(worst.percent) + "%" : "—",
      s: worst ? worst.provider + " · " + (worst.window ?? "") : "没有额度数据",
      cls: worst ? level(worst.percent) : "plain",
      go: "quotas",
    },
    {
      k: "24h 花费",
      v: typeof cost === "number" ? "$" + cost.toFixed(2) : "—",
      s: typeof cost === "number" ? "来自账簿" : "没有用量数据",
      cls: "plain",
      go: "tokens",
    },
    {
      k: "在跑",
      v: String(running),
      s: visible.length + " 个会话",
      cls: running ? "ok" : "plain",
      go: "sessions",
    },
    {
      k: "等你",
      v: String(waiting),
      s: waiting ? "点开去处理" : "没有待办",
      cls: waiting ? "warn" : "plain",
      go: "sessions",
    },
  ];

  host.replaceChildren();
  for (const t of tiles) {
    const b = el("button", "tile " + t.cls);
    b.type = "button";
    b.setAttribute("role", "listitem");
    b.append(el("div", "k", t.k), el("div", "v", t.v), el("div", "s", t.s));
    b.addEventListener("click", () => {
      const sec = document.querySelector('[data-sec="' + t.go + '"]');
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    host.append(b);
  }
}

function renderSessions(sessions) {
  const host = document.getElementById("session-list");
  const hint = document.getElementById("session-hint");
  const rank = (s) => (s.pending ? 0 : s.state === "running" ? 1 : 2);
  let rows = filterByAgent(Array.isArray(sessions) ? sessions : []).slice().sort((a, b) => rank(a) - rank(b));

  // 搜索：title / project / client 的大小写无关子串，输入 150ms 防抖
  const q = sessionQuery.trim().toLowerCase();
  if (q) {
    rows = rows.filter((s) =>
      String(s.title ?? "").toLowerCase().includes(q) ||
      String(s.project ?? "").toLowerCase().includes(q) ||
      String(s.client ?? "").toLowerCase().includes(q));
  }
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (sessionPage >= pages) sessionPage = pages - 1;
  const pageRows = rows.slice(sessionPage * PAGE_SIZE, sessionPage * PAGE_SIZE + PAGE_SIZE);

  const key = JSON.stringify([q, sessionPage, pageRows.map((s) => [s.id, s.state, s.pending?.kind ?? null, s.title])]);
  if (drawn.sessions === key) return;
  drawn.sessions = key;
  window.__sessionRows = pageRows;

  host.replaceChildren();
  const busy = rows.filter((s) => s.state === "running").length;
  hint.textContent = (q ? `${total} 个匹配` : `${total} 个`) + ` · ${busy} 个在跑` + (pages > 1 ? ` · 第 ${sessionPage + 1}/${pages} 页` : "");

  if (!total) {
    const empty = el("div", "empty-state");
    empty.append(el("b", "", "没找到本地会话。"), el("div", "", "鹊楼读 Claude Code（~/.claude/projects）、Codex（~/.codex/sessions）、DeepSeek Harness（~/.dsh/sessions）与 Antigravity 的转录；开一个会话后这里就会出现。"));
    host.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const s of pageRows) {
    const meta = client(s.client);
    const row = el("div", "row");
    row.dataset.id = s.id;
    const mark = el("div", "mark", meta.mark);
    mark.style.background = meta.color;
    const who = el("div", "who");
    who.append(el("div", "t", s.title || s.id));
    const bits = [meta.name];
    if (s.folder || s.project) bits.push(s.folder || s.project);
    who.append(el("div", "s", bits.join(" · ")));
    const end = el("div", "end");
    // 等待用户介入的会话排在最显眼的位置：这是唯一需要你动手的状态
    if (s.pending) {
      // kind 是语义类别（approval/question），toolName 才是「等你什么」。
      const what = String(s.pending.toolName || s.pending.kind).replace(/_/g, " ");
      end.append(el("span", "pill warn", "等你 " + what.slice(0, 14)));
    } else {
      // unknown 是第三种状态：读不动就说不知道，不能伪装成空闲。
      const lv = s.state === "running" ? "live" : s.state === "unknown" ? "warn" : s.reachable ? "ok" : "";
      const label = s.state === "running" ? "在跑" : s.state === "unknown" ? "未知" : s.reachable ? "空闲" : "闲置";
      const pill = el("span", "pill " + lv, label);
      // 「未知」要说清凭什么：mtime 源的会话只有写入时间可看，说不出「还在跑」。
      if (s.state === "unknown" && s.source?.kind === "mtime") {
        const mins = s.recent?.lastWriteMs ? Math.max(0, Math.round((Date.now() - s.recent.lastWriteMs) / 60000)) : null;
        pill.title = "只有文件写入时间可看，无法判断是否在跑" + (mins == null ? "" : "；" + mins + " 分钟前有写入");
      }
      end.append(pill);
      const badge = srcBadge(s);
      if (badge) end.append(badge);
    }
    row.dataset.session = s.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (s.client === "claude" || s.client === "codex") {
      const btn = el("button", "act", "发消息");
      btn.type = "button";
      btn.dataset.action = "send";
      btn.dataset.id = s.id;
      end.append(btn);
    }
    row.append(mark, who, end);
    frag.append(row);
  }
  host.append(frag);

  // 分页条（只有一页时不显示）
  const pager = document.getElementById("session-pager");
  pager.replaceChildren();
  if (pages > 1) {
    const mk = (label, delta, disabled) => {
      const b = el("button", "act", label);
      b.type = "button";
      b.disabled = disabled;
      b.addEventListener("click", () => { sessionPage += delta; drawn.sessions = undefined; renderSessions(window.__sessions ?? []); });
      return b;
    };
    pager.append(mk("‹ 上一页", -1, sessionPage === 0));
    pager.append(el("span", "pinfo", `${sessionPage + 1} / ${pages}`));
    pager.append(mk("下一页 ›", 1, sessionPage >= pages - 1));
  }
}

function renderJournal(messages) {
  const host = document.getElementById("journal-list");
  const hint = document.getElementById("journal-hint");
  const rows = Array.isArray(messages) ? messages : [];
  const key = JSON.stringify(rows.slice(0, 30).map((m) => [m.id, m.state, m.sentAtMs]));
  if (drawn.journal === key) return;
  drawn.journal = key;

  host.replaceChildren();
  hint.textContent = rows.length ? `${rows.length} 条` : "";
  if (!rows.length) {
    host.append(el("div", "empty-state", "还没有消息。会话之间或你从面板发出的消息都会记在这里（只存指纹，不存正文）。"));
    return;
  }
  const STATE = { done: ["ok", "已回答"], replied: ["ok", "已回复"], refused: ["bad", "被拒"], expired: ["bad", "过期"], queued: ["", "排队中"], taken: ["live", "已取"], started: ["live", "处理中"] };
  const frag = document.createDocumentFragment();
  for (const m of rows.slice(0, 30)) {
    const from = client(m.from?.client);
    const to = client(m.to?.client);
    const row = el("div", "row");
    const mark = el("div", "mark", from.mark);
    mark.style.background = from.color;
    const who = el("div", "who");
    const title = `${m.from?.title || from.name} → ${m.to?.title || to.name}`;
    who.append(el("div", "t", title));
    const bits = [ago(m.sentAtMs)];
    if (m.fingerprint) bits.push("指纹 " + String(m.fingerprint).slice(0, 8));
    who.append(el("div", "s", bits.join(" · ")));
    const end = el("div", "end");
    const [lv, label] = STATE[m.state] ?? ["", m.state || "未知"];
    end.append(el("span", "pill " + lv, label));
    row.append(mark, who, end);
    frag.append(row);
  }
  host.append(frag);
}

function renderTokens(tokens) {
  const host = document.getElementById("token-chart");
  const hint = document.getElementById("token-hint");
  if (!tokens) { hint.textContent = ""; return; }
  if (tokens.requires) {
    host.replaceChildren(el("div", "empty-state", "引擎不可用。"));
    return;
  }
  // buckets 在扫描刚开始时可以缺失：用空数组兜住，别让「用量」整块挂掉
  const buckets = tokens.buckets ?? [];
  // totals 在「还没扫完」时可以缺失：缺了就显示 0，不要让整块用量挂掉
  const totals = tokens.totals ?? {};
  const sig = JSON.stringify([buckets.map((b) => b.in + b.out), tokens.scanning, tokens.parsed, tokens.cost?.usd ?? null]);
  if (drawn.tokens === sig) return;
  drawn.tokens = sig;

  host.replaceChildren();
  const bars = buckets;
  const peak = Math.max(1, ...bars.map((b) => b.in + b.out));
  const wrap = el("div");
  const chart = el("div", "bars");
  for (const b of bars) {
    const col = el("div", "col");
    const hIn = (b.in / peak) * 100;
    const hOut = (b.out / peak) * 100;
    if (hIn > 0) { const i = el("i", "in"); i.style.height = hIn + "%"; col.append(i); }
    if (hOut > 0) { const i = el("i", "out"); i.style.height = hOut + "%"; col.append(i); }
    col.title = new Date(b.at).toLocaleString() + " · 输入 " + short(b.in) + " · 输出 " + short(b.out);
    chart.append(col);
  }
  wrap.append(chart);

  // from/to 是引擎给的窗口边界；缺失（老引擎或刚启动）时干脆不画轴，别显示 Invalid Date
  const stamp = (v) => {
    const d = new Date(v ?? NaN);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit" });
  };
  const from = stamp(tokens.from);
  const to = stamp(tokens.to);
  if (from || to) {
    const axis = el("div", "axis");
    axis.append(el("span", "", from), el("span", "", to));
    wrap.append(axis);
  }

  const sum = el("div", "sum");
  const add = (k, v) => { const s = el("span"); s.append(el("span", "k", k + " "), el("b", "", v)); sum.append(s); };
  add("输入", short(totals.in ?? 0));
  add("输出", short(totals.out ?? 0));
  add("缓存读", short(totals.cacheRead ?? 0));
  // 成本：只有账簿来源才有（转录里没有 provider/model，算不了）
  if (tokens.cost && typeof tokens.cost.usd === "number") add("花费", "$" + tokens.cost.usd.toFixed(2));
  const names = { claude: "Claude", codex: "Codex", dsh: "DSH", antigravity: "Antigravity", unknown: "未知" };
  for (const [c, v] of Object.entries(tokens.byClient ?? {})) add(names[c] ?? c, short(v.in + v.out));
  wrap.append(sum);

  // 按模型的明细（有价时带金额）
  const models = (tokens.byModel ?? []).filter((m) => m.in + m.out > 0).slice(0, 5);
  if (models.length) {
    const mt = el("div", "models");
    for (const m of models) {
      const line = el("div", "mrow");
      line.append(el("span", "mn", m.model === "unknown" ? "未知模型" : m.model));
      line.append(el("span", "mv", short(m.in + m.out) + (m.cost ? " · $" + m.cost.toFixed(2) : "")));
      mt.append(line);
    }
    wrap.append(mt);
  }

  const legend = el("div", "legend");
  legend.append(el("span", "lin", "输入"), el("span", "lout", "输出"));
  wrap.append(legend);
  host.append(wrap);

  const bits = [];
  if (tokens.source === "ledger") bits.push(`${tokens.total} 次请求 · magpie 账簿`);
  else if (tokens.scanning) bits.push(`扫描中 ${tokens.parsed}/${tokens.total}`);
  else if (tokens.total) bits.push(`${tokens.total} 个转录`);
  if (tokens.skipped) bits.push(`跳过 ${tokens.skipped} 个大文件`);
  if (tokens.cost?.unpriced) bits.push(`${tokens.cost.unpriced} 次未定价`);
  // 金额是按「事件时刻生效」的价格快照折算的：早于第一档快照的请求只能用近似价，
  // 面板得说出来，否则用户会以为这个数是上游账单。
  const q = tokens.cost?.quality;
  if (q?.approximate) bits.push(`${q.approximate} 次按近似价（早于价格记录）`);
  if (q?.unknown) bits.push(`${q.unknown} 次没有价格`);
  hint.textContent = bits.join(" · ");
}

function showBanner(title, detail) {
  const b = document.getElementById("banner");
  b.replaceChildren();
  b.append(el("b", "", title));
  b.append(el("span", "", detail));
  b.hidden = false;
}
function hideBanner() {
  document.getElementById("banner").hidden = true;
}

// ── 回复提醒 ─────────────────────────────────
let notified = new Set();
let baseline = false;

// 额度越线告警：跨过 90% 弹一次（回落再越线会重新弹）。
let quotaPrev = {};
let quotaSeeded = false;
function checkQuotaAlerts(quotas) {
  const windows = (quotas?.providers ?? []).flatMap((a) =>
    a.windows
      .filter((w) => w.percent != null)
      .map((w) => ({ key: a.provider + "|" + (a.user ?? "") + "|" + w.name, provider: a.provider, window: w.name, percent: w.percent, user: a.user })),
  );
  // 第一次只播种：已经超线的窗口不弹卡（用户打开面板时自己看得到），
  // 之后真正「烧过去」的那一次才提醒。
  const { prev, fresh } = quotaAlerts(quotaPrev, windows, 90, { seed: !quotaSeeded });
  quotaPrev = prev;
  quotaSeeded = true;
  for (const w of fresh) {
    toast({
      id: "quota:" + w.key,
      state: "refused",
      from: { title: w.provider + (w.user ? " · " + w.user : "") },
      to: { title: w.window },
      _quota: w,
    });
  }
}

function notifyReplies(messages) {
  const next = pendingReplies(notified, messages, baseline);
  notified = next.seen;
  baseline = next.baselineDone;
  for (const m of next.fresh) toast(m);
}

function toast(m) {
  const from = m.from?.title || client(m.from?.client).name;
  const to = m.to?.title || client(m.to?.client).name;
  const card = el("div", "toast");
  if (m._quota) {
    // 额度告警：标题说清哪家哪个窗口，正文给百分比
    card.classList.add("quota");
    card.append(el("b", "", `${from} · ${to} 已到 ${Math.round(m._quota.percent)}%`));
    card.append(el("p", "", `超过 ${m._quota.threshold}% 阈值，去额度区看看还能撑多久。`));
    const closeBtn = el("button", "", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭提醒");
    closeBtn.addEventListener("click", () => card.remove());
    card.append(closeBtn);
    document.getElementById("toasts").append(card);
    setTimeout(() => card.remove(), 20_000);
    return;
  }
  card.append(el("b", "", `${from} → ${to} · ${STATE_TEXT[m.state] || m.state}`));
  if (m.state === "done" && m.id) {
    // done 的答案现取：journal 只存指纹，答案在 /api/message
    fetch(API_BASE + "/api/message?id=" + encodeURIComponent(m.id))
      .then((r) => r.json())
      .then((msg) => {
        if (msg.answer) card.append(el("p", "", msg.answer.slice(0, 140) + (msg.answer.length > 140 ? "…" : "")));
      })
      .catch(() => {});
  }
  const close = el("button", "", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提醒");
  close.addEventListener("click", () => card.remove());
  card.append(close);
  document.getElementById("toasts").append(card);
  setTimeout(() => card.remove(), 15_000);
}

// ── 发消息 ───────────────────────────────────
const POLL_MS = 2000;
const POLL_MAX = 450;

function openSend(session) {
  const meta = client(session.client);
  const dlg = document.createElement("dialog");
  dlg.className = "send";
  dlg.append(el("h3", "", "发给 " + (session.title || session.id)));
  dlg.append(el("p", "to", meta.name + " · " + session.id));
  const box = document.createElement("textarea");
  box.rows = 4;
  box.placeholder = "要发给这个会话的话…";
  const foot = el("div", "foot");
  const send = el("button", "", "发送");
  send.type = "button";
  const close = el("button", "ghost", "关闭");
  close.type = "button";
  const st = el("span", "st", "");
  foot.append(st, send, close);
  const answer = el("pre", "answer");
  answer.hidden = true;
  dlg.append(box, foot, answer);

  let polling = null;
  const stop = () => { if (polling) { clearInterval(polling); polling = null; } };
  close.addEventListener("click", () => { stop(); dlg.close(); });
  dlg.addEventListener("close", stop);

  send.addEventListener("click", async () => {
    const text = box.value.trim();
    if (!text) { st.textContent = "没有要发的内容。"; return; }
    send.disabled = true;
    st.textContent = "发送中…";
    try {
      const out = await getJSON("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: session.id, text }),
      });
      if (out.requires) { st.textContent = "引擎不可用。"; send.disabled = false; return; }
      if (out.state === "refused") { notified.add(out.id); st.textContent = "被拒：" + (out.reason || ""); send.disabled = false; return; }
      st.textContent = "已排队 · " + out.id;
      let ticks = 0;
      polling = setInterval(async () => {
        if (++ticks > POLL_MAX) { stop(); st.textContent = "等太久了，先关掉；状态可在消息列表看。"; return; }
        try {
          const msg = await getJSON("/api/message?id=" + encodeURIComponent(out.id));
          if (TERMINAL.includes(msg.state)) notified.add(out.id);
          if (msg.state === "done") {
            stop();
            st.textContent = "已回答";
            answer.hidden = false;
            answer.textContent = msg.answer || "(空回答)";
          } else if (msg.state === "replied") {
            stop();
            st.textContent = msg.reason || "对方用消息回复了，见消息列表。";
          } else if (msg.state === "refused" || msg.state === "expired") {
            stop();
            st.textContent = "没送到：" + (msg.reason || msg.state);
          } else {
            st.textContent = "状态：" + msg.state + "…";
          }
        } catch { /* 下轮再试 */ }
      }, POLL_MS);
    } catch (error) {
      st.textContent = "发送失败：" + error.message;
      send.disabled = false;
    }
  });

  document.body.append(dlg);
  dlg.showModal();
  box.focus();
}

// ── 会话详情抽屉 ─────────────────────────────
// 点会话行看：元信息、它的 token 时序、与它的消息线程，并能直接再发一条。
const STATE_LABEL = { queued: ["", "排队中"], taken: ["live", "已取"], started: ["live", "处理中"], done: ["ok", "已回答"], replied: ["ok", "已回复"], refused: ["bad", "被拒"], expired: ["bad", "过期"] };
const STATE_TEXT2 = { done: "已回答", replied: "用消息回复了", refused: "被拒", expired: "过期没送到" };

async function openSession(id) {
  let data;
  try {
    data = await getJSON("/api/session?id=" + encodeURIComponent(id));
  } catch (error) {
    showBanner("读不到这个会话", error.message);
    return;
  }
  if (data.requires) { showBanner("引擎不可用", "会话详情需要插件引擎。"); return; }

  const s = data.session;
  const dlg = document.createElement("dialog");
  dlg.className = "detail";

  const head = el("div", "dhead");
  const mark = el("div", "mark", client(s.client).mark);
  mark.style.background = client(s.client).color;
  const ht = el("div");
  ht.append(el("h3", "", s.title || s.id));
  ht.append(el("p", "to", [client(s.client).name, s.project, s.state === "running" ? "在跑" : s.state === "unknown" ? "未知" : "空闲"].filter(Boolean).join(" · ")));
  // 每个结论都要能说清「凭什么」：规则名 + 事件 seq + 证据来自转录还是 tap。
  const ev = s.evidence;
  if (ev) {
    const bits = [];
    if (ev.rule) bits.push(ev.rule);
    if (Number.isFinite(ev.seq)) bits.push("seq " + ev.seq);
    if (ev.mode === "tap") bits.push("tap 直抄");
    else if (ev.mode === "both") bits.push("转录 + tap 一致");
    else if (ev.mode) bits.push("转录");
    if (s.pending?.since) bits.push("等了 " + ago(s.pending.since));
    ht.append(el("p", "to muted", "依据：" + bits.join(" · ")));
  }
  head.append(mark, ht);
  dlg.append(head);

  // token 时序
  const tokBox = el("div", "dtok");
  if (data.tokens?.buckets?.length) {
    const t = data.tokens.totals;
    tokBox.append(el("div", "dlabel", `近 ${data.tokens.hours}h 用量 · 输入 ${short(t.in)} · 输出 ${short(t.out)}`));
    const bars = el("div", "dbars");
    const peak = Math.max(1, ...data.tokens.buckets.map((b) => b.in + b.out));
    for (const b of data.tokens.buckets) {
      const col = el("div", "dcol");
      const i = el("i");
      i.style.height = Math.max(2, Math.round(((b.in + b.out) / peak) * 100)) + "%";
      col.append(i);
      col.title = new Date(b.at).toLocaleString() + " · 输入 " + short(b.in) + " / 输出 " + short(b.out);
      bars.append(col);
    }
    tokBox.append(bars);
  } else {
    tokBox.append(el("div", "dlabel muted", "没有这个会话的 token 记录（可能未走 magpie，或还没扫过）。"));
  }
  dlg.append(tokBox);

  // 消息线程
  const jbox = el("div", "dmsg");
  jbox.append(el("div", "dlabel", `消息 ${data.messages.length} 条`));
  if (!data.messages.length) {
    jbox.append(el("div", "muted", "还没有与这个会话的消息。"));
  } else {
    const ul = el("ul", "thread");
    for (const m of data.messages) {
      const [lv, label] = STATE_LABEL[m.state] ?? ["", m.state];
      const li = el("li");
      li.append(
        el("span", "dir " + (m.direction === "out" ? "out" : "in"), m.direction === "out" ? "→" : "←"),
        el("span", "tt", (m.direction === "out" ? "发给 " : "来自 ") + (m.peerTitle || "?")),
        el("span", "pill " + lv, label),
        el("span", "tm", ago(m.at)),
      );
      ul.append(li);
    }
    jbox.append(ul);
  }
  dlg.append(jbox);
  dlg.append(promptBox(s));

  // 底栏：直接发消息
  const foot = el("div", "foot");
  const send = el("button", "", "发消息");
  send.type = "button";
  send.addEventListener("click", () => { dlg.close(); openSend({ id: s.id, title: s.title, client: s.client }); });
  const close = el("button", "ghost", "关闭");
  close.type = "button";
  close.addEventListener("click", () => dlg.close());
  foot.append(send, close);
  dlg.append(foot);

  document.body.append(dlg);
  dlg.showModal();
}

// 事件委托：会话区一个监听器
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("[data-action='send']");
  if (btn) {
    const id = btn.dataset.id;
    const row = btn.closest(".row");
    const title = row?.querySelector(".t")?.textContent ?? id;
    const pill = row?.querySelector(".mark")?.textContent ?? "";
    const map = { C: "claude", "◎": "codex", D: "dsh", A: "antigravity", G: "gemini", Cu: "cursor", O: "opencode" };
    openSend({ id, title, client: map[pill] ?? "claude" });
    return;
  }
  // 点会话行的其它地方 → 打开详情
  const row = ev.target.closest?.(".row[data-session]");
  if (row && !ev.target.closest("dialog")) openSession(row.dataset.session);
});

// 键盘可达：聚焦会话行后回车/空格也能打开
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const row = ev.target.closest?.(".row[data-session]");
  if (!row) return;
  ev.preventDefault();
  openSession(row.dataset.session);
});

// ── 待你处理：审批与提问 ─────────────────────
// DSH 侧的通道插件（dsh/magpie-hud.mjs）在「决定要问你」的那一刻把卡片写成文件；
// 本面板只负责画出来、把答案写回去。三条纪律：
//   1. 只写答案、不删卡——删卡是插件的活，面板抢先删会让插件判成超时；
//   2. 通道没装 / 没生效时说明缺什么并给一键安装，而不是显示「没有待办」；
//   3. 同一批卡不重画——重画会打断正在输入的回答。

const loadChannel = () => getJSON("/api/channel").catch(() => null);
async function postJSON(path, body) {
  try {
    return await getJSON(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
let channel = null;

const SERVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function asksSignature(ch) {
  const c = ch?.channel ?? {};
  return JSON.stringify([c.installed, c.online, ch?.dsh?.loaded, ch?.dsh?.needsRestart, (ch?.asks ?? []).map((a) => [a.id, a.answered])]);
}

// 一张卡回答完就换成一句话，按钮全部退场——不假装它已经生效，只说「已经交出去了」。
async function submitAnswer(card, value, label) {
  const id = card.dataset.id;
  for (const b of card.querySelectorAll("button")) b.disabled = true;
  card.classList.add("sending");
  const out = await postJSON("/api/asks/answer", { id, value });
  card.classList.remove("sending");
  const acts = card.querySelector(".aacts");
  if (out.ok) {
    card.classList.add("sent");
    acts?.replaceChildren(el("span", "sentmsg", "已" + label + "，等它接手…"));
    return;
  }
  for (const b of card.querySelectorAll("button")) b.disabled = false;
  if (acts) {
    acts.querySelector(".aerr")?.remove();
    acts.prepend(el("p", "aerr", out.error || "没送出去"));
  }
}

function askHead(a, kindLabel) {
  const head = el("div", "ask-head");
  // 提问没工具名，用会话标题更有用（拿不到就退回 id）。
  const known = a.kind === "question" ? (window.__sessions ?? []).find((x) => x.id === a.sessionId) : null;
  const sub = a.kind === "question" ? known?.title || a.sessionId : a.toolName || "工具";
  head.append(el("span", "akind " + a.kind, kindLabel), el("span", "atool", sub));
  if (a.stale) head.append(el("span", "astale", "可能已过期"));
  if (a.timed) head.append(el("span", "atime", "限时"));
  head.append(el("span", "awhen", ago(a.at)));
  // 卡上直接给出处：不想答也能一眼看到底是哪个会话在等
  if (a.sessionId) {
    const go = el("button", "ago", "看会话");
    go.type = "button";
    go.title = "打开这个会话的转录";
    go.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openSession(a.sessionId);
    });
    head.append(go);
  }
  return head;
}

function askWhy(a) {
  const frag = document.createDocumentFragment();
  const zh = a.displayReason?.zh || "";
  const en = a.displayReason?.en || a.reason || "";
  if (zh || en) frag.append(el("p", "areason", zh || en));
  if (zh && en && en !== zh) frag.append(el("p", "aen", en));
  return frag;
}

function approvalCard(a) {
  const box = el("div", "ask approval");
  box.dataset.id = a.id;
  box.append(askHead(a, "审批"), askWhy(a));
  if (a.arguments) {
    const d = el("details", "aargs");
    d.append(el("summary", "", "看它要做什么"), el("pre", "", a.arguments));
    box.append(d);
  }
  const acts = el("div", "aacts");
  const yes = el("button", "ok", "允许一次");
  yes.type = "button";
  yes.addEventListener("click", () => submitAnswer(box, "allowed-once", "允许"));
  const no = el("button", "bad", "拒绝");
  no.type = "button";
  no.addEventListener("click", () => submitAnswer(box, "rejected", "拒绝"));
  acts.append(yes, no);
  box.append(acts);
  return box;
}

function questionCard(a) {
  const box = el("div", "ask question");
  box.dataset.id = a.id;
  box.append(askHead(a, "提问"), askWhy(a));
  const qs = Array.isArray(a.questions) ? a.questions : [];
  const parts = [];
  qs.forEach((q, i) => {
    const wrap = el("div", "q");
    wrap.dataset.qid = String(q.id ?? "");
    wrap.append(el("div", "qlabel", q.label || "问题 " + (i + 1)));
    const opts = el("div", "opts");
    const pick = (b) => {
      if (q.multiSelect) b.classList.toggle("on");
      else for (const sib of opts.children) sib.classList.toggle("on", sib === b);
      for (const sib of opts.children) sib.setAttribute("aria-pressed", sib.classList.contains("on") ? "true" : "false");
      sync();
    };
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const b = el("button", "opt", o.label || o.value || "");
      b.type = "button";
      b.dataset.v = String(o.value ?? "");
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => pick(b));
      opts.append(b);
    }
    wrap.append(opts);
    const other = el("input", "qother");
    other.placeholder = "也可以自己写";
    other.addEventListener("input", sync);
    wrap.append(other);
    parts.push({ q, wrap, opts, other });
    box.append(wrap);
  });

  function readAnswers() {
    return parts.map(({ q, opts, other }) => {
      const item = { id: String(q.id ?? ""), selected: [...opts.querySelectorAll(".opt.on")].map((b) => b.dataset.v) };
      const custom = other.value.trim();
      if (custom) item.custom = custom;
      return item;
    });
  }
  function sync() {
    const rows = readAnswers();
    const missing = rows.filter((r) => !r.selected.length && !r.custom).length;
    const goBtn = box.querySelector(".aacts .ok");
    if (goBtn) goBtn.disabled = missing > 0;
    const hintEl = box.querySelector(".ahint");
    if (hintEl) hintEl.textContent = parts.length > 1 && missing ? missing + " 题还没答" : "";
  }

  const acts = el("div", "aacts");
  const go = el("button", "ok", parts.length > 1 ? "提交答案" : "回答");
  go.type = "button";
  go.disabled = true;
  go.addEventListener("click", () => submitAnswer(box, { answers: readAnswers() }, "提交"));
  acts.append(go, el("span", "ahint", ""));
  box.append(acts);
  return box;
}

// 通道没装：这里不是「空状态」，而是一个要动手的步骤。
function channelSetup(dsh) {
  const box = el("div", "ask setup");
  box.append(el("p", "areason", "审批和提问要由 DSH 侧的一小段插件转过来——它跑在 DSH 进程里，才可能替你回答。"));
  box.append(el("p", "aen", "点下面写进去，然后重启 DSH。写的位置：" + (dsh?.dshHome || "~/.dsh")));
  const acts = el("div", "aacts");
  const btn = el("button", "ok", "装到 DSH");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "正在写…";
    const out = await postJSON("/api/channel/install", { action: "install" });
    btn.disabled = false;
    if (!out.ok) {
      btn.textContent = "装到 DSH";
      acts.querySelector(".aerr")?.remove();
      acts.append(el("p", "aerr", out.error || "装不上"));
      return;
    }
    btn.textContent = "已装，重启 DSH";
    drawn.asks = undefined;
    refreshChannel();
  });
  acts.append(btn);
  if (dsh?.fileThere) {
    const rm = el("button", "ghost", "卸载");
    rm.type = "button";
    rm.addEventListener("click", async () => {
      rm.disabled = true;
      const out = await postJSON("/api/channel/install", { action: "uninstall" });
      if (!out.ok) acts.append(el("p", "aerr", out.error || "卸不掉"));
      drawn.asks = undefined;
      refreshChannel();
    });
    acts.append(rm);
  }
  box.append(acts);
  return box;
}

function renderAsks(ch) {
  const host = document.getElementById("ask-list");
  const hint = document.getElementById("ask-hint");
  if (!host) return;
  channel = ch ?? null;
  const c = ch?.channel ?? {};
  const dsh = ch?.dsh ?? {};
  const asks = (ch?.asks ?? []).filter((a) => !a.answered);
  const setup = !c.installed && !dsh.fileThere;
  if (hint) {
    hint.textContent = setup
      ? "通道未安装"
      : asks.length
      ? asks.length + " 件在等你"
      : c.online
        ? "通道在线"
        : dsh.fileThere
          ? (dsh.needsRestart || !dsh.loaded ? "已装，等 DSH 重启" : "已装，DSH 没连上")
          : "通道未安装";
  }
  const sig = asksSignature(ch);
  if (drawn.asks === sig) return;
  drawn.asks = sig;

  host.replaceChildren();
  if (setup) {
    host.append(channelSetup(dsh));
    return;
  }
  if (!asks.length) {
    host.append(el("p", "emptynote", c.online ? "没有待你处理的事。" : "通道已装，但 DSH 现在没连上（没开，或插件还没加载）。"));
    return;
  }
  for (const a of asks) host.append(a.kind === "question" ? questionCard(a) : approvalCard(a));
}

async function refreshChannel() {
  const ch = await loadChannel();
  if (!ch) return;
  safe("renderAsks", () => renderAsks(ch));
  safe("renderChannelStats", () => { window.__channel = ch; });
  // 设置页那一行跟着状态走，但只换那一行——整页重画会打断正在拖的滑块。
  safe("paintChannelRow", () => {
    const old = document.querySelector("[data-channel-row]");
    if (old) old.replaceWith(channelRow());
  });
}

// 会话里说一句：走同一条通道投进去（不是另开一条消息隧道）。
function promptBox(session) {
  const box = el("div", "dprompt");
  box.append(el("div", "dlabel", "在这个会话里说一句"));
  const ta = el("textarea", "dinput");
  ta.rows = 2;
  ta.placeholder = "它会在正在跑的会话里接着说…";
  const acts = el("div", "pacts");
  const go = el("button", "", "发送");
  go.type = "button";
  const msg = el("span", "pstate", "");
  if (!SERVICE_ID.test(session.id)) {
    go.disabled = true;
    msg.textContent = "这个客户端不支持从面板回话";
  } else if (!channel?.channel?.online) {
    go.disabled = true;
    msg.textContent = "通道未在线，发不进去";
  }
  go.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (!text) return;
    go.disabled = true;
    msg.textContent = "投递中…";
    const out = await postJSON("/api/prompt", { session: session.id, text });
    if (!out.ok) {
      msg.textContent = out.error || "没送出去";
      go.disabled = false;
      return;
    }
    ta.value = "";
    msg.textContent = "排队中…";
    const res = await waitPrompt(session.id, out.id, (t) => { msg.textContent = t; });
    if (res === "effective") msg.textContent = "已送达，这一轮已开始跑";
    else if (res === "delivered") msg.textContent = "已送达（会话里已出现）";
    go.disabled = false;
  });
  acts.append(go, msg);
  box.append(ta, acts);
  return box;
}

async function waitPrompt(session, id, onState) {
  // accepted 只代表宿主收下请求；delivered 才代表会话里真的出现了这句话。
  // 轮询到 delivered 后再多等一会儿，能等到 effective（这一轮真跑起来）就升级。
  let delivered = false;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 600));
    const row = await getJSON("/api/prompt?session=" + encodeURIComponent(session) + "&id=" + encodeURIComponent(id)).catch(() => null);
    if (!row) continue;
    if (row.state === "queued") onState("排队中…");
    if (row.state === "sending") onState("投递中…");
    if (row.state === "accepted") onState("已入队，等会话接收…");
    if (row.state === "effective") {
      onState("已送达，这一轮已开始跑");
      return "effective";
    }
    if (row.state === "delivered") {
      onState("已送达，会话里已出现");
      if (delivered) return "delivered";
      delivered = true;
    }
    if (row.state === "timeout") {
      onState("超时：" + (row.reason || "会话里一直没出现这条话"));
      return "timeout";
    }
    if (row.state === "refused" || row.state === "failed") {
      onState((row.state === "refused" ? "被拒：" : "没送出去：") + (row.reason || ""));
      return "failed";
    }
    if (row.state === "expired" || row.state === "cancelled") {
      onState(row.state === "expired" ? "已过期" : "已撤回");
      return "expired";
    }
  }
  onState(delivered ? "已送达（还没确认开跑）" : "已发出，还没确认");
  return delivered ? "delivered" : "unconfirmed";
}

// ── 主循环 ───────────────────────────────────

// 单个分区渲染失败不该让整页停摆：各自隔离，失败只降级那一段。
// （之前一个数据形状不对就会让整页空白，这个问题很难被用户描述清楚。）
function safe(name, fn) {
  try {
    fn();
  } catch (error) {
    console.error("[鹊楼] 分区渲染失败:", name, error);
    window.__failedSections = [...(window.__failedSections ?? []), name];
  }
}
async function refresh() {
  // catch 的 error 只在块内可见：finally 里也要用它上报，就先在外面接住。
  // 2026-11-16 之前 finally 直接写 error?.message，取数一失败就抛
  // ReferenceError: error is not defined，把「读取失败」的横幅也盖掉了。
  let failure = null;
  try {
    const [state, quotas, history, tokens, quotaHistory, agentsInfo] = await Promise.all([loadState(), loadQuotas(), loadHistory(), loadTokens(), loadQuotaHistory(), loadAgents()]);
    if (state.requires || quotas.requires) {
      showBanner("数据引擎未加载", "会话扫描与额度读取依赖损坏（通常是 zstd 解压包缺失）。重装插件通常可修复。");
      return;
    }
    hideBanner();
    const sessions = state.sessions ?? [];
      safe("renderQuotas", () => renderQuotas(quotas, history, quotaHistory));
    safe("renderByProvider", () => renderByProvider(tokens));
    safe("renderTokens", () => renderTokens(tokens));
    safe("renderHud", () => renderHud(quotas, state, tokens));
    window.__sessions = sessions;
    if (agentsInfo?.agents) window.__agents = agentsInfo.agents;
    window.__byProvider = tokens?.byProvider ?? {};
    safe("renderTiles", () => renderTiles(state, tokens, quotas, sessions));
    safe("renderSessionSearch", () => renderSessionSearch());
    safe("renderSessions", () => renderSessions(sessions));
    safe("renderJournal", () => renderJournal(state.messages ?? []));
    notifyReplies(state.messages ?? []);
    refreshChannel();
    checkQuotaAlerts(quotas);

    // 接口只给最近 50 条，真实总数在 state.total：别把 174 报成 50
    const totalCount = Number.isFinite(state.total) ? state.total : sessions.length;
    const busy = Number.isFinite(state.running)
      ? state.running
      : sessions.filter((s) => s.state === "running").length;
    const pulse = document.getElementById("pulse");
    pulse.classList.toggle("on", busy > 0);
    const busyChip = document.getElementById("busy");
    busyChip.textContent = busy ? `${busy} 个在跑` : `${totalCount} 个会话`;
    busyChip.classList.toggle("busy", busy > 0);
    document.getElementById("updated").textContent = new Date(state.at).toLocaleTimeString();
    if (!window.__reported) {
      window.__reported = true;
      probeWails("data-ready", {
        sessions: totalCount,
        visible: filterByAgent(sessions).length,
        quotaCards: document.querySelectorAll("#quota-cards .card").length,
        cost: tokens?.cost?.usd ?? null,
      });
    }
  } catch (error) {
    failure = error;
    showBanner("读取失败", error.message + "（服务可能在重启，稍后自动重试）");
  } finally {
    // 深链放在 finally：任何一个接口失败都不该让「从 HUD 跳过来」失效
    const deep = new URLSearchParams(location.search).get("session");
    if (deep && !window.__deepOpened) {
      window.__deepOpened = true;
      openSession(deep);
    }
    // 报错也上报：wails 窗口里拿不到数据时，这里能看到确切原因
    if (!window.__errorReported) {
      window.__errorReported = true;
      probeWails("refresh-error", { error: String(failure?.message ?? failure ?? "unknown"), base: API_BASE, path: "/api/state" });
    }
  }
}

// 周期切换（用量 24h / 7d / 30d）
document.getElementById("token-tabs").addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("[data-period]");
  if (!btn) return;
  tokenPeriod = btn.dataset.period;
  for (const b of document.querySelectorAll("#token-tabs .tab")) {
    const on = b === btn;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  drawn.tokens = undefined;
  refreshTokens();
});

// 扫描没跑完就隔一会儿再拉，别让用户盯着半张图
async function refreshTokens() {
  const tokens = await loadTokens();
  renderTokens(tokens);
  if (tokens?.scanning) setTimeout(refreshTokens, 2500);
}

// ── 动效 ─────────────────────────────────────
// 桌面桥是常驻窗口，所以 HUD 可以有「活」的感觉：呼吸光晕、数值缓动、忙碌脉冲。
// 三条纪律：
//   1. 尊重 prefers-reduced-motion；
//   2. ?anim=0 可一键关掉（截图与自动化验证用——连续动画会让截图等不到稳定帧）；
//   3. 页面不可见时停掉 rAF，不白烧 CPU。
const ANIM = !/[?&]anim=0/.test(location.search) && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
// CSS 里的无限动画也要跟着停：呼吸光晕、等待脉冲、骨架条会让截图永远等不到稳定帧。
document.documentElement.classList.toggle("static", !ANIM);

let glowRaf = 0;
function startGlow() {
  if (!ANIM || glowRaf) return;
  const t0 = performance.now();
  const step = (t) => {
    // 2.8s 一个来回，映射到 0..1 给 CSS 用
    const phase = 0.5 - 0.5 * Math.cos(((t - t0) / 2800) * Math.PI * 2);
    document.documentElement.style.setProperty("--glow", phase.toFixed(3));
    glowRaf = requestAnimationFrame(step);
  };
  glowRaf = requestAnimationFrame(step);
}
function stopGlow() {
  if (glowRaf) { cancelAnimationFrame(glowRaf); glowRaf = 0; }
}
if (ANIM) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startGlow(); else stopGlow();
  });
  startGlow();
}

// 数值缓动：从旧值滑到新值（450ms，ease-out），而不是硬跳。
const tweened = new Map();
function tweenNumber(node, to, format = (v) => String(v)) {
  const key = node.dataset.k ?? (node.dataset.k = String(Math.random()));
  const from = tweened.get(key) ?? to;
  tweened.set(key, to);
  if (!ANIM || from === to) { node.textContent = format(to); return; }
  const t0 = performance.now();
  const ms = 450;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    const eased = 1 - (1 - p) ** 3;
    node.textContent = format(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── 设置（桌面 HUD 的位置/透明度/刘海/分区）──────
// 一份设置两处消费：桌面桥读它定窗口位置，页面读它定透明度与显示哪些分区。
let hudSettings = null;

const getSettings = () => getJSON("/api/settings").catch(() => null);
const getDisplay = () => getJSON("/api/display").catch(() => null);
const getDesktop = () => getJSON("/api/desktop").catch(() => null);
let deskState = null;
let displays = null;
let saveTimer = null;
function saveSettings(patch) {
  hudSettings = { ...(hudSettings ?? {}), ...patch };
  applyHudSettings();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    getJSON("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((next) => { hudSettings = next; applyHudSettings(); renderSettings(); }).catch(() => {});
  }, 250);
}

// 主题：用户显式选 dark/light 就用它；auto 时跟随 magpie 的 theme（system 再跟随系统）
function effectiveTheme() {
  const want = hudSettings?.theme ?? "auto";
  if (want === "dark" || want === "light") return want;
  const host = hudSettings?.hostTheme?.theme ?? "system";
  if (host === "dark" || host === "light") return host;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}
function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
}

function applyHudSettings() {
  const s = hudSettings;
  if (!s) return;
  applyTheme();
  const root = document.documentElement;
  // 形状跟着吸附边走：贴顶部是横条，贴左右是竖条（与桥的 effectiveSize 一致）
  const portrait = s.position === "left" || s.position === "right";
  root.dataset.orient = portrait ? "portrait" : "landscape";
  root.style.setProperty("--hud-alpha", String(s.opacity ?? 0.94));
  root.classList.toggle("notch", !!s.notch);
  for (const key of ["quotas", "tokens", "sessions", "journal"]) {
    const on = s.sections?.[key] !== false;
    const sec = document.querySelector('.sec[data-sec="' + key + '"]');
    if (sec) sec.hidden = !on;
  }
}

const POSITION_LABELS = [
  ["top-center", "顶部居中"],
  ["top-left", "左上"],
  ["top-right", "右上"],
  ["left", "贴左"],
  ["right", "贴右"],
  ["custom", "自定义"],
];

function renderSettings() {
  const host = document.getElementById("settings");
  if (!host || !hudSettings) return;
  const s = hudSettings;
  host.replaceChildren();

  const row = (label, ...controls) => {
    const r = el("div", "srow");
    r.append(el("div", "sl", label));
    const c = el("div", "sc");
    c.append(...controls);
    r.append(c);
    return r;
  };

  // 桌面 HUD 的存活与失败原因：没出来时不能只留一句「设置」，
  // 要说清是关了、没装、还是起不来，并能就地重试（清掉 .failed 标记再拉一次）。
  const deskSeg = el("div", "seg");
  const deskNote = el("span", "sn", "读取中…");
  const desk = deskState;
  if (desk) {
    if (!desk.wanted) {
      deskNote.textContent = "已关闭（设置里关掉了桌面 HUD）";
    } else if (desk.alive) {
      deskNote.textContent = `运行中（pid ${desk.pid}）`;
    } else if (desk.reason) {
      deskNote.textContent = `未启动：${desk.reason}`;
    } else if (desk.failMark) {
      const when = desk.failMark.at ? ago(desk.failMark.at) : "此前";
      deskNote.textContent = `未启动：上次启动失败（${when}${desk.failMark.code != null ? "，退出码 " + desk.failMark.code : ""}）`;
    } else if (!desk.binary) {
      deskNote.textContent = "未启动：插件包里没有桌面 HUD 可执行文件";
    } else {
      deskNote.textContent = "未启动";
    }
    if (desk.wanted && !desk.alive) {
      const again = el("button", "", "重试");
      again.type = "button";
      again.addEventListener("click", async () => {
        again.disabled = true;
        deskNote.textContent = "正在重试…";
        try {
          const res = await getJSON("/api/desktop", { method: "POST" });
          deskState = res?.status ?? res ?? null;
        } catch { deskState = null; }
        renderSettings();
      });
      deskSeg.append(again);
    }
  } else {
    deskNote.textContent = "状态读不出来（服务没回 /api/desktop）";
  }
  host.append(row("桌面 HUD", deskSeg, deskNote));

  // 位置
  const seg = el("div", "seg");
  for (const [value, label] of POSITION_LABELS) {
    const b = el("button", s.position === value ? "on" : "", label);
    b.type = "button";
    b.addEventListener("click", () => saveSettings({ position: value }));
    seg.append(b);
  }
  host.append(row("吸附位置", seg, el("span", "sn", s.position === "custom" ? "拖动 HUD 会自动记到这里" : "默认顶部居中；刘海屏可开刘海模式贴齐")));

  // 主题
  const themeSeg = el("div", "seg");
  for (const [value, label] of [["auto", "跟随 magpie"], ["dark", "深色"], ["light", "浅色"]]) {
    const b = el("button", (s.theme ?? "auto") === value ? "on" : "", label);
    b.type = "button";
    b.addEventListener("click", () => saveSettings({ theme: value }));
    themeSeg.append(b);
  }
  host.append(row("主题", themeSeg, el("span", "sn", "magpie: " + (s.hostTheme?.theme ?? "?"))));

  // 显示器（桥枚举后上报；只有一块屏时不显示选择器）
  const screens = displays?.screens ?? [];
  if (screens.length > 1) {
    const seg2 = el("div", "seg");
    const opts = [{ id: "", label: "主屏" }, ...screens.map((sc) => ({ id: sc.id, label: (sc.name || sc.id.slice(0, 8)) + ` ${sc.width}×${sc.height}` + (sc.primary ? " (主)" : "") }))];
    for (const o of opts) {
      const b = el("button", (s.screen ?? "") === o.id ? "on" : "", o.label);
      b.type = "button";
      b.addEventListener("click", () => saveSettings({ screen: o.id }));
      seg2.append(b);
    }
    host.append(row("显示器", seg2));
  }

  // 透明度
  const range = document.createElement("input");
  range.type = "range";
  range.min = "40";
  range.max = "100";
  range.value = String(Math.round((s.opacity ?? 0.94) * 100));
  const val = el("span", "val", range.value + "%");
  range.addEventListener("input", () => { val.textContent = range.value + "%"; });
  range.addEventListener("change", () => saveSettings({ opacity: Number(range.value) / 100 }));
  host.append(row("透明度", range, val));

  // 外形：窄高面板 / 刘海条（宽而扁）
  const shapeSeg = el("div", "seg");
  const SHAPES = [
    ["auto", "跟随吸附边", null, null],
    ["wide", "宽扁 600×180", 600, 180],
    ["tall", "窄高 300×520", 300, 520],
  ];
  for (const [key, label, w, h] of SHAPES) {
    const on = key === "auto" ? s.autoShape !== false : s.autoShape === false && s.width === w && s.height === h;
    const b = el("button", on ? "on" : "", label);
    b.type = "button";
    b.addEventListener("click", () => {
      if (key === "auto") saveSettings({ autoShape: true });
      else saveSettings({ autoShape: false, width: w, height: h });
    });
    shapeSeg.append(b);
  }
  const shown = s.autoShape === false ? `${s.width}×${s.height}` : (s.notch || String(s.position).startsWith("top") ? "560×200（顶部宽扁）" : s.position === "left" || s.position === "right" ? "300×520（侧边窄高）" : `${s.width}×${s.height}`);
  host.append(row("外形", shapeSeg, el("span", "sn", shown)));

  // 只看哪些客户端（空 = 全部）
  const clientsAvailable = [...new Set((window.__sessions ?? []).map((x) => x.client))];
  if (clientsAvailable.length) {
    const wrap = el("div", "sc");
    for (const id of clientsAvailable) {
      const label = el("label", "sn");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = agentsOf().length === 0 || agentsOf().includes(id);
      box.addEventListener("change", () => {
        const cur = new Set(agentsOf());
        if (agentsOf().length === 0) {
          // 从「全部」切到「只选」：先把所有都放进去，再按需去掉
          for (const c of clientsAvailable) cur.add(c);
        }
        if (box.checked) cur.add(id); else cur.delete(id);
        const next = clientsAvailable.filter((c) => cur.has(c));
        saveSettings({ agents: next.length === clientsAvailable.length ? [] : next });
      });
      label.append(box, document.createTextNode(" " + (client(id).short ?? id)));
      wrap.append(label);
    }
    host.append(row("显示 agent", wrap));
  }

  // 开关
  const toggle = (key, label) => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!s[key];
    box.addEventListener("change", () => saveSettings({ [key]: box.checked }));
    return row(label, box);
  };
  host.append(toggle("onlyActive", "只看活跃"));
  host.append(toggle("notch", "刘海模式"));
  host.append(toggle("alwaysOnTop", "总在最前"));

  // 分区开关
  const secs = el("div", "sc");
  for (const [key, label] of [["quotas", "额度"], ["tokens", "用量"], ["sessions", "会话"], ["journal", "消息"]]) {
    const wrap = el("label", "sn");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = s.sections?.[key] !== false;
    box.addEventListener("change", () => saveSettings({ sections: { ...s.sections, [key]: box.checked } }));
    wrap.append(box, document.createTextNode(" " + label));
    secs.append(wrap);
  }
  host.append(row("显示分区", secs));

  // 回话通道：审批与提问要靠 DSH 侧那段插件转过来，状态和装/卸都在这里交代清楚。
  host.append(channelRow());
}

function channelRow() {
  const r = el("div", "srow");
  r.dataset.channelRow = "1";
  r.append(el("div", "sl", "回话通道"));
  const c = el("div", "sc");
  const ch = window.__channel;
  const cch = ch?.channel ?? {};
  const dsh = ch?.dsh ?? {};
  const state = !ch
    ? "读取中…"
    : cch.online
      ? "在线"
      : dsh.fileThere
        ? (dsh.needsRestart || !dsh.loaded ? "已装，等 DSH 重启" : "已装，DSH 没连上")
        : "未安装";
  c.append(el("span", "sn", state));
  if (cch.dir) c.append(el("span", "sn", cch.dir));
  if (ch) {
    const there = !!dsh.fileThere;
    const btn = el("button", "", there ? "卸载" : "装到 DSH");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "正在写…";
      const out = await postJSON("/api/channel/install", { action: there ? "uninstall" : "install" });
      if (!out.ok) {
        btn.disabled = false;
        btn.textContent = there ? "卸载" : "装到 DSH";
        c.append(el("span", "aerr", out.error || "没成功"));
        return;
      }
      drawn.asks = undefined;
      await refreshChannel();
      renderSettings();
    });
    c.append(btn);
  }
  r.append(c);
  return r;
}

// ── 桌面 HUD 视图 ────────────────────────────
// 由 magpie-hud-desktop 的无边框窗口加载 ?hud=1。只显示全局一眼的信息：
// 每个客户端最满的额度环、今天的花费与请求数、会话数与在跑数。
const hudMode = /[?&]hud=1/.test(location.search) || /hud/.test(location.hash);
if (hudMode) document.documentElement.classList.add("hud");

function renderHud(quotas, state, tokens) {
  if (!hudMode) return;
  const rings = document.getElementById("hud-rings");
  // HUD 只放「最吃紧的几块额度」：从 magpie 采集的各 provider 账号里，取每个账号
  // 最满的那个窗口，按百分比降序取前 3——一眼就知道哪里快没了。
  // 每个 provider 只取一个环（同一家的多个账号只算最紧的那个）——
  // 这样一眼看的是「哪几家最吃紧」，而不是同一家的三个账号。
  const byProvider = new Map();
  for (const a of quotas?.providers ?? []) {
    const measured = a.windows.filter((w) => w.percent != null);
    const most = measured.reduce((x, y) => (y.percent > (x?.percent ?? -1) ? y : x), null);
    if (!most) continue;
    const prev = byProvider.get(a.provider);
    if (!prev || most.percent > prev.percent) {
      byProvider.set(a.provider, { provider: a.provider, name: a.name, user: a.user, percent: most.percent, window: most.name });
    }
  }
  const accounts = [...byProvider.values()].sort((a, b) => b.percent - a.percent);

  const sig = JSON.stringify([accounts.slice(0, 3).map((a) => [a.provider, Math.round(a.percent)]), state?.sessions?.length, tokens?.cost?.usd ?? null]);
  if (drawn.hud === sig) return;
  drawn.hud = sig;

  rings.replaceChildren();
  if (!accounts.length) {
    rings.append(el("span", "hud-empty", quotas?.providerTotals ? `${quotas.providerTotals.accounts} 个账号 · 无可算进度` : "暂无套餐额度"));
  } else {
    for (const a of accounts.slice(0, 3)) {
      const wrap = el("div", "hud-ring");
      wrap.append(quotaRing([{ usedPercent: a.percent }], 46));
      const nm = el("div", "rn");
      nm.append(el("b", "", Math.round(a.percent) + "%"));
      nm.append(document.createTextNode((CLIENTS[a.provider]?.short ?? a.name ?? a.provider).slice(0, 10)));
      nm.title = `${a.name ?? a.provider} · ${a.window} · ${a.user ?? ""}`;
      wrap.append(nm);
      wrap.tabIndex = 0;
      wrap.setAttribute("role", "button");
      wrap.title = `${a.name ?? a.provider} · ${a.window} · ${a.user ?? ""}（点开完整面板）`;
      const open = () => { location.href = location.pathname; };
      wrap.addEventListener("click", open);
      wrap.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
      rings.append(wrap);
    }
  }

  const visible = filterByAgent(state?.sessions ?? []);
  const busy = visible.filter((s) => s.state === "running").length;
  const waiting = visible.filter((s) => s.pending).length;
  const stats = document.getElementById("hud-stats");
  stats.replaceChildren();
  const addStat = (label, value, tween) => {
    const s = el("span");
    const b = el("b", "", value);
    s.append(b, document.createTextNode(" " + label));
    // 有 tween 说明是个会变的数：让它滑过去
    if (tween) tweenNumber(b, tween.value, tween.format);
    stats.append(s);
  };
  if (tokens?.cost && typeof tokens.cost.usd === "number") {
    addStat("今日花费", "$" + tokens.cost.usd.toFixed(2), { value: tokens.cost.usd, format: (v) => "$" + v.toFixed(2) });
  }
  if (tokens?.totals) addStat("token", short((tokens.totals.in ?? 0) + (tokens.totals.out ?? 0)));
  // events 只有账簿来源才有；没有就别印一个 "undefined 请求"
  if (typeof tokens?.totals?.events === "number") {
    addStat("请求", String(tokens.totals.events), { value: tokens.totals.events, format: (v) => String(Math.round(v)) });
  }

  // 一眼的摘要：几家额度吃紧、几家还松——三个环都是红的时候，这句话才是信息
  const allPercents = (quotas?.providers ?? []).flatMap((a) => a.windows.map((w) => w.percent).filter((v) => v != null));
  const tight = allPercents.filter((v) => v >= 90).length;
  const warn = allPercents.filter((v) => v >= 70 && v < 90).length;
  const okCount = allPercents.length - tight - warn;
  const quotaBit = allPercents.length ? ` · 额度 ${tight} 紧/${warn} 中/${okCount} 松` : "";

  document.getElementById("hud-line").textContent =
    visible.length + " 个会话 · " + busy + " 个在跑" +
    (waiting ? ` · ${waiting} 个等你` : "") + quotaBit +
    (tokens?.cost?.unpriced ? " · " + tokens.cost.unpriced + " 次未定价" : "");
  document.getElementById("hud-busy").textContent = waiting ? waiting + " 等你" : busy ? busy + " 在跑" : "空闲";
  document.getElementById("hud-busy").classList.toggle("busy", busy > 0 || waiting > 0);
  const chip = document.getElementById("hud-busy");
  chip.style.cursor = waiting ? "pointer" : "";
  chip.title = waiting ? "有会话在等你回答，点开完整面板" : "";
  chip.onclick = waiting ? () => { location.href = location.pathname; } : null;
  document.documentElement.classList.toggle("working", busy > 0);
}

// 面板槽位：agents 槽把会话排前面，usage 槽保持额度在前（默认）。
const focus = (() => {
  const m = /focus=(agents|usage)/.exec(location.hash || "");
  return m ? m[1] : "usage";
})();
// 只有被嵌进 magpie 的面板时才重排；整页（侧栏点进来）保持自然顺序。
if (embedded || focus === "settings") document.body.dataset.focus = focus;

Promise.all([getSettings(), getDisplay(), getDesktop()]).then(([s, d, desk]) => {
  hudSettings = s;
  displays = d;
  deskState = desk;
  applyHudSettings();
  renderSettings();
});

if (hudMode) {
  document.getElementById("hud-full").addEventListener("click", () => {
    location.href = location.pathname + location.hash; // 去掉 ?hud=1，同一窗口切成完整视图
  });
}

reportHeight();
refresh();
// 审批 / 提问只在几秒内有用：单独一条快车道轮询，不等 30 秒的主循环。
refreshChannel();
setInterval(() => { if (document.visibilityState === "visible") refreshChannel(); }, 4_000);
setInterval(refresh, 30_000);
setInterval(() => { if (document.visibilityState === "visible") refreshTokens(); }, 60_000);
