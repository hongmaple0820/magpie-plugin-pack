// 桌面 HUD 紧凑视图：每 3 秒取一次 /api/state、/api/quotas、/api/tokens，渲染状态栏与展开面板。
//
// 三条约定：
// 1) 数字要么是真的，要么是「—」——读不到不写 0（面板那边同一条规矩）；
// 2) 窗口高度由这里报给 Rust（window.ipc），所以展开/收起后必须调一次 syncHeight；
// 3) 直接在浏览器打开也能用：没有 window.ipc 就退化成「不能拖动、不能改高度」。
/* global window, document, fetch, location */
(() => {
"use strict";

// 注意：不能叫 ipc —— wry 会往页面注入一个同名全局，脚本会 SyntaxError 整个不执行。
// IPC 到 Rust 外壳（拖动、改高度、开页面）。浏览器里打开时没有它——
// 那就明确是「没有通道」，而不是「调用失败了」：两者让调用方做的事完全不同。
const bridge = (() => {
  try {
    if (typeof window.ipc?.postMessage === "function") {
      return { ok: true, reason: null, post: (msg) => window.ipc.postMessage(JSON.stringify(msg)) };
    }
    return { ok: false, reason: "no ipc（在浏览器里打开，没有桌面外壳）", post: () => {} };
  } catch (error) {
    return { ok: false, reason: "ipc 不可用：" + (error?.message ?? error), post: () => {} };
  }
})();

const $ = (id) => document.getElementById(id);
// 建节点用的小工具：三处列表都在拼 DOM，手写 createElement + 赋值太啰嗦
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// 3 秒：/api/state 自己约 10 秒刷一次（服务端缓存），HUD 拉得更快只会拿到同一份快照；
// 而审批要在「人看到 agent 停下」和「HUD 亮出来」之间不超过一个感知延迟，3 秒够用也不烧 CPU。
const REFRESH_MS = 3000;
const CLIENT_LABEL = {
  dsh: "DeepSeek Harness",
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};
// 状态栏里用简称：全名（"DeepSeek Harness 50"）一挤就把统计数字顶出去
const CLIENT_SHORT = { dsh: "DSH", claude: "Claude", codex: "Codex", antigravity: "AG" };
// 面板上不出现英文阶段名：这些值来自 truth 层，是代码，不是给人看的文案
const PHASE_LABEL = { working: "工作中", waiting: "等你", idle: "空闲", unknown: "未知" };

let expanded = false;
let last = { state: null, quotas: null, tokens: null };

const fmtCount = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  return String(Math.round(n));
};
const fmtUsd = (n) => (typeof n === "number" && Number.isFinite(n) ? "$" + n.toFixed(n >= 100 ? 0 : 2) : "—");
const agoShort = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + " 秒前";
  const m = Math.round(s / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.round(m / 60);
  return h + " 小时前";
};

// 窗口高度 = 文档实际高度：Rust 侧收到就 set_inner_size，不靠猜。
function syncHeight() {
  const h = Math.ceil(document.getElementById("hud").getBoundingClientRect().height);
  document.documentElement.style.height = h + "px";
  bridge.post({ cmd: "resize", h });
}

function renderClients(state) {
  const box = $("clients");
  box.textContent = "";
  const tally = new Map();
  for (const s of state?.sessions ?? []) {
    const cur = tally.get(s.client) ?? { n: 0, live: 0 };
    cur.n += 1;
    if (s.state === "running") cur.live += 1;
    tally.set(s.client, cur);
  }
  // 客户端多的时候别把栏撑爆：只显示有会话的，按数量降序取前 4 个
  const rows = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4);
  for (const [client, t] of rows) {
    const chip = el("span", "client");
    chip.dataset.live = t.live > 0 ? "1" : "0";
    chip.append(el("i", "dot"));
    chip.append(el("span", "", (CLIENT_SHORT[client] ?? client) + " " + t.n));
    bank.tip(chip, `${CLIENT_LABEL[client] ?? client}：${t.n} 个会话，${t.live} 个在跑`);
    box.append(chip);
  }
}

// 简短的悬浮提示（原生 title 在 WebView 里延迟太长，HUD 上不适用）
const bank = {
  tip(node, text) {
    node.title = text;
  },
};

function renderRing(quotas) {
  const windows = (quotas?.windows ?? []).filter((w) => typeof w.percent === "number");
  const most = windows.reduce((a, b) => (!a || b.percent > a.percent ? b : a), null);
  const fill = $("ring-fill");
  const text = $("ring-text");
  const circumference = 2 * Math.PI * 15;
  fill.style.strokeDasharray = String(circumference);
  if (!most) {
    fill.style.strokeDashoffset = String(circumference);
    text.textContent = "—";
    $("ring").title = "所有额度窗口都读不出百分比";
    return;
  }
  const pct = Math.max(0, Math.min(100, most.percent));
  fill.style.strokeDashoffset = String(circumference * (1 - pct / 100));
  fill.style.stroke = pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
  text.textContent = Math.round(pct) + "%";
  $("ring").title = `${most.key ?? most.name ?? "额度"}：${Math.round(pct)}%（${most.source ?? "来源未知"}）`;
}

function renderBar(state) {
  $("run-count").textContent = Number.isFinite(state?.running) ? String(state.running) : "—";
  $("run-count").parentElement.title = `共 ${state?.total ?? "?"} 个会话，${state?.running ?? "?"} 个在跑`;
  renderClients(state);

  const tokens = last.tokens;
  $("tokens").textContent = fmtCount(tokens?.totals?.total);
  $("cost").textContent = fmtUsd(tokens?.cost?.usd);
  renderRing(last.quotas);

  const asks = asksOf(state);
  $("pending").hidden = asks.length === 0;
  $("pending-count").textContent = String(asks.length);
  $("pending").title = asks.length ? asks.length + " 个审批/提问在等你" : "";
}

// 一趟旅程：dsh 的 pending 带 askId；claude/codex 的审批在各自通道里，
// /api/state 已经把能回答的挂在 pending 上（kind = approval / question）。
function asksOf(state) {
  const out = [];
  for (const s of state?.sessions ?? []) {
    if (!s.pending || !s.pending.askId) continue;
    out.push({ session: s, ask: s.pending });
  }
  return out;
}

function renderSessions(state) {
  const list = $("sessions");
  list.textContent = "";
  const running = (state?.sessions ?? []).filter((s) => s.state === "running");
  const shown = (running.length ? running : (state?.sessions ?? []).slice(0, 4)).slice(0, 6);
  $("panel-hint").textContent = running.length
    ? `${running.length} 个在工作`
    : `没有在跑的，下面是最近的 ${shown.length} 个`;
  for (const s of shown) {
    const row = el("li", "row");
    // 点一行就去面板里看这条会话：切换焦点从这里出发，比在面板里翻列表快
    row.style.cursor = "pointer";
    row.addEventListener("click", () => {
      if (bridge.ok) bridge.post({ cmd: "open", id: s.id });
      else window.open(location.origin + "/?session=" + encodeURIComponent(s.id), "_blank", "noopener");
    });
    row.append(el("i", "dot"));
    const title = el("span", "title", s.title || s.project || s.id);
    bank.tip(title, (s.project ? s.project + " · " : "") + (CLIENT_LABEL[s.client] ?? s.client));
    row.append(title);
    const age = s.evidence?.mtimeMs ? Date.now() - s.evidence.mtimeMs : NaN;
    const phase = PHASE_LABEL[s.phase] ?? null;
    row.append(el("span", "meta", phase && s.phase !== "unknown" ? phase : agoShort(age) || "未知"));
    list.append(row);
  }
}

function renderAsks(state) {
  const asks = asksOf(state);
  const head = $("asks-head");
  const list = $("asks");
  head.hidden = asks.length === 0;
  list.hidden = asks.length === 0; // 没有待批就整块不占位，别留一个「没有」
  list.textContent = "";
  for (const { session, ask } of asks) {
    const item = el("li", "ask");
    const what = el("div", "");
    what.append(el("div", "what", ask.toolName || ask.kind || "需要你决定"));
    what.append(el("div", "who", `${CLIENT_LABEL[session.client] ?? session.client} · ${session.title || session.id}`));
    item.append(what);

    const acts = el("div", "acts");
    const yes = el("button", "yes", "批准");
    const no = el("button", "no", "拒绝");
    const send = async (value) => {
      yes.disabled = true;
      no.disabled = true;
      try {
        const res = await fetch("/api/asks/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: ask.askId, value }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        item.remove();
      } catch (error) {
        // 失败就恢复按钮并把原因写在行里——HUD 上不能弹窗，但也不能装作成功
        yes.disabled = false;
        no.disabled = false;
        what.append(el("div", "who", "没送出去：" + (error?.message ?? error)));
      }
    };
    yes.addEventListener("click", () => send("allow"));
    no.addEventListener("click", () => send("deny"));
    acts.append(yes, no);
    item.append(acts);
    list.append(item);
  }
}

function renderFooter(state, tokens) {
  const total = state?.total;
  const running = state?.running;
  const cost = tokens?.cost?.usd;
  $("foot-left").textContent =
    `${total ?? "—"} 个会话 · ${running ?? "—"} 个在跑` + (Number.isFinite(cost) ? ` · 24h ${fmtUsd(cost)}` : "");
}

function render() {
  const { state, tokens } = last;
  if (!state) return;
  $("hud").dataset.state = "ready";
  renderBar(state);
  if (expanded) {
    renderSessions(state);
    renderAsks(state);
    renderFooter(state, tokens);
  }
  syncHeight();
}

async function getJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(path + " → HTTP " + res.status);
  return res.json();
}

async function tick() {
  try {
    const [state, quotas, tokens] = await Promise.all([
      getJSON("/api/state"),
      getJSON("/api/quotas").catch(() => null),
      getJSON("/api/tokens").catch(() => null),
    ]);
    last = { state, quotas, tokens };
    render();
  } catch (error) {
    // 服务重连中：没有数据时把原因写在栏里（只有标题的话，窗口上什么都看不见，
    // 人会以为是窗口坏了）。有上次画面时保留数字，只标记状态。
    const why = String(error?.message ?? error);
    $("hud").dataset.state = "offline";
    $("hud").title = "连不上插件服务：" + why;
    // 也送进外壳的日志：窗口里只看得见「—」，真正的原因（HTTP 403/脚本异常）在 stderr 里
    bridge.post({ cmd: "log", text: "取数失败：" + why });
    if (!last.state) {
      $("clients").textContent = "";
      const chip = el("span", "client");
      chip.dataset.live = "0";
      chip.append(el("i", "dot"));
      chip.append(el("span", "", "连不上插件服务：" + why));
      $("clients").append(chip);
    }
  }
}

function setExpanded(next) {
  expanded = next;
  $("panel").hidden = !next;
  $("more").textContent = next ? "⌃" : "⌄";
  $("more").setAttribute("aria-expanded", String(next));
  $("running").setAttribute("aria-expanded", String(next));
  if (next) {
    renderSessions(last.state);
    renderAsks(last.state);
    renderFooter(last.state, last.tokens);
  }
  syncHeight();
}

// 交互接线
$("more").addEventListener("click", () => setExpanded(!expanded));
$("running").addEventListener("click", () => setExpanded(!expanded));
$("pending").addEventListener("click", () => setExpanded(true));
$("open-page").addEventListener("click", () => {
  const url = location.origin + "/";
  if (bridge.ok) bridge.post({ cmd: "open", url });
  else window.open(url, "_blank", "noopener");
});

// 拖动：整条状态栏都能拖（CSS app-region 在 WebView2 里不生效，交给 Rust 的 drag_window）。
$("bar").addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  if (ev.target.closest("button")) return;
  bridge.post({ cmd: "drag" });
});
// 双击状态栏：收起或展开
$("bar").addEventListener("dblclick", (ev) => {
  if (ev.target.closest("button")) return;
  setExpanded(!expanded);
});

syncHeight();
tick();
setInterval(tick, REFRESH_MS);
// ?expand=1 直接展开：截图核对、以及「打开就摊开」的那种用法
if (new URLSearchParams(location.search).get("expand") === "1") setExpanded(true);
})();
