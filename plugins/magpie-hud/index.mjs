// 鹊楼 (magpie-hud)：本机 AI coding agent 的桌面 HUD，一个插件两半。
//
// 面板半：magpie 窗口里的页面 + 本地 HTTP 服务（lib/pageservice.mjs，
// 安全形状与启动协议见彼处注释）。
// 工具半：五个 MCP 工具（lib/tools.mjs）经 magpie 的插件工具 MCP 服务
// 器（internal/gateway/tools_mcp.go，/mcp/magpie/tools）对所有能接 MCP
// 的 agent 可用：list_sessions / send_message / start_session /
// get_message / list_quotas。语义照 Agent HUD（F:/maple/agent-hud-open，
// 仅参考不修改）的 messaging crate。
// 数据引擎（会话扫描 / journal / 额度）在本插件 lib 里，两半共用；
// 引擎加载失败只降级面板（requires），工具半照常返回。
//
// 入口只导出这一个插件函数：host 把入口导出的每个函数都当作一个插件
// 运行（magpie-nest 同款约定），多导出一个辅助函数都会被当成插件跑掉。
import { AGENTS_TOOLS } from "./lib/tools.mjs";
import { startPageService } from "./lib/pageservice.mjs";
import { bridgeEngine, startQuotaSampler } from "./lib/engine.mjs";
import { desktopAlive, desktopWanted, launchDesktop, noteLaunch } from "./lib/desktop.mjs";

export const MagpieHudPlugin = async (input, options) => {
  const engine = await bridgeEngine();
  const service = await startPageService(options, engine);
  if (service?.error) console.error("magpie-hud page service:", service.error);
  if (engine) startQuotaSampler(engine); // 额度时序：10 分钟一采

  // 原生 HUD 桥：装好插件就把系统级桌面 HUD 拉起来（option desktop:false 可关）
  // enabled:false 是持久开关（用户在设置页关掉 HUD），优先级高于默认开启
  let hudSettings = null;
  try {
    const { readSettings } = await import("./lib/settings.mjs");
    hudSettings = readSettings();
  } catch { /* 设置读不到就当没关 */ }
  if (service?.port && desktopWanted(options, hudSettings)) {
    const hud = noteLaunch({ wanted: true, ...launchDesktop({ port: service.port }) });
    if (hud.started) {
      console.error("magpie-hud desktop: started pid " + hud.pid + " (" + hud.bin + ")");
      // 创建了进程 ≠ 窗口出现了：2 秒后回看一眼，死掉就如实报（失败标记由 lib/desktop.mjs 落盘）。
      setTimeout(() => {
        if (!desktopAlive(hud.pid)) console.error("magpie-hud desktop: process exited within 2s; check the .failed mark beside the plugin");
      }, 2000).unref?.();
    } else if (/no binary/.test(hud.reason ?? "")) { /* 没装桥，静默 */ }
    else console.error("magpie-hud desktop: " + hud.reason);
  } else if (service?.port) {
    // 用户关掉了（或环境变量/option 禁用）：面板上要能看出「不是坏了，是关了」
    noteLaunch({ wanted: false, started: false, reason: "已按设置关闭" });
  }
  return { tool: AGENTS_TOOLS };
};
