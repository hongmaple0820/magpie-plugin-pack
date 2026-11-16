import test from "node:test";
import assert from "node:assert/strict";
import { desktopAlive, desktopBinary, desktopWanted, launchDesktop } from "../lib/desktop.mjs";

test("the desktop binary is discovered when present", () => {
  const bin = desktopBinary();
  // 本仓库里 desktop/ 有已构建的桥，找不到时返回 null 也算正确行为
  assert.ok(bin === null || /magpie-hud-(native|desktop)(\.exe)?$/.test(bin), "返回的应是桥的路径或 null: " + bin);
  if (bin) {
    // 优先级：Rust（跨平台）→ Go GDI（Windows 兜底）；两者都无浏览器依赖
    assert.ok(/desktop-(rust|native)/.test(bin), "应是原生实现（无 WebView2 依赖）: " + bin);
  }
});

test("desktopWanted honours the env switch and the plugin option", () => {
  const was = process.env.MAGPIE_HUD_DESKTOP;
  try {
    delete process.env.MAGPIE_HUD_DESKTOP;
    assert.equal(desktopWanted({}), true, "默认拉起");
    assert.equal(desktopWanted({ desktop: false }), false, "option 可关");
    assert.equal(desktopWanted({ desktop: true }), true);
    process.env.MAGPIE_HUD_DESKTOP = "0";
    assert.equal(desktopWanted({}), false, "环境变量可关");
    process.env.MAGPIE_HUD_DESKTOP = "1";
    assert.equal(desktopWanted({}), true);
  } finally {
    if (was == null) delete process.env.MAGPIE_HUD_DESKTOP; else process.env.MAGPIE_HUD_DESKTOP = was;
  }
});

// 回归：启动成功后返回的字段只能是 started / pid / bin。
// 2026-11-16 之前这里多了一个未声明的 assets，ESM 严格模式下必抛 ReferenceError，
// 被同一个 catch 吞成「起点失败」，窗口其实已经起来了——错误信号害了所有桌面验收。
test("launchDesktop 成功后只返回 pid 与 bin，不带未声明的字段", () => {
  const wasRetry = process.env.MAGPIE_HUD_DESKTOP_RETRY;
  process.env.MAGPIE_HUD_DESKTOP_RETRY = "1"; // 跳过历史失败标记
  try {
    let seen = null;
    const child = { pid: 4242, once() {}, unref() {} };
    const result = launchDesktop({
      port: 3477,
      bin: "C:/fake/magpie-hud-native.exe",
      spawnImpl: (bin, args, opts) => { seen = { bin, args, opts }; return child; },
    });
    assert.deepEqual(result, { started: true, pid: 4242, bin: "C:/fake/magpie-hud-native.exe" });
    assert.ok(!("assets" in result), "返回值里不该有 assets");
    assert.deepEqual(seen.args, ["--port", "3477"], "参数只有端口");
    assert.equal(seen.opts.detached, true, "HUD 必须是独立进程");
  } finally {
    if (wasRetry == null) delete process.env.MAGPIE_HUD_DESKTOP_RETRY; else process.env.MAGPIE_HUD_DESKTOP_RETRY = wasRetry;
  }
});

test("launchDesktop 没端口时不 spawn，如实拒绝", () => {
  const wasRetry = process.env.MAGPIE_HUD_DESKTOP_RETRY;
  process.env.MAGPIE_HUD_DESKTOP_RETRY = "1";
  try {
    let spawned = false;
    const result = launchDesktop({ port: 0, spawnImpl: () => { spawned = true; } });
    assert.equal(result.started, false);
    assert.match(result.reason, /no service port/);
    assert.equal(spawned, false);
  } finally {
    if (wasRetry == null) delete process.env.MAGPIE_HUD_DESKTOP_RETRY; else process.env.MAGPIE_HUD_DESKTOP_RETRY = wasRetry;
  }
});

test("desktopAlive 认本进程，不认不存在的 pid", () => {
  assert.equal(desktopAlive(process.pid), true);
  assert.equal(desktopAlive(0), false);
  assert.equal(desktopAlive(999999), false);
});

// 面板设置页那一行「桌面 HUD」的数据源：说清是关了、没装、还是起不来。
test("desktopStatus 区分「关了」「没起来」「在跑」", async () => {
  const { desktopStatus, noteLaunch } = await import("../lib/desktop.mjs");
  noteLaunch({ wanted: false, started: false, reason: "已按设置关闭" });
  let st = desktopStatus();
  assert.equal(st.wanted, false);
  assert.equal(st.alive, false);
  assert.equal(st.reason, "已按设置关闭");

  noteLaunch({ wanted: true, started: true, pid: process.pid, bin: "C:/fake/magpie-hud-native.exe" });
  st = desktopStatus();
  assert.equal(st.wanted, true);
  assert.equal(st.alive, true, "本进程 pid 一定活着");
  assert.equal(st.pid, process.pid);

  noteLaunch({ wanted: true, started: false, reason: "spawn EACCES" });
  st = desktopStatus();
  assert.equal(st.alive, false);
  assert.equal(st.reason, "spawn EACCES");
});

test("retryDesktop 先清失败标记，再拉起一次，并把新状态带回去", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { desktopBinary, retryDesktop, desktopStatus } = await import("../lib/desktop.mjs");
  const bin = desktopBinary();
  if (!bin) return; // 包里没有 exe：重试只能如实说没有二进制
  const mark = path.join(path.dirname(bin), "..", "." + path.basename(bin) + ".failed");
  // 本机可能真有上一次失败留下的标记：先存下来，测完原样放回去，别把真信息测没了
  const before = fs.existsSync(mark) ? fs.readFileSync(mark, "utf8") : null;
  fs.writeFileSync(mark, JSON.stringify({ at: Date.now(), code: 3 }) + "\n");
  try {
    const res = retryDesktop({ port: 0 }); // 端口 0 → launchDesktop 会拒绝，正好验证不 spawn
    assert.equal(res.started, false);
    assert.equal(fs.existsSync(mark), false, "重试必须把 .failed 删掉，否则用户只能自己去找隐藏文件");
    assert.equal(res.status.failMark, null);
    assert.equal(desktopStatus().failMark, null);
  } finally {
    if (before == null) fs.rmSync(mark, { force: true });
    else fs.writeFileSync(mark, before);
    delete process.env.MAGPIE_HUD_DESKTOP_RETRY;
  }
});
