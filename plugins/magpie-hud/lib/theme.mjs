// 主题来源：magpie 自己的设置（~/.config/magpie/settings.json 的 theme）。
//
// magpie 只把主题作为 CSS 变量注入它自己服务的页面；鹊楼的面板由 magpie 服务时能拿到，
// 但桌面 HUD 由 wails 服务（http://wails.localhost），拿不到那些变量。所以统一走
// 「读文件 → 返回给页面 → 页面自己套 data-theme」，两条呈现路径一致。
//
// 取值：system | light | dark（magpie 的定义）。system 由页面用 prefers-color-scheme 判定。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function settingsPaths() {
  const home = homeDir();
  const out = [];
  if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, "magpie", "settings.json"));
  out.push(join(home, ".config", "magpie", "settings.json"));
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, "magpie", "settings.json"));
  return out;
}

/**
 * magpie 当前的主题设置。
 * @returns {{theme: "system"|"light"|"dark", textSize: number|null, path: string|null}}
 */
export function hostTheme() {
  const path = settingsPaths().find((p) => existsSync(p)) ?? null;
  if (!path) return { theme: "system", textSize: null, path: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const theme = ["system", "light", "dark"].includes(j?.theme) ? j.theme : "system";
    const textSize = typeof j?.textSize === "number" && j.textSize >= 80 && j.textSize <= 200 ? j.textSize : null;
    return { theme, textSize, path };
  } catch {
    return { theme: "system", textSize: null, path };
  }
}
