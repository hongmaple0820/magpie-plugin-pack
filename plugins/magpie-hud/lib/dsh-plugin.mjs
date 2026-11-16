// 把通道插件装进 DSH：写一个 .mjs，再在 cordis.patch.yml 里加一段托管行。
//
// 为什么是「托管段」而不是直接往列表里塞：cordis.patch.yml 是用户自己的
// 文件，里面可能已经有别的东西（本机就有 figma-mcp 的一段）。只认自己那
// 对标记、只删自己那一段，用户随时可以手工把这段删掉——那也算卸载干净。
//
// 安装是显式动作（设置页按钮 / 命令行），不在插件启动时偷偷做：这段代码
// 会进到 DSH 的进程里，用户有权先看到它。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(HERE, "..", "dsh", "magpie-hud.mjs");
export const START_MARK = "# --- magpie-hud managed (auto-generated; do not edit) ---";
export const END_MARK = "# --- end magpie-hud managed ---";
export const PLUGIN_ID = "magpie-hud-plugin";

export function dshHome(env = process.env) {
  const given = env.DSH_HOME;
  if (typeof given === "string" && isAbsolute(given)) return given;
  return join(homedir(), ".dsh");
}

export function targets(env = process.env) {
  const home = dshHome(env);
  return { home, plugin: join(home, "magpie-hud.mjs"), patch: join(home, "cordis.patch.yml") };
}

function quotePath(value) {
  // YAML 单引号串：反斜杠在单引号里是字面量，但路径统一用正斜杠更保险。
  return "'" + String(value).replace(/\\/g, "/").replace(/'/g, "''") + "'";
}

export function blockFor(pluginPath, channel) {
  return [
    START_MARK,
    "- insert:",
    "    - id: " + PLUGIN_ID,
    "      name: " + quotePath(pluginPath),
    "      config:",
    "        channel: " + quotePath(channel),
    END_MARK,
    "",
  ].join("\n");
}

export function stripBlock(text) {
  // 清掉**所有**自己那几段：装过两次、或换过路径，都不该留下一串死插件。
  let out = text;
  let found = false;
  for (;;) {
    const i = out.indexOf(START_MARK);
    if (i < 0) break;
    const j = out.indexOf(END_MARK, i);
    if (j < 0) return { text, found: true, truncated: true }; // 只有开头标记：不敢动，报给用户
    found = true;
    const before = out.slice(0, i).replace(/\n+$/, "");
    const after = out.slice(j + END_MARK.length).replace(/^[ \t]*\r?\n/, "");
    out = before && after ? before + "\n\n" + after : before + after;
  }
  out = out.replace(/\s+$/, "");
  return { text: out ? out + "\n" : "", found, truncated: false };
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, text);
  try {
    if (existsSync(file)) unlinkSync(file + ".bak-magpie-hud");
    if (existsSync(file)) copyFileSync(file, file + ".bak-magpie-hud");
  } catch {}
  renameSync(tmp, file);
}

export function status(env = process.env, channel) {
  const t = targets(env);
  const patch = existsSync(t.patch) ? readFileSync(t.patch, "utf8") : "";
  const fileThere = existsSync(t.plugin);
  const loaded = patch.includes(START_MARK) && patch.includes(PLUGIN_ID);
  let fresh = false;
  if (fileThere && existsSync(SOURCE)) {
    try {
      fresh = readFileSync(t.plugin, "utf8") === readFileSync(SOURCE, "utf8");
    } catch {}
  }
  return {
    dshHome: t.home,
    pluginPath: t.plugin,
    patchPath: t.patch,
    fileThere,
    loaded,
    upToDate: fileThere && fresh,
    patched: loaded, // 装好了但要重启 DSH 才生效
    needsRestart: loaded && !fresh ? true : loaded,
    channel: channel ?? null,
  };
}

export function install(channel, env = process.env) {
  const t = targets(env);
  if (!existsSync(SOURCE)) return { ok: false, error: "插件源文件不在包里：" + SOURCE };
  if (!channel || !isAbsolute(channel)) return { ok: false, error: "通道目录必须是绝对路径。" };
  try {
    mkdirSync(t.home, { recursive: true });
    writeAtomic(t.plugin, readFileSync(SOURCE, "utf8"));
  } catch (error) {
    return { ok: false, error: "写不进 " + t.home + "：" + String(error?.message ?? error) };
  }
  const current = existsSync(t.patch) ? readFileSync(t.patch, "utf8") : "# dsh home patch layer\n";
  const stripped = stripBlock(current);
  if (stripped.truncated) {
    return { ok: false, error: "cordis.patch.yml 里有我们的开头标记却没有结尾标记，请手改后再装。", patchPath: t.patch };
  }
  const next = stripped.text.replace(/\s*$/, "") + "\n\n" + blockFor(t.plugin, channel);
  try {
    writeAtomic(t.patch, next);
  } catch (error) {
    return { ok: false, error: "写不进 cordis.patch.yml：" + String(error?.message ?? error) };
  }
  return { ok: true, ...status(env, channel), needsRestart: true };
}

export function uninstall(env = process.env) {
  const t = targets(env);
  const current = existsSync(t.patch) ? readFileSync(t.patch, "utf8") : "";
  if (current) {
    const stripped = stripBlock(current);
    if (stripped.truncated) return { ok: false, error: "cordis.patch.yml 里的托管段不完整，请手改。" };
    if (stripped.found) {
      try {
        writeAtomic(t.patch, stripped.text);
      } catch (error) {
        return { ok: false, error: "改不动 cordis.patch.yml：" + String(error?.message ?? error) };
      }
    }
  }
  try {
    if (existsSync(t.plugin)) unlinkSync(t.plugin);
  } catch {}
  return { ok: true, ...status(env) };
}

// 命令行：node lib/dsh-plugin.mjs status|install|uninstall [channel]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , action = "status", channelArg] = process.argv;
  const channel = channelArg || join(homedir(), ".magpie-agents", "channel");
  const out =
    action === "install" ? install(channel) : action === "uninstall" ? uninstall() : status(process.env, channel);
  console.log(JSON.stringify(out, null, 2));
}
