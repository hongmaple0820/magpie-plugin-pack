// 鹊楼验收：页面服务形状——端口解析（package.json 的 service 规格）、
// CSP/CORS/Host/Origin 安全、/api/state 与 /api/quotas 的形状与缓存、
// 引擎不可用时的 requires 状态、以及本插件自带引擎的集成
// （临时 HOME 里的真实扫描）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageServicePort, createPageService, startPageService, stopPageServices } from "../lib/pageservice.mjs";
import { bridgeEngine } from "../lib/engine.mjs";

const fakeEngine = () => ({
  listSessions: async () => ({ sessions: [{ id: "s1", client: "claude", title: "A", state: "idle", reachable: true }] }),
  journal: () => ({ messages: [{ id: "m1", from: { title: "A" }, to: { title: "B" }, sentAtMs: Date.now(), state: "done", fingerprint: "abc" }] }),
  listQuotas: async () => ({ clients: [{ client: "claude", status: "ok", quotas: [{ id: "q1", name: "Current session", shortLabel: "5h", usedPercent: 40, resetAt: Date.now() }] }] }),
});

test("pageServicePort: package.json default 3477, option moves it", () => {
  assert.equal(pageServicePort(), 3477);
  assert.equal(pageServicePort({}), 3477);
  assert.equal(pageServicePort({ port: "4001" }), 4001);
  assert.equal(pageServicePort({ port: 39127 }), 39127);
  assert.equal(pageServicePort({ port: "x" }), 3477); // 坏值回落默认端口
  assert.equal(pageServicePort({ port: 70000 }), 3477);
});

test("page service serves app.html with a service CSP and CORS, and /api/state merges sessions and journal", async () => {
  const service = createPageService({ port: 0, engine: fakeEngine() });
  const port = await service.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /鹊楼/);
    const htmlRes = await fetch(base + "/");
    assert.match(htmlRes.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
    assert.match(htmlRes.headers.get("content-security-policy") ?? "", /connect-src 'self' http:\/\/127\.0\.0\.1:\d+ http:\/\/localhost:\d+/);
    assert.equal(htmlRes.headers.get("access-control-allow-origin"), "*");

    const state = await (await fetch(base + "/api/state", { headers: { origin: "null" } })).json();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, "m1");

    // 陌生 Origin 拒绝；Host 不是本机拒绝（rebinding）。Node 的 fetch
    // 忽略自定义 Host（照 URL 发），所以坏 Host 走裸 socket。
    const badOrigin = await fetch(base + "/api/state", { headers: { origin: "https://evil.example" } });
    assert.equal(badOrigin.status, 403);
    const { connect } = await import("node:net");
    const badHost = await new Promise((resolve, reject) => {
      const sock = connect({ host: "127.0.0.1", port }, () => {
        sock.write(`GET /api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
      });
      let body = "";
      sock.on("data", (d) => { body += d; });
      sock.on("close", () => resolve(Number(body.split("\r\n")[0].split(" ")[1])));
      sock.on("error", reject);
    });
    assert.equal(badHost, 403);

    const missing = await fetch(base + "/api/nope", { headers: { origin: "null" } });
    assert.equal(missing.status, 404);
  } finally {
    await service.stop();
  }
});

test("page service serves the HUD compact view with the right types, and refuses anything off the whitelist", async () => {
  const service = createPageService({ port: 0, engine: fakeEngine() });
  const port = await service.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    // 桌面 HUD 窗口加载的就是这一份；它进不了白名单 = 窗口空白，所以单独立一条
    for (const [file, type] of [["hud.html", "text/html"], ["hud.js", "text/javascript"], ["hud.css", "text/css"]]) {
      const res = await fetch(`${base}/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get("content-type") ?? "", new RegExp(type), file);
      assert.ok((await res.text()).length > 0, file);
    }
    // 白名单之外的文件名一律 404（不拼路径，也就不存在穿越）
    for (const file of ["hud.json", "../package.json", "app.js.bak"]) {
      assert.equal((await fetch(`${base}/${file}`)).status, 404, file);
    }
  } finally {
    await service.stop();
  }
});

test("page service serves /api/quotas with its own shape and caches briefly", async () => {
  let calls = 0;
  const engine = fakeEngine();
  engine.listQuotas = async () => { calls++; return { clients: [{ client: "claude", status: "ok", account: { label: "a@b.c" }, quotas: [{ id: "claude-session", name: "Current session", shortLabel: "5h", usedPercent: 40, status: "ok" }] }] }; };
  const service = createPageService({ port: 0, engine });
  const port = await service.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const a = await (await fetch(base + "/api/quotas")).json();
    const b = await (await fetch(base + "/api/quotas")).json();
    assert.equal(a.clients.length, 1);
    assert.equal(a.clients[0].quotas[0].usedPercent, 40);
    // 仲裁结果与来源诊断是新加的：面板读 windows，旧的 clients/providers 原样保留。
    assert.ok(Array.isArray(a.windows));
    assert.equal(a.windows.length, 1);
    assert.equal(a.windows[0].percent, 40);
    assert.equal(a.windows[0].source, "cli");
    assert.ok(Array.isArray(a.arbitration.sources));
    assert.equal(a.at, b.at);
    assert.equal(calls, 1); // 60s 缓存
  } finally {
    await service.stop();
  }
});

test("without the engine the APIs say so instead of erroring", async () => {
  const service = createPageService({ port: 0 }); // engine 缺省 = null：引擎不可用
  const port = await service.start();
  try {
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: "null" } })).json();
    assert.equal(state.requires, "engine");
    const quotas = await (await fetch(`http://127.0.0.1:${port}/api/quotas`)).json();
    assert.equal(quotas.requires, "engine");
  } finally {
    await service.stop();
  }
});

test("the page service reads through the plugin's own engine", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-hud-"));
  const proj = join(home, ".claude", "projects", "F--maple-demo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "sess-claude-1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "hud demo" } }) + "\n");
  const wasHome = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = home;
  process.env.MAGPIE_HUD_PAGE_PORT = "0"; // 拿临时端口，不抢 3477
  try {
    const engine = await bridgeEngine();
    assert.ok(engine, "the plugin's own lib resolves");
    assert.equal(typeof engine.listSessions, "function");
    assert.equal(typeof engine.journal, "function");
    assert.equal(typeof engine.listQuotas, "function");
    const service = await startPageService({}, engine);
    assert.ok(service && !service.error, service?.error ?? "service started");
    const state = await (await fetch(`http://127.0.0.1:${service.port}/api/state`, { headers: { origin: "null" } })).json();
    assert.ok(Array.isArray(state.sessions) && state.sessions.some((s) => s.client === "claude"), "real scan through the engine");
    assert.ok(Array.isArray(state.messages));
  } finally {
    await stopPageServices();
    if (wasHome == null) delete process.env.MAGPIE_AGENTS_HOME; else process.env.MAGPIE_AGENTS_HOME = wasHome;
    delete process.env.MAGPIE_HUD_PAGE_PORT;
  }
  rmSync(home, { recursive: true, force: true });
});

test("POST /api/send goes through the engine with the human flag, and GET /api/message reads it back", async () => {
  const sent = [];
  const engine = {
    listSessions: async () => ({ sessions: [] }),
    journal: () => ({ messages: [] }),
    listQuotas: async () => ({ clients: [] }),
    send: async (args) => { sent.push(args); return { id: "m-1", state: "queued", reason: null, pass: 1 }; },
    getMessage: (id) => ({ id, state: "done", reason: null, answer: "好的。", to: { client: "claude", sessionId: "s1", title: "T" }, kind: "send", reply: null, sentAt: new Date().toISOString() }),
  };
  const service = createPageService({ port: 0, engine });
  const port = await service.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    // 预检：sandbox 页（不透明 origin）POST 前浏览器先问 OPTIONS
    const pre = await fetch(base + "/api/send", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);
    // 正常发送：human 旗标由服务端定死
    const ok = await (await fetch(base + "/api/send", { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: JSON.stringify({ to: "s1", text: "hi" }) })).json();
    assert.equal(ok.id, "m-1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "s1");
    assert.equal(sent[0].text, "hi");
    assert.equal(sent[0].human, true, "面板发的消息带 human 旗标");
    // 状态与答案
    const msg = await (await fetch(base + "/api/message?id=m-1", { headers: { origin: "null" } })).json();
    assert.equal(msg.state, "done");
    assert.equal(msg.answer, "好的。");
    // 坏 body
    const badJson = await fetch(base + "/api/send", { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: "{oops" });
    assert.equal(badJson.status, 400);
    const noId = await fetch(base + "/api/message", { headers: { origin: "null" } });
    assert.equal(noId.status, 400);
    // 陌生 Origin 的 POST 也拒
    const badOrigin = await fetch(base + "/api/send", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(badOrigin.status, 403);
    // POST 到别的路径仍 405
    const elsewhere = await fetch(base + "/api/state", { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: "{}" });
    assert.equal(elsewhere.status, 405);
    // 引擎没有 send（旧形状）时明说
    const legacy = createPageService({ port: 0, engine: { listSessions: async () => ({ sessions: [] }), journal: () => ({ messages: [] }), listQuotas: async () => ({ clients: [] }) } });
    const lp = await legacy.start();
    try {
      const r = await (await fetch(`http://127.0.0.1:${lp}/api/send`, { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: "{}" })).json();
      assert.equal(r.requires, "engine");
    } finally { await legacy.stop(); }
  } finally {
    await service.stop();
  }
});

test("GET /api/history serves the engine's series with burn rates", async () => {
  const engine = {
    listSessions: async () => ({ sessions: [] }),
    journal: () => ({ messages: [] }),
    listQuotas: async () => ({ clients: [] }),
    quotaHistory: () => ({
      window: () => [
        { client: "claude", id: "claude-session", resetAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), windowDurationSeconds: 18000, points: [{ at: Date.now() - 90 * 60_000, v: 10 }, { at: Date.now() - 30 * 60_000, v: 16.5 }] },
      ],
    }),
  };
  const service = createPageService({ port: 0, engine });
  const port = await service.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const out = await (await fetch(base + "/api/history", { headers: { origin: "null" } })).json();
    assert.equal(out.series.length, 1);
    assert.equal(out.series[0].client, "claude");
    assert.ok(out.series[0].burn, "上升两点应有烧录率");
    assert.ok(Math.abs(out.series[0].burn.percentPerHour - 6.5) < 0.01);
    const legacy = createPageService({ port: 0, engine: { listSessions: async () => ({ sessions: [] }), journal: () => ({ messages: [] }), listQuotas: async () => ({ clients: [] }) } });
    const lp = await legacy.start();
    try {
      const r = await (await fetch(`http://127.0.0.1:${lp}/api/history`, { headers: { origin: "null" } })).json();
      assert.equal(r.requires, "engine");
    } finally { await legacy.stop(); }
  } finally {
    await service.stop();
  }
});

test("GET /api/tokens serves the period's usage, and says requires without the engine", async () => {
  const engine = {
    listSessions: async () => ({ sessions: [] }),
    journal: () => ({ messages: [] }),
    listQuotas: async () => ({ clients: [] }),
    tokenUsage: (period) => ({
      period, from: 0, to: 1, bucketMs: 3600000,
      buckets: [{ at: 0, in: 10, out: 2, cacheRead: 0 }],
      byClient: { dsh: { in: 10, out: 2, cacheRead: 0, total: 12 } },
      byModel: [], totals: { in: 10, out: 2, cacheRead: 0, total: 12, events: 1 },
      scanning: false, parsed: 1, total: 1, skipped: 0,
    }),
  };
  const service = createPageService({ port: 0, engine });
  const port = await service.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const out = await (await fetch(base + "/api/tokens?period=7d", { headers: { origin: "null" } })).json();
    assert.equal(out.period, "7d");
    assert.equal(out.totals.in, 10);
    assert.equal(out.byClient.dsh.total, 12);
    const legacy = createPageService({ port: 0, engine: { listSessions: async () => ({ sessions: [] }), journal: () => ({ messages: [] }), listQuotas: async () => ({ clients: [] }) } });
    const lp = await legacy.start();
    try {
      const r = await (await fetch(`http://127.0.0.1:${lp}/api/tokens`, { headers: { origin: "null" } })).json();
      assert.equal(r.requires, "engine");
    } finally { await legacy.stop(); }
  } finally {
    await service.stop();
  }
});

test("page service caches /api/state scans within TTL", async () => {
  let scans = 0;
  const engine = {
    listSessions: async () => { scans++; return { sessions: [] }; },
    journal: () => ({ messages: [] }),
    listQuotas: async () => ({ clients: [] }),
  };
  const svc = createPageService({ port: 0, engine });
  const port = await svc.start();
  const get = () => fetch("http://127.0.0.1:" + port + "/api/state", { headers: { origin: "null" } }).then((r) => r.json());
  await get(); await get(); await get();
  assert.equal(scans, 1, "TTL 内只扫一次");
  await svc.stop();
});
