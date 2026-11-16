// Claude Code 投递通道：鹊桥与 Claude Code 插件共享的文件夹协议。
//
// 协议照 Agent HUD 的 claude_plugin（channel.rs + mod.rs，仅参考不修改）：
//   <channel>/sessions/<sessionId>.json      会话签到：插件每 5 秒写
//                                            {at,version,channelVersion}，20 秒内有效；
//                                            session.end 写 {ended}。
//   <channel>/prompts/<sessionId>/<id>.json  留言 {id,text,at,expiresAt,asUser}（1 小时有效）。
//                                            插件认领后整文件改写为 {takenAt}，提交后
//                                            {takenAt,startedAt} 或 {takenAt,refused}；
//                                            过期为 {expiredAt}，撤回确认为 {cancelledAt}。
//   <channel>/prompts/<sessionId>/<id>.cancel 撤回请求（仅未认领时可撤）。
// 通道位置：MAGPIE_AGENTS_CHANNEL 覆盖，默认 <home>/.magpie-agents/channel
//（home 本身可被 MAGPIE_AGENTS_HOME 覆盖，测试用）。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// 钩子脚本本体：preparePlugin 把通道路径替换进去后写进插件文件夹。
const REGISTER_TS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "claude-plugin", "register.ts"), "utf8");

// 会话 20 秒没签到就不再认为它在跑插件（照 CHECK_IN_LIFETIME）。
export const CHECK_IN_LIFETIME_MS = 20_000;
// 留言 1 小时没被取走就过期（照 PROMPT_LIFETIME）。
export const PROMPT_LIFETIME_MS = 3_600_000;

export function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

// 鹊桥的根目录：签到、留言、journal、Claude Code 插件文件都在这下面。
export function agentsRoot() {
  return join(homeDir(), ".magpie-agents");
}

export function channelDir() {
  return process.env.MAGPIE_AGENTS_CHANNEL || join(agentsRoot(), "channel");
}

// Claude Code 插件文件夹（用户 claude plugin install 的 marketplace 来源）。
export function pluginFolder() {
  return join(agentsRoot(), "claude-plugin");
}

// 会话或留言身份能当文件名用（照 valid_name）。
export function validName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function privateDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// 整文件替换：先写临时文件再改名，读者永远看不到半个 JSON（照 atomic_json）。
export function atomicWriteJson(path, value) {
  const text = JSON.stringify(value);
  privateDir(dirname(path));
  const temp = join(dirname(path), `.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* 清理失败就算了 */ }
    throw error;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fileAgeMs(path, now) {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

// 现在还在跑插件的会话（20 秒内签过到且未 ended）。
export function loaded(now = Date.now()) {
  const dir = join(channelDir(), "sessions");
  if (!existsSync(dir)) return new Set();
  const out = new Set();
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!validName(id)) continue;
    const path = join(dir, entry.name);
    const age = Math.max(0, fileAgeMs(path, now));
    if (age >= CHECK_IN_LIFETIME_MS) continue;
    const value = readJson(path);
    if (value && value.ended === undefined) out.add(id);
  }
  return out;
}

// 某会话最后一次签到（不管多久前）；从未签到或已 ended 为 null。
export function lastCheckIn(session) {
  if (!validName(session)) return null;
  const path = join(channelDir(), "sessions", `${session}.json`);
  try {
    const value = readJson(path);
    if (!value || value.ended !== undefined) return null;
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function promptPath(session, id) {
  if (!validName(session) || !validName(id)) {
    throw new Error("identity");
  }
  return join(channelDir(), "prompts", session, `${id}.json`);
}

// 给会话留言（调用方先确认它在 loaded 里）。同一 id 用过会拒绝。
export function leave(session, id, text, asUser, now = Date.now()) {
  const file = promptPath(session, id);
  if (existsSync(file)) throw new Error("This identity was used before");
  atomicWriteJson(file, {
    id,
    text,
    at: now,
    expiresAt: now + PROMPT_LIFETIME_MS,
    asUser: asUser === true,
  });
}

// 留言现在处于什么状态（照 PromptState 状态机）；没有这个文件为 null。
// 返回 {state, reason}：state ∈ waiting|cancelRequested|taken|started|refused|cancelled|expired。
export function state(session, id, now = Date.now()) {
  let value;
  try {
    value = JSON.parse(readFileSync(promptPath(session, id), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  const reason = typeof value.refused === "string" ? value.refused : null;
  let s;
  if (value.cancelledAt !== undefined) s = "cancelled";
  else if (value.expiredAt !== undefined) s = "expired";
  else if (value.refused !== undefined) s = "refused";
  else if (value.startedAt !== undefined) s = "started";
  else if (value.takenAt !== undefined) s = "taken";
  else if (typeof value.expiresAt === "number" && value.expiresAt <= now) s = "expired";
  else if (existsSync(promptPath(session, id).replace(/\.json$/, ".cancel"))) s = "cancelRequested";
  else s = "waiting";
  return { state: s, reason };
}

// 清扫：签到超一天删；留言被取走超 1 分钟、或超 1 小时删；空目录删（照 sweep）。
export function sweep(now = Date.now()) {
  const root = channelDir();
  const sessionsDir = join(root, "sessions");
  if (existsSync(sessionsDir)) {
    let entries;
    try { entries = readdirSync(sessionsDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (fileAgeMs(join(sessionsDir, entry.name), now) > 86_400_000) {
        try { rmSync(join(sessionsDir, entry.name), { force: true }); } catch { /* 下次再清 */ }
      }
    }
  }
  const promptsDir = join(root, "prompts");
  if (existsSync(promptsDir)) {
    let folders;
    try { folders = readdirSync(promptsDir, { withFileTypes: true }); } catch { folders = []; }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const dir = join(promptsDir, folder.name);
      let files;
      try { files = readdirSync(dir, { withFileTypes: true }); } catch { files = []; }
      for (const file of files) {
        const path = join(dir, file.name);
        const age = fileAgeMs(path, now);
        const taken = readJson(path)?.takenAt !== undefined;
        if (age > PROMPT_LIFETIME_MS || (taken && age > 60_000)) {
          try { rmSync(path, { force: true }); } catch { /* 下次再清 */ }
        }
      }
      try { rmSync(dir); } catch { /* 非空就留着 */ }
    }
  }
}

// 鹊桥自带的 Claude Code 插件文件（照 prepare_plugin）：marketplace + 插件清单
// + hooks 指向 register.ts，通道路径替换进脚本。只写有差异的文件，返回是否改动。
export function preparePlugin(folder = pluginFolder()) {
  privateDir(join(channelDir(), "sessions"));
  privateDir(join(channelDir(), "prompts"));
  const channel = JSON.stringify(channelDir());
  const script = REGISTER_TS.replace("__MAGPIE_AGENTS_CHANNEL_JSON__", channel);
  const files = [
    [".claude-plugin/marketplace.json", JSON.stringify({ name: "magpie-agents", owner: { name: "magpie-agents" }, plugins: [{ name: "magpie-agents", source: "./" }] })],
    [".claude-plugin/plugin.json", JSON.stringify({ name: "magpie-agents", version: "1.0.0", description: "Delivers messages queued by the magpie-agents plugin to this existing session.", author: { name: "magpie-agents" } })],
    ["hooks/hooks.json", JSON.stringify({ modules: ["./register.ts"] })],
    ["hooks/register.ts", script],
  ];
  privateDir(folder);
  let changed = false;
  for (const [relative, text] of files) {
    const file = join(folder, relative);
    privateDir(dirname(file));
    let current = "";
    try { current = readFileSync(file, "utf8"); } catch { /* 还没有 */ }
    if (current === text) continue;
    writeFileSync(file, text, "utf8");
    changed = true;
  }
  return changed;
}
