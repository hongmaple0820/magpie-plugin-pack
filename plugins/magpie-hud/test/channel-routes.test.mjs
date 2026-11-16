// 通道路由：用户点「同意」「发送」时真正走过的 HTTP 面。
// 这里断言的是文件落地，不是状态码好看。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPageService } from "../lib/pageservice.mjs";

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withService(fn) {
  const service = createPageService({ port: 0, engine: null });
  const port = await service.start();
  try {
    return await fn("http://127.0.0.1:" + port);
  } finally {
    await service.stop();
  }
}

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify(body) });

test("GET /api/channel 同时给通道状况、待答卡、活会话、活动流水和 DSH 安装状态，并替面板签到", async () => {
  const ch = temp("ch-");
  const dsh = temp("dsh-");
  const oldChannel = process.env.MAGPIE_HUD_CHANNEL;
  const oldDsh = process.env.DSH_HOME;
  process.env.MAGPIE_HUD_CHANNEL = ch.dir;
  process.env.DSH_HOME = dsh.dir;
  try {
    mkdirSync(join(ch.dir, "asks"), { recursive: true });
    mkdirSync(join(ch.dir, "sessions"), { recursive: true });
    writeFileSync(join(ch.dir, "asks", "ask_1.json"), JSON.stringify({ id: "ask_1", kind: "approval", sessionId: "s1", at: Date.now(), toolName: "bash" }));
    writeFileSync(join(ch.dir, "sessions", "s1.json"), JSON.stringify({ id: "s1", at: Date.now() }));
    writeFileSync(join(ch.dir, "plugin.json"), JSON.stringify({ at: Date.now(), host: "h" }));

    await withService(async (base) => {
      const res = await fetch(base + "/api/channel", { headers: { origin: "null" } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.channel.installed, true);
      assert.equal(body.channel.online, true);
      assert.equal(body.asks.length, 1);
      assert.equal(body.asks[0].toolName, "bash");
      assert.equal(body.sessions.filter((s) => s.live).length, 1);
      assert.equal(body.dsh.dshHome, dsh.dir);
      assert.equal(body.dsh.loaded, false);
      assert.ok(existsSync(join(ch.dir, "app.json")), "面板每读一次就签到一次");
    });
  } finally {
    if (oldChannel === undefined) delete process.env.MAGPIE_HUD_CHANNEL;
    else process.env.MAGPIE_HUD_CHANNEL = oldChannel;
    if (oldDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldDsh;
    ch.done();
    dsh.done();
  }
});

test("POST /api/asks/answer 把答复写成插件要的那个文件；坏答案 400", async () => {
  const ch = temp("ch-");
  const old = process.env.MAGPIE_HUD_CHANNEL;
  process.env.MAGPIE_HUD_CHANNEL = ch.dir;
  try {
    mkdirSync(join(ch.dir, "asks"), { recursive: true });
    writeFileSync(join(ch.dir, "asks", "ask_7.json"), JSON.stringify({ id: "ask_7", kind: "approval", sessionId: "s1", at: Date.now() }));
    await withService(async (base) => {
      const bad = await post(base + "/api/asks/answer", { id: "ask_7", value: "nope" });
      assert.equal(bad.status, 400);
      const ok = await post(base + "/api/asks/answer", { id: "ask_7", value: "allowed-once" });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });
      const written = JSON.parse(readFileSync(join(ch.dir, "asks", "ask_7.answer"), "utf8"));
      assert.equal(written.value, "allowed-once");
      // 写完不删卡：删卡是插件的活，面板抢着删会让插件误判超时
      assert.ok(existsSync(join(ch.dir, "asks", "ask_7.json")));
    });
  } finally {
    if (old === undefined) delete process.env.MAGPIE_HUD_CHANNEL;
    else process.env.MAGPIE_HUD_CHANNEL = old;
    ch.done();
  }
});

test("POST /api/prompt 写话进 prompts/，GET 读回投递状态", async () => {
  const ch = temp("ch-");
  const old = process.env.MAGPIE_HUD_CHANNEL;
  process.env.MAGPIE_HUD_CHANNEL = ch.dir;
  try {
    await withService(async (base) => {
      const sent = await post(base + "/api/prompt", { session: "s1", text: "把测试跑一遍" });
      assert.equal(sent.status, 200);
      const out = await sent.json();
      assert.equal(out.ok, true);
      const files = readdirSync(join(ch.dir, "prompts", "s1"));
      assert.equal(files.length, 1);
      const stored = JSON.parse(readFileSync(join(ch.dir, "prompts", "s1", files[0]), "utf8"));
      assert.equal(stored.text, "把测试跑一遍");

      const state = await (await fetch(base + "/api/prompt?session=s1&id=" + encodeURIComponent(out.id))).json();
      assert.equal(state.state, "queued");

      const empty = await post(base + "/api/prompt", { session: "s1", text: "  " });
      assert.equal(empty.status, 400);
    });
  } finally {
    if (old === undefined) delete process.env.MAGPIE_HUD_CHANNEL;
    else process.env.MAGPIE_HUD_CHANNEL = old;
    ch.done();
  }
});

test("POST /api/channel/install 装的是临时 DSH_HOME，真写文件；卸载后不留痕", async () => {
  const ch = temp("ch-");
  const dsh = temp("dsh-");
  const oldChannel = process.env.MAGPIE_HUD_CHANNEL;
  const oldDsh = process.env.DSH_HOME;
  process.env.MAGPIE_HUD_CHANNEL = ch.dir;
  process.env.DSH_HOME = dsh.dir;
  try {
    writeFileSync(join(dsh.dir, "cordis.patch.yml"), "# dsh home patch layer\n");
    await withService(async (base) => {
      const ins = await post(base + "/api/channel/install", { action: "install" });
      assert.equal(ins.status, 200);
      const out = await ins.json();
      assert.equal(out.ok, true);
      assert.equal(out.loaded, true);
      assert.ok(existsSync(join(dsh.dir, "magpie-hud.mjs")));
      assert.match(readFileSync(join(dsh.dir, "cordis.patch.yml"), "utf8"), /magpie-hud-plugin/);

      const nope = await post(base + "/api/channel/install", { action: "rm -rf" });
      assert.equal(nope.status, 400);

      const del = await post(base + "/api/channel/install", { action: "uninstall" });
      assert.equal(del.status, 200);
      assert.ok(!readFileSync(join(dsh.dir, "cordis.patch.yml"), "utf8").includes("magpie-hud"));
    });
  } finally {
    if (oldChannel === undefined) delete process.env.MAGPIE_HUD_CHANNEL;
    else process.env.MAGPIE_HUD_CHANNEL = oldChannel;
    if (oldDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldDsh;
    ch.done();
    dsh.done();
  }
});

test("没在白名单里的 POST 一律 405", async () => {
  await withService(async (base) => {
    const res = await post(base + "/api/state", {});
    assert.equal(res.status, 405);
  });
});
