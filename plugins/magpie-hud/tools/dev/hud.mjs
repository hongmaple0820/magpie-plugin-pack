// 本机预览：把插件服务和桌面 HUD 一起拉起来，不装进 magpie 也能看。
//
// 为什么要它：桌面 HUD 只是个「画窗口」的原生程序，数据全靠插件页面服务
// （/api/state、/api/quotas、/api/settings）。单独起 exe 会连不上服务、窗口里
// 永远是「连不上」。这个脚本按插件装载时的同一顺序起服务、再拉窗口。
//
// 用法：node tools/dev/hud.mjs            （默认端口 3477，Ctrl+C 一起停）
//       node tools/dev/hud.mjs --port 3493 --no-hud   （只起页面服务）
import { spawn } from "node:child_process";
import { desktopBinary, launchDesktop, desktopAlive } from "../../lib/desktop.mjs";
import { startPageService, stopPageServices, pageServicePort } from "../../lib/pageservice.mjs";
import { bridgeEngine } from "../../lib/engine.mjs";

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const port = portArg >= 0 ? Number(argv[portArg + 1]) : pageServicePort();
if (!Number.isInteger(port) || port < 1) {
  console.error("端口不对：" + port);
  process.exit(2);
}
const wantHud = !argv.includes("--no-hud");

const engine = await bridgeEngine();
const service = await startPageService({ port }, engine);
if (!service || service.error) {
  console.error("页面服务没起来：" + (service?.error ?? "没有配置端口"));
  process.exit(1);
}
console.log(`页面： http://127.0.0.1:${port}/`);
console.log(`接口： http://127.0.0.1:${port}/api/state`);

let hudPid = null;
if (wantHud) {
  const bin = desktopBinary();
  if (!bin) {
    console.log("没有桌面 HUD 二进制：只起了页面。");
  } else {
    const res = launchDesktop({ port });
    if (!res.started) console.log("HUD 没起来：" + res.reason);
    else {
      hudPid = res.pid;
      console.log(`HUD： ${bin}（pid ${hudPid}）`);
      // 建进程 ≠ 出窗：2 秒后回看一眼，起不来就说清是哪一步
      setTimeout(() => {
        if (!desktopAlive(hudPid)) console.log("HUD 进程 2 秒内退出了——看它自己的输出或 .failed 标记");
      }, 2000).unref?.();
    }
  }
}

const shutdown = async () => {
  if (hudPid && desktopAlive(hudPid)) {
    try { process.kill(hudPid); } catch { /* 已经没了 */ }
  }
  await stopPageServices();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// 常驻，直到 Ctrl+C：没有这一步进程会因为事件循环空掉而退出
setInterval(() => {}, 1 << 30);
