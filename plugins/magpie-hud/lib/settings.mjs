// 鹊楼的设置：桌面 HUD 的位置、尺寸、透明度、刘海模式、显示哪些分区。
//
// 谁读它：
//   - 桌面桥（desktop/main.go）读 /api/settings 决定窗口贴哪、多大；
//   - 页面（webapp/app.js）读同一份决定透明度、刘海圆角、显示哪些分区。
// 一份设置两个消费者，避免「窗口在左边、页面以为自己在顶部」这类错位。
//
// 位置取值：
//   top-center / top-left / top-right  贴屏幕顶部（刘海模式再贴紧 0）
//   left / right                       贴屏幕左/右缘，垂直居中
//   custom                             用户拖过，用 x/y
//
// 落盘在 <home>/.magpie-agents/hud-settings.json，原子整写（照 journal）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentsRoot, atomicWriteJson } from "./delivery/claude.mjs";

export const POSITIONS = ["top-center", "top-left", "top-right", "left", "right", "custom"];

export const DEFAULTS = {
  enabled: true,        // 是否拉起桌面桥
  position: "top-center",
  screen: "",           // "" = 主屏；否则是显示器 ID（桥上报的）
  x: 0,
  y: 0,
  // autoShape 为真时尺寸由吸附边决定（顶部宽扁、侧边窄高），width/height 只作参考
  autoShape: true,
  theme: "auto",        // auto（跟 magpie 的 theme） | dark | light
  width: 560,
  height: 160,
  opacity: 0.94,        // 0.4 – 1
  notch: false,         // 刘海屏：贴顶、上方直角下方圆角
  alwaysOnTop: true,
  sections: { quotas: true, tokens: true, sessions: true, journal: true },
  agents: [],           // 只显示这些客户端（空 = 全部）；值是 client id，如 "dsh"
  hudAgents: [],        // 桌面 HUD 里 agent 芯片的顺序（用户在 HUD 内拖动排序后写回）
  onlyActive: false,    // 只看活跃（在跑 / 等你 / 最近 2 小时有动静）
  showAllProviders: false, // 额度区是否显示「没在用」的 provider（默认只显示在用的）
};

function settingsPath() {
  return process.env.MAGPIE_HUD_SETTINGS || join(agentsRoot(), "hud-settings.json");
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const int = (v, def, lo, hi) => (Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : def);

// 把任意输入收敛成合法设置：坏值一律回默认，不让一个手改的 JSON 把 HUD 搞崩。
export function sanitize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sections = r.sections && typeof r.sections === "object" ? r.sections : {};
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULTS.enabled,
    position: POSITIONS.includes(r.position) ? r.position : DEFAULTS.position,
    screen: typeof r.screen === "string" ? r.screen.slice(0, 128) : DEFAULTS.screen,
    x: int(r.x, DEFAULTS.x, -10000, 10000),
    y: int(r.y, DEFAULTS.y, -10000, 10000),
    width: int(r.width, DEFAULTS.width, 240, 900),
    height: int(r.height, DEFAULTS.height, 120, 900),
    opacity: typeof r.opacity === "number" && Number.isFinite(r.opacity) ? clamp(r.opacity, 0.4, 1) : DEFAULTS.opacity,
    notch: typeof r.notch === "boolean" ? r.notch : DEFAULTS.notch,
    alwaysOnTop: typeof r.alwaysOnTop === "boolean" ? r.alwaysOnTop : DEFAULTS.alwaysOnTop,
    sections: {
      quotas: typeof sections.quotas === "boolean" ? sections.quotas : DEFAULTS.sections.quotas,
      tokens: typeof sections.tokens === "boolean" ? sections.tokens : DEFAULTS.sections.tokens,
      sessions: typeof sections.sessions === "boolean" ? sections.sessions : DEFAULTS.sections.sessions,
      journal: typeof sections.journal === "boolean" ? sections.journal : DEFAULTS.sections.journal,
    },
    // 只留已知形态的客户端 id，去重、限长
    onlyActive: typeof r.onlyActive === "boolean" ? r.onlyActive : DEFAULTS.onlyActive,
    showAllProviders: typeof r.showAllProviders === "boolean" ? r.showAllProviders : DEFAULTS.showAllProviders,
    autoShape: typeof r.autoShape === "boolean" ? r.autoShape : DEFAULTS.autoShape,
    theme: ["auto", "dark", "light"].includes(r.theme) ? r.theme : DEFAULTS.theme,
    // 芯片顺序：只留形如 id 的字符串，去重、限长（HUD 会反复写它）
    hudAgents: Array.isArray(r.hudAgents)
      ? [...new Set(r.hudAgents.filter((v) => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(v)))].slice(0, 24)
      : [],
    agents: Array.isArray(r.agents)
      ? [...new Set(r.agents.filter((v) => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(v)))].slice(0, 24)
      : [],
  };
}

export function readSettings() {
  try {
    if (existsSync(settingsPath())) return sanitize(JSON.parse(readFileSync(settingsPath(), "utf8")));
  } catch { /* 坏文件当默认 */ }
  return { ...DEFAULTS, sections: { ...DEFAULTS.sections } };
}

// 合并式写入：只覆盖传进来的字段，其余保留。
export function writeSettings(patch) {
  const next = sanitize({ ...readSettings(), ...(patch && typeof patch === "object" ? patch : {}) });
  atomicWriteJson(settingsPath(), next);
  return next;
}

export { settingsPath };
