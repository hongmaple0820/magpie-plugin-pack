// 通道：鹊楼与 DSH 之间的那一叠文件（协议见 dsh/magpie-hud.mjs 的注释）。
//
// 这一侧只做三件事：签到（让插件知道面板有人在看）、读卡（审批/提问）、
// 写答复与下发话。所有校验都在这儿做一遍——插件那边也会校验，但错在
// 这一侧才是我的 bug，不该让用户看见「点了没用」。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const APP_LIFETIME_MS = 10_000; // 与插件一致
const ASK_STALE_MS = 10 * 60 * 1000;

export function channelRoot(env = process.env) {
  const given = env.MAGPIE_HUD_CHANNEL;
  if (typeof given === "string" && isAbsolute(given)) return given;
  return join(homedir(), ".magpie-agents", "channel");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
}

function list(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function ageOf(at) {
  const n = Number(at);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Date.now() - n) : null;
}

// 面板心跳：插件据此决定「有人看着，值得等」。
export function beat(root = channelRoot()) {
  return writeJson(join(root, "app.json"), { at: Date.now(), pid: process.pid, channelVersion: 1 });
}

export function pluginHeartbeat(root = channelRoot()) {
  return readJson(join(root, "plugin.json"));
}

// 通道整体状况：面板顶部那行「通道在线 / 未安装」就靠它。
export function channelStatus(root = channelRoot()) {
  const plugin = pluginHeartbeat(root);
  const at = Number(plugin?.at);
  const online = Number.isFinite(at) && ageOf(at) < APP_LIFETIME_MS * 3;
  const sessions = list(join(root, "sessions")).filter((f) => f.endsWith(".json"));
  const asks = list(join(root, "asks")).filter((f) => f.endsWith(".json") && !f.includes(".tmp"));
  return {
    dir: root,
    installed: Boolean(plugin),
    online,
    plugin: plugin ? { at, host: String(plugin.host ?? ""), pid: plugin.pid ?? null, ageMs: ageOf(at) } : null,
    sessions: sessions.length,
    asks: asks.length,
  };
}

// 正在开着的根会话（插件 5 秒续签一次，20 秒没动静就当关了）。
export function liveSessions(root = channelRoot()) {
  const out = [];
  for (const file of list(join(root, "sessions"))) {
    if (!file.endsWith(".json") || file.includes(".tmp")) continue;
    const row = readJson(join(root, "sessions", file));
    if (!row || typeof row.id !== "string") continue;
    const ageMs = ageOf(row.at);
    const endedAt = Number(row.ended);
    out.push({
      id: row.id,
      at: Number(row.at) || null,
      ageMs,
      host: String(row.host ?? ""),
      ended: Number.isFinite(endedAt) && endedAt > 0,
      endedAt: Number.isFinite(endedAt) && endedAt > 0 ? endedAt : null,
      live: !row.ended && ageMs != null && ageMs < 20_000,
    });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function pendingAsks(root = channelRoot()) {
  const out = [];
  for (const file of list(join(root, "asks"))) {
    if (!file.endsWith(".json") || file.includes(".tmp")) continue;
    const ask = readJson(join(root, "asks", file));
    if (!ask || typeof ask.id !== "string") continue;
    const ageMs = ageOf(ask.at);
    out.push({
      id: ask.id,
      kind: ask.kind === "question" ? "question" : "approval",
      sessionId: String(ask.sessionId ?? ""),
      host: String(ask.host ?? ""),
      at: Number(ask.at) || null,
      ageMs,
      stale: ageMs != null && ageMs > ASK_STALE_MS,
      toolName: typeof ask.toolName === "string" ? ask.toolName : "",
      callId: typeof ask.callId === "string" ? ask.callId : "",
      reason: typeof ask.reason === "string" ? ask.reason : "",
      displayReason: {
        zh: String(ask.displayReason?.zh ?? ""),
        en: String(ask.displayReason?.en ?? ""),
      },
      arguments: typeof ask.arguments === "string" ? ask.arguments : "",
      questions: Array.isArray(ask.questions) ? ask.questions : [],
      timed: ask.timed === true,
      answered: null,
    });
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

// 答复：形状必须与插件侧的 acceptAnswer 完全一致，否则它会当成没答，
// 用户看到的是「点了同意，卡还在」。
export function answerAsk(id, value, root = channelRoot()) {
  if (typeof id !== "string" || !/^ask_[A-Za-z0-9]{1,40}$/.test(id)) return { ok: false, error: "卡 id 不合法。" };
  const ask = readJson(join(root, "asks", id + ".json"));
  if (!ask) return { ok: false, error: "这张卡已经不在等回答了。" };
  if (ask.kind === "approval") {
    if (value !== "allowed-once" && value !== "rejected") return { ok: false, error: "审批只有同意或拒绝两种答案。" };
  } else {
    const answers = Array.isArray(value?.answers) ? value.answers : null;
    const wanted = Array.isArray(ask.questions) ? ask.questions : [];
    if (!answers || answers.length !== wanted.length) return { ok: false, error: "这组问题要每题都有一个答案。" };
    for (const item of answers) {
      if (!item || typeof item.id !== "string") return { ok: false, error: "答案缺少题号。" };
      if (!wanted.some((q) => q.id === item.id)) return { ok: false, error: "答案里有这道题没有的题号。" };
      if (!Array.isArray(item.selected) || item.selected.some((s) => typeof s !== "string")) {
        return { ok: false, error: "选项答案必须是字符串数组。" };
      }
    }
  }
  const ok = writeJson(join(root, "asks", id + ".answer"), { value, at: Date.now(), by: "panel" });
  if (!ok) return { ok: false, error: "写不进通道目录（权限或磁盘）。" };
  try {
    appendFileSync(
      join(root, "asks.log.jsonl"),
      JSON.stringify({ at: Date.now(), id, kind: ask.kind, sessionId: ask.sessionId, by: "panel" }) + "\n",
    );
  } catch {}
  return { ok: true };
}

// 下发一句话：写 prompts/<session>/<seq>.json，插件下一拍（≤1 秒）投进会话。
export function promptSession(sessionId, text, options = {}, root = channelRoot()) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return { ok: false, error: "会话 id 不合法。" };
  }
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) return { ok: false, error: "消息不能为空。" };
  if (body.length > 8000) return { ok: false, error: "消息太长（上限 8000 字）。" };
  const id = String(Date.now()) + "-" + randomUUID().replace(/-/g, "").slice(0, 8);
  const row = { id, text: body, at: Date.now() };
  if (Number.isFinite(options.expiresAt)) row.expiresAt = Number(options.expiresAt);
  const file = join(root, "prompts", sessionId, id + ".json");
  if (!writeJson(file, row)) return { ok: false, error: "写不进通道目录（权限或磁盘）。" };
  return { ok: true, id, file, text: body };
}

// 读回投递结果：面板要能说清「已送达 / 被拒 / 没送出去」。
// 状态机（docs/magpie-hud-truth-model.md §6）：queued → accepted → delivered
// → effective；accepted 只是「宿主收下了」，绝不当成送达。
export function promptResult(sessionId, id, root = channelRoot()) {
  const row = readJson(join(root, "prompts", sessionId, id + ".json"));
  if (!row) return { state: "unknown" };
  if (row.state === "effective") return { state: "effective", seq: row.deliveredSeq ?? null, at: row.effectiveAt ?? null };
  if (row.state === "delivered") return { state: "delivered", seq: row.deliveredSeq ?? null, at: row.deliveredAt ?? null };
  if (row.state === "timeout") return { state: "timeout", reason: String(row.reason ?? "会话里一直没出现这条话") };
  if (row.state === "failed") return { state: "failed", reason: String(row.reason ?? "") };
  if (row.state === "accepted") return { state: "accepted" };
  // 旧文件（没有 state 字段）：按老字段尽力翻译，但 startedAt 只算 accepted。
  if (row.failed) return { state: "failed", reason: String(row.reason ?? "") };
  if (row.refused) return { state: "failed", reason: String(row.reason ?? "") };
  if (row.expiredAt) return { state: "expired" };
  if (row.cancelledAt) return { state: "cancelled" };
  if (row.startedAt) return { state: "accepted" };
  if (row.takenAt) return { state: "sending" };
  return { state: "queued" };
}

// 面板的活动流水（谁在什么时候答了什么）。最多 40 条。
export function activity(root = channelRoot(), limit = 40) {
  let text = "";
  try {
    const stat = statSync(join(root, "asks.log.jsonl"));
    // 只读尾部：日志会一直长，别把整份读进内存。
    const start = Math.max(0, stat.size - 64 * 1024);
    const fd = readFileSync(join(root, "asks.log.jsonl"));
    text = fd.subarray(start).toString("utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = readJson2(line);
    if (row) rows.push(row);
  }
  return rows.slice(-limit).reverse();
}

function readJson2(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const CHANNEL_META = { appLifetimeMs: APP_LIFETIME_MS, askStaleMs: ASK_STALE_MS };
