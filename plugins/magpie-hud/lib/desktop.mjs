// 原生 HUD 桥的发现与拉起。
//
// 为什么要有它：magpie 的插件只有「页面」和「面板」两个呈现位，都不能常驻
// 桌面（internal/gui/panelside.go 只管快捷面板往哪边开，trayusage 是 magpie
// 自己的托盘能力）。所以真正的系统级 HUD 必须是一个独立的原生窗口程序：
// desktop-rust/（首选，跨平台、几百 KB）或 desktop-native/（Go + Win32 GDI
// 兜底），两者都不依赖 WebView2。历史上的 wails 版（desktop/）已弃用，
// 只剩旧源码，不再被自动拉起。
//
// 行为：
//   - 二进制在（desktop-rust/ 或 desktop-native/）且没有已在跑 → 拉起它，
//     只传 --port：原生桥自己去问插件服务，不加载任何页面；
//   - MAGPIE_HUD_DESKTOP=0 或插件 option {"desktop": false} → 不拉起；
//   - 拉不起来只记一行日志，绝不拦住插件装载（HUD 是加分项，不是前提）。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // lib/

export function desktopBinary() {
  // 优先原生 GDI 版：零 WebView2 依赖，用户机器上不会因为运行时版本而失败。
  // wails/WebView2 版只作为历史实现保留，不再被自动拉起。
  // 顺序即优先级：Rust 版（跨平台、几百 KB）→ Go GDI 版（Windows 兜底）
  for (const [dir, names] of [
    ["desktop-rust", ["magpie-hud-native.exe", "magpie-hud-native"]],
    ["desktop-native", ["magpie-hud-native.exe", "magpie-hud-native"]],
  ]) {
    for (const name of names) {
      const p = join(HERE, "..", dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function desktopWanted(options = {}, settings = null) {
  if (process.env.MAGPIE_HUD_DESKTOP === "0") return false;
  if (options && options.desktop === false) return false;
  // 用户在设置页关掉 HUD（enabled:false）就真的不再拉起——这一条要持久，
  // 否则重启 magpie 又冒出来，等于没关。
  if (settings && settings.enabled === false) return false;
  return true;
}

/**
 * 拉起 HUD 桥。返回 {started, pid, bin} 或 {started:false, reason}。
 * @param {{port:number}} where 插件服务端口；原生桥自己去 http://127.0.0.1:<port>/api/* 取数
 */
// 失败抑制：桥因环境（如 WebView2 版本过旧）起不来时，记一次标记，
// 后续不再反复尝试——绝不让用户看到崩溃刷屏。删除该文件即可重试。
// 标记按二进制名区分——换了实现（如 wails → 原生 GDI）不该继承旧的失败记录。
function failMarkPath(bin = desktopBinary()) {
  const name = bin ? basename(bin) : "none";
  return join(HERE, "..", "." + name + ".failed");
}

// 上次拉起的结果。面板的「桌面 HUD」一行与重试按钮读它——
// 失败只写进日志的话，用户看到的是「HUD 没出来」而不知道为什么。
let lastLaunch = null;

/** 记下这一次拉起的结果（index.mjs 在插件装载时调）。 */
export function noteLaunch(result) {
  lastLaunch = { ...result, at: Date.now() };
  return lastLaunch;
}

/**
 * 桌面 HUD 现在到底是什么状态——面板据此渲染，不猜。
 * @returns {{wanted: boolean, binary: string|null, started: boolean, pid: number|null,
 *   alive: boolean, reason: string|null, failMark: {at: number|null, code: number|null}|null, at: number|null}}
 */
export function desktopStatus() {
  const bin = desktopBinary();
  let failMark = null;
  try {
    if (bin && existsSync(failMarkPath(bin))) {
      const raw = JSON.parse(readFileSync(failMarkPath(bin), "utf8"));
      failMark = { at: Number.isFinite(raw?.at) ? raw.at : null, code: Number.isFinite(raw?.code) ? raw.code : null };
    }
  } catch { failMark = { at: null, code: null }; }
  const pid = lastLaunch?.pid ?? null;
  return {
    wanted: lastLaunch?.wanted ?? true,
    binary: bin ? basename(bin) : null,
    started: !!lastLaunch?.started,
    pid,
    alive: pid != null && desktopAlive(pid),
    reason: lastLaunch?.reason ?? null,
    failMark,
    at: lastLaunch?.at ?? null,
  };
}

/**
 * 用户点「重试」：清掉失败标记再拉一次。
 * 只清标记不重拉等于让用户自己去找 exe——这里一次做完，并把新结果返回给面板。
 */
export function retryDesktop({ port }) {
  const bin = desktopBinary();
  if (!bin) return { started: false, reason: "no binary (desktop-rust/ or desktop-native/; see desktop-rust/BUILD.md)", status: desktopStatus() };
  try { rmSync(failMarkPath(bin), { force: true }); } catch { /* 删不掉就靠 launchDesktop 的标记检查拦住，不重复起 */ }
  process.env.MAGPIE_HUD_DESKTOP_RETRY = "1";
  const result = noteLaunch({ wanted: true, ...launchDesktop({ port }) });
  return { ...result, status: desktopStatus() };
}

/** 进程还活着吗（Windows 上 Node 的 signal 0 走 OpenProcess）。
 *  EPERM 说明进程存在但不归我们管，按活着算。 */
export function desktopAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * 拉起 HUD 桥。同步返回，`started:true` 的含义是「子进程已创建、拿到了 pid」——
 * 窗口是否真的出现要看进程能否活过启动期（调用方用 desktopAlive 回看）。
 * bin / spawnImpl 只给测试注入用：真实调用一律走 desktopBinary() + node 的 spawn。
 */
export function launchDesktop({ port, extraArgs = [], bin: binOverride = null, spawnImpl = spawn } = {}) {
  if (process.env.MAGPIE_HUD_DESKTOP_RETRY !== "1" && existsSync(failMarkPath(binOverride))) {
    return { started: false, reason: "skipped (desktop HUD failed before; delete the .failed mark beside the plugin to retry)" };
  }
  const bin = binOverride ?? desktopBinary();
  if (!bin) return { started: false, reason: "no binary (desktop-rust/ or desktop-native/; see desktop-rust/BUILD.md)" };
  if (!port) return { started: false, reason: "no service port" };
  // 只传端口，不传资源目录：原生桥自己取 /api/settings 与 /api/*，不加载页面。
  // 2026-11-16 之前这里连着传过一个 --assets，而那个变量从未声明——返回值里
  // 残留的 assets 就是这么来的（见 test/desktop.test.mjs 的回归用例）。
  try {
    const child = spawnImpl(bin, ["--port", String(port), ...extraArgs], {
      detached: true,
      stdio: "ignore",
      windowsHide: false, // 它是个窗口，别藏起来
    });
    // 非 0 退出＝环境不支持，落标记不再重试。窗口被用户正常关掉是 0，不落标记。
    child.once("exit", (code) => {
      if (code !== 0) {
        try { writeFileSync(failMarkPath(bin), JSON.stringify({ at: Date.now(), code }) + "\n"); } catch { /* 写不了就算了 */ }
      } else {
        // 正常退出说明这个二进制在本机是能跑的，清掉历史标记。
        try { rmSync(failMarkPath(bin), { force: true }); } catch { /* 忽略 */ }
      }
    });
    child.unref();
    return { started: true, pid: child.pid, bin };
  } catch (error) {
    return { started: false, reason: String(error?.message ?? error) };
  }
}
