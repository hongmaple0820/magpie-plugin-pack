// 鹊楼通道插件（DSH 侧）：让鹊楼能「看见并在原地回答」agent 的审批与提问。
//
// 为什么需要它：本插件（magpie-hud）跑在 magpie 里，是另一个进程；DSH 的
// 会话、审批、提问全在 DSH 进程内存里，文件系统上只有一个只读转录。所以
// 「读」能靠读文件，「写」不能——除非 DSH 自己也加载一小段代码。这段代码就
// 是它：由鹊楼写进 $DSH_HOME 并在 cordis.patch.yml 里加一段托管行，DSH 的
// 每个宿主（含桌面端）启动时都会加载；删掉那一段即卸载。
//
// 协议（全部是文件和轮询，不引入任何依赖，也不假设 DSH 内部 API 稳定）：
//   channel/plugin.json            插件活着的心跳（15 秒一次）
//   channel/app.json               鹊楼面板活着的心跳（面板每 5 秒写）
//   channel/sessions/<id>.json     打开的会话每 5 秒签到 {at,host,channelVersion}
//   channel/prompts/<id>/<n>.json  鹊楼要发给某会话的话，插件排为它的下一条消息
//   channel/asks/<id>.json         会话正在等的问题/审批
//   channel/asks/<id>.answer       鹊楼写的答复——**先到的答复获胜**，DSH 里
//                                  那张卡随即被 AbortSignal 收走
//   channel/asks.log.jsonl         谁答的、答了什么（面板的活动流水）
//
// 铁律（照 Agent HUD 的 deepseek_plugin 踩过的坑）：
//   1. 只用 ctx 与 Node 内建模块——profile 之外的 import 会失败；
//   2. 逃出 timer/promise 的异常会整只宿主挂掉，所以每个回调自己 catch；
//   3. apply 永不抛出；模块顶层只做常量与函数声明。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

const CHANNEL_VERSION = 1;
const CHECK_IN_MS = 5000; // 会话签到
const ANSWER_POLL_MS = 250; // 读鹊楼写下的答复：要快，用户在屏幕前等
const PROMPT_POLL_MS = 1000; // 读鹊楼要下发的话
const APP_LIFETIME_MS = 10000; // 面板心跳多久算「没人看」
const ASK_TTL_MS = 10 * 60 * 1000; // 面板不在时最多陪等 10 分钟
const ARGUMENTS_LIMIT = 8000;
const MCP_PREFIXES = ["mcp__magpie-hud__", "mcp__magpie__"];
// tap：进程内看到的事件，原样抄一份小的到 channel/tap/<session>.jsonl。
// 这是「转录之外的第二证据源」——转录可能滞后或读不懂，tap 不会。
// 只留真值判定要用的字段，单事件钉在 1KB 内；单文件 8MB 封顶，超了滚动。
const TAP_MAX_BYTES = 8 * 1024 * 1024;
const TAP_TEXT_LIMIT = 800;
// 会话 id 会变成文件名：只收这几种字符，别的一律不碰。
const NAME = /^[A-Za-z0-9_-]{1,128}$/;

const HOST = (() => {
  try {
    return String(hostname() || "host").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "host";
  } catch {
    return "host";
  }
})();

function nowMs() {
  return Date.now();
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 先写临时文件再改名：读者永远看不到半个 JSON。
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

function drop(file) {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// 只有「用户对话的根会话」才归我们管：子 agent 的审批由父会话转述，
// 两条通道同时出卡会把同一件事问两遍。
function isRoot(agent) {
  try {
    const id = agent?.id;
    if (typeof id !== "string" || !NAME.test(id)) return false;
    return !agent.parent && !agent.parentId;
  } catch {
    return false;
  }
}

// DSH 的会话服务：名字在 cordis 里叫 sessionController。三种拿法都试，
// 因为宿主版本之间注入方式不完全一致。
function resolveController(ctx) {
  const tries = [
    () => (typeof ctx?.get === "function" ? ctx.get("sessionController") : null),
    () => ctx?.sessionController,
    () => ctx?.services?.sessionController,
    () => (typeof ctx?.root?.get === "function" ? ctx.root.get("sessionController") : null),
  ];
  for (const attempt of tries) {
    try {
      const found = attempt();
      if (found && typeof found.prompt === "function") return found;
    } catch {}
  }
  return null;
}

function clip(value, limit) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

// 事件里的正文可能是字符串，也可能是 [{type:"text",text}] —— 两种都要变成字。
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : clip(content, TAP_TEXT_LIMIT);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (typeof part?.text === "string") parts.push(part.text);
    if (parts.join("").length >= TAP_TEXT_LIMIT) break;
  }
  return parts.join("");
}

// tap 投影：只留判「在干什么/在等什么/答复是否生效」要用的字段。
// 形状对齐 lib/truth/fold.mjs 读的那几处（source.callId / isError / source.kind…），
// 这样 reducer 不需要认识「tap 格式」这种第二方言。
export function tapProject(event) {
  const type = typeof event?.type === "string" ? event.type : "";
  if (!type) return null;
  const seq = Number(event?.seq);
  const time = Number(event?.time);
  const d = event?.data && typeof event.data === "object" ? event.data : {};
  const row = { type, time: Number.isFinite(time) ? time : nowMs(), data: {} };
  // 会话头事件没有 seq；丢它就等于丢了 sessionId，tap 会永远判不出 starting。
  if (Number.isFinite(seq)) row.seq = seq;
  switch (type) {
    case "session":
      // 真实 session 事件把 id/cwd/createdAt 放在顶层；兼容放进 data 的形态。
      row.data = { id: event.id ?? d.id, cwd: event.cwd ?? d.cwd, createdAt: event.createdAt ?? d.createdAt };
      break;
    case "turn/start":
      row.data = { turn: d.turn };
      break;
    case "turn/end":
      row.data = { turn: d.turn, reason: { kind: d.reason?.kind ?? event.reason?.kind ?? null } };
      break;
    case "step/start":
    case "step/end":
      row.data = { turn: d.turn, step: d.step };
      break;
    case "user/message":
      row.data = {
        source: { kind: d.source?.kind ?? null },
        // 真实 v4 事件把正文放在 data.content；data.message.content 是 fold 的读法，两种都认。
        message: { content: [{ type: "text", text: clip(textOf(d.message?.content ?? d.content ?? d.text), TAP_TEXT_LIMIT) }] },
      };
      break;
    case "agent/inbox/spliced": {
      const inserted = Array.isArray(d.inserted) ? d.inserted.slice(0, 8) : [];
      row.data = {
        inserted: inserted.map((it) => ({
          source: { kind: it?.source?.kind ?? null },
          message: { content: [{ type: "text", text: clip(textOf(it?.message?.content ?? it?.content ?? it?.text), 200) }] },
        })),
      };
      break;
    }
    case "tool/call":
      row.data = { turn: d.turn, step: d.step, callId: d.callId, name: d.name, arguments: clip(d.arguments, 240) };
      break;
    case "tool/result":
      row.data = {
        turn: d.turn,
        step: d.step,
        message: {
          source: { kind: "tool", callId: d.message?.source?.callId ?? d.toolCallId ?? null },
          isError: d.message?.isError === true,
          content: [{ type: "text", text: clip(textOf(d.message?.content), TAP_TEXT_LIMIT) }],
        },
      };
      break;
    case "approval/asked":
      row.data = { id: d.id, toolName: d.toolName, callId: d.callId, reason: clip(d.reason, 300) };
      break;
    case "approval/decided":
      row.data = { id: d.id, outcome: d.outcome };
      break;
    case "job/registered":
    case "job/settled":
      row.data = { jobId: d.jobId, status: d.status ?? null, label: clip(d.label, 120) };
      break;
    case "assistant/message":
      row.data = {
        turn: d.turn,
        usage: d.usage ?? d.data?.usage ?? null,
        text: clip(textOf(d.message?.content), 200),
      };
      break;
    case "delivery-accepted":
      row.data = { throughSeq: d.throughSeq };
      break;
    default:
      row.data = {};
  }
  return row;
}


// 提问 → 卡片要的字段。options 摊平成字符串数组，别让页面再猜结构。
function questionBody(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  return {
    questions: questions.slice(0, 8).map((q) => {
      const options = Array.isArray(q?.options) ? q.options : [];
      return {
        id: String(q?.id ?? ""),
        label: clip(q?.label ?? q?.question ?? q?.title ?? "", 600),
        multiSelect: q?.multiSelect === true || q?.multiple === true,
        options: options.slice(0, 32).map((o) =>
          typeof o === "string"
            ? { value: o, label: o }
            : { value: String(o?.value ?? o?.label ?? ""), label: clip(o?.label ?? o?.value ?? "", 240) },
        ),
        intent: clip(q?.intent?.kind ?? "", 40),
      };
    }),
    timed: request?.wait?.timed === true,
  };
}

function approvalBody(request) {
  return {
    toolName: clip(request?.toolName ?? request?.tool ?? request?.name ?? "", 120),
    callId: clip(request?.callId ?? "", 120),
    reason: clip(request?.reason ?? "", 600),
    displayReason: {
      en: clip(request?.displayReason?.en ?? "", 400),
      zh: clip(request?.displayReason?.zh ?? "", 400),
    },
    arguments: clip(request?.arguments ?? "", ARGUMENTS_LIMIT),
  };
}

// 答复必须长得对：宁可当没答（继续等），也不能把半个答案塞进会话。
function acceptAnswer(ask, value) {
  // 审批只有一个字符串；提问是一个对象。别为了统一外观把其中一个包起来，
  // 包错一次的表现是「用户点了同意，会话还在等」。
  if (ask.kind === "approval") {
    return value === "allowed-once" || value === "rejected" ? value : undefined;
  }
  if (ask.kind !== "question") return undefined;
  if (!value || typeof value !== "object") return undefined;
  const answers = Array.isArray(value.answers) ? value.answers : null;
  const wanted = Array.isArray(ask.questions) ? ask.questions : [];
  if (!answers || answers.length !== wanted.length) return undefined;
  const byId = new Map(wanted.map((q) => [q.id, q]));
  const out = [];
  for (const item of answers) {
    if (!item || typeof item !== "object") return undefined;
    const id = item.id;
    if (typeof id !== "string" || !byId.has(id)) return undefined;
    if (!Array.isArray(item.selected) || item.selected.some((s) => typeof s !== "string")) return undefined;
    const row = { id, selected: item.selected.slice(0, 32) };
    if (typeof item.custom === "string" && item.custom.trim()) row.custom = item.custom.slice(0, 4000);
    out.push(row);
  }
  return { answers: out };
}

export function start(ctx, channel, options = {}) {
  const root = typeof channel === "string" ? channel : "";
  // 只接受绝对路径：相对路径会在宿主的当前目录里凭空建目录，那是事故。
  if (!root || !isAbsolute(root)) return { stop() {}, stats: () => ({ asks: 0 }) };
  const dir = {
    plugin: join(root, "plugin.json"),
    app: join(root, "app.json"),
    sessions: join(root, "sessions"),
    prompts: join(root, "prompts"),
    asks: join(root, "asks"),
    log: join(root, "asks.log.jsonl"),
    tap: join(root, "tap"),
  };
  const tick = Number.isFinite(options.checkInMs) ? Number(options.checkInMs) : CHECK_IN_MS;
  const answerPoll = Number.isFinite(options.answerPollMs) ? Number(options.answerPollMs) : ANSWER_POLL_MS;
  const promptPoll = Number.isFinite(options.promptPollMs) ? Number(options.promptPollMs) : PROMPT_POLL_MS;

  const pending = new Map(); // askId -> { ask, resolve }
  const live = new Set(); // 已知打开着的根会话：每一拍续签一次
  const timers = [];
  let stopped = false;
  let counter = 0;

  const askFile = (id) => join(dir.asks, id + ".json");
  const answerFile = (id) => join(dir.asks, id + ".answer");

  const log = (row) => {
    try {
      mkdirSync(root, { recursive: true });
      appendFileSync(dir.log, JSON.stringify({ at: nowMs(), host: HOST, ...row }) + "\n");
    } catch {}
  };

  // 抄一条事件给 tap。单文件超过 TAP_MAX_BYTES 就滚动成 .1：
  // 滚动后的文件从中间 seq 开始，读的一方用「首事件 seq」当起点，不假装完整。
  let tapReady = false;
  const tapBytes = new Map(); // file → 已写字节数（避免每条事件 stat 一次）
  const tapAppend = (sessionId, event) => {
    try {
      if (!NAME.test(sessionId)) return;
      const row = tapProject(event);
      if (!row) return;
      if (!tapReady) {
        mkdirSync(dir.tap, { recursive: true });
        tapReady = true;
      }
      const file = join(dir.tap, sessionId + ".jsonl");
      const line = JSON.stringify(row) + "\n";
      let wrote = tapBytes.get(file);
      if (wrote === undefined) {
        try {
          wrote = statSync(file).size;
        } catch {
          wrote = 0;
        }
      }
      if (wrote > TAP_MAX_BYTES) {
        try {
          renameSync(file, file + ".1");
        } catch {}
        wrote = 0;
      }
      appendFileSync(file, line);
      tapBytes.set(file, wrote + Buffer.byteLength(line));
    } catch {}
  };

  const beat = () => {
    try {
      writeJson(dir.plugin, { at: nowMs(), host: HOST, pid: process.pid, channelVersion: CHANNEL_VERSION });
    } catch {}
  };

  // 面板在不在看？不在看就不该让会话干等——DSH 自己的卡才是正路。
  const watched = () => {
    const app = readJson(dir.app);
    const at = Number(app?.at);
    return Number.isFinite(at) && nowMs() - at < APP_LIFETIME_MS;
  };

  const checkIn = (id) => {
    if (stopped || typeof id !== "string" || !NAME.test(id)) return;
    live.add(id);
    writeJson(join(dir.sessions, id + ".json"), {
      id,
      at: nowMs(),
      host: HOST,
      channelVersion: CHANNEL_VERSION,
      pid: process.pid,
    });
  };

  const end = (id) => {
    if (typeof id !== "string" || !NAME.test(id)) return;
    live.delete(id);
    writeJson(join(dir.sessions, id + ".json"), { id, ended: nowMs(), host: HOST, channelVersion: CHANNEL_VERSION });
  };

  const settle = (id) => {
    pending.delete(id);
    drop(askFile(id));
    drop(answerFile(id));
  };

  // ---- 审批 / 提问：两侧赛跑，先答的赢 ----
  const race = async (kind, request, next, body) => {
    const sessionId = request?.agent?.id;
    const ours = new AbortController();
    try {
      const original = request?.signal;
      if (original && typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
        request.signal = AbortSignal.any([original, ours.signal]);
      }
    } catch {}

    const id = "ask_" + (++counter).toString(36) + randomUUID().replace(/-/g, "").slice(0, 12);
    const ask = { id, kind, sessionId, host: HOST, at: nowMs(), channelVersion: CHANNEL_VERSION, ...body };
    writeJson(askFile(id), ask);

    let release;
    const fromHud = new Promise((resolve) => {
      release = resolve;
    });
    pending.set(id, { ask, resolve: release });

    const fromClient = (async () => {
      const out = await next();
      return { value: out };
    })();

    const first = await Promise.race([
      fromClient.then(
        (v) => ({ by: "client", ok: true, value: v?.value }),
        (e) => ({ by: "client", ok: false, error: e }),
      ),
      fromHud.then((v) => ({ by: "hud", ok: true, value: v })),
    ]);

    if (first.by === "hud") {
      try {
        ours.abort(new Error("已在鹊楼回答"));
      } catch {}
      settle(id);
      log({ id, kind, sessionId, by: "hud" });
      return first.value;
    }

    // DSH 侧先答（用户点了 DSH 自己的卡，或该工具根本没人接）：
    // 若面板开着，就继续替它等一会儿——但绝不无限等。
    const noProvider = !first.ok && /NO_PROVIDER|no provider|not provided/i.test(String(first.error?.message ?? ""));
    if (noProvider && watched()) {
      const deadline = nowMs() + ASK_TTL_MS;
      while (!stopped && nowMs() < deadline && pending.has(id)) {
        const raced = await Promise.race([
          fromHud.then((v) => ({ by: "hud", value: v })),
          new Promise((resolve) => timers.push(setTimeout(() => resolve(null), 250))),
        ]);
        if (raced?.by === "hud") {
          settle(id);
          log({ id, kind, sessionId, by: "hud" });
          return raced.value;
        }
      }
      settle(id);
      log({ id, kind, sessionId, by: "timeout" });
      throw first.error;
    }

    settle(id);
    log({ id, kind, sessionId, by: "client" });
    if (first.ok) return first.value;
    throw first.error;
  };

  const watch = (kind, bodyOf) => (request, next) => {
    let ok = false;
    try {
      ok = isRoot(request?.agent);
    } catch {
      ok = false;
    }
    if (!ok) return next();
    let body;
    try {
      body = bodyOf(request) ?? {};
    } catch {
      return next();
    }
    return race(kind, request, next, body);
  };

  // ---- 面板要下发的话 ----
  // 回执是四段状态机（见 docs/magpie-hud-truth-model.md §6）：
  //   queued → accepted（宿主收下请求）→ delivered（会话里真的出现了这条话）
  //          → effective（那一轮真的跑起来了）/ failed / timeout。
  // 「accepted」绝不能当成功渲染：入队是宿主的事，出现是会话的事。
  const DELIVER_TIMEOUT_MS = Number.isFinite(options.deliverTimeoutMs) ? Number(options.deliverTimeoutMs) : 60_000;
  const deliveries = new Map(); // session → [{ file, head, at, state, deliveredSeq }]
  const headOf = (text) => textOf(text).replace(/\s+/g, " ").trim().slice(0, 60);

  const patchPrompt = (session, file, patch) => {
    try {
      const current = readJson(join(dir.prompts, session, file));
      if (!current) return;
      writeJson(join(dir.prompts, session, file), { ...current, ...patch });
    } catch {}
  };

  const trackDelivery = (session, file, prompt) => {
    const head = headOf(prompt?.text);
    if (!head) return;
    const rows = deliveries.get(session) ?? [];
    rows.push({ file, head, at: nowMs(), state: "accepted", deliveredSeq: null });
    if (rows.length > 20) rows.shift();
    deliveries.set(session, rows);
  };

  const markDelivered = (session, row, seq) => {
    row.state = "delivered";
    row.deliveredSeq = Number.isFinite(seq) ? seq : null;
    patchPrompt(session, row.file, { state: "delivered", deliveredAt: nowMs(), deliveredSeq: row.deliveredSeq });
  };

  // 会话里的事件：话出现 → delivered；它之后的 assistant 输出 → effective。
  const noteDelivery = (session, event) => {
    const rows = deliveries.get(session);
    if (!rows || rows.length === 0) return;
    const type = String(event?.type ?? "");
    const seq = Number(event?.seq);
    if (type === "user/message" || type === "agent/inbox/spliced") {
      const data = event?.data ?? {};
      const parts = type === "user/message" ? [data?.message?.content ?? data?.text] : (Array.isArray(data.inserted) ? data.inserted.map((it) => it?.message?.content ?? it?.text) : []);
      const text = headOf(parts.map((p) => textOf(p)).join(" "));
      if (!text) return;
      for (const row of rows) {
        if (row.state === "accepted" && text.includes(row.head)) markDelivered(session, row, seq);
      }
      return;
    }
    if (type === "assistant/message") {
      for (const row of [...rows]) {
        if (row.state === "delivered" && (!Number.isFinite(row.deliveredSeq) || seq > row.deliveredSeq)) {
          row.state = "effective";
          patchPrompt(session, row.file, { state: "effective", effectiveAt: nowMs() });
          rows.splice(rows.indexOf(row), 1);
        }
      }
    }
  };

  const expireDeliveries = () => {
    for (const [session, rows] of deliveries) {
      for (const row of [...rows]) {
        if (row.state === "accepted" && nowMs() - row.at > DELIVER_TIMEOUT_MS) {
          row.state = "timeout";
          patchPrompt(session, row.file, { state: "timeout", timedOutAt: nowMs(), reason: "超时：会话里一直没出现这条话" });
          rows.splice(rows.indexOf(row), 1);
        }
      }
      if (rows.length === 0) deliveries.delete(session);
    }
  };

  const markPrompt = (session, file, prompt, patch) => {
    writeJson(join(dir.prompts, session, file), { ...prompt, ...patch });
  };

  const deliver = async (session, file, prompt) => {
    const controller = resolveController(ctx);
    if (!controller) {
      markPrompt(session, file, prompt, { takenAt: nowMs(), state: "failed", refused: nowMs(), reason: "宿主没有 sessionController" });
      return;
    }
    try {
      const out = await controller.prompt(
        {
          requestId: prompt.id,
          sessionId: session,
          mode: "queue",
          content: [{ type: "text", text: String(prompt.text ?? "") }],
        },
        undefined,
      );
      if (out?.accepted === false) {
        markPrompt(session, file, prompt, { takenAt: nowMs(), state: "failed", refused: nowMs(), reason: String(out.reason ?? "被拒") });
      } else {
        markPrompt(session, file, prompt, { takenAt: nowMs(), state: "accepted", acceptedAt: nowMs() });
        trackDelivery(session, file, prompt);
      }
    } catch (error) {
      markPrompt(session, file, prompt, {
        takenAt: nowMs(),
        state: "failed",
        failed: nowMs(),
        reason: String(error?.message ?? error).slice(0, 400),
      });
    }
  };

  const drainPrompts = () => {
    if (stopped) return;
    for (const session of listDir(dir.prompts)) {
      if (!NAME.test(session)) continue;
      const folder = join(dir.prompts, session);
      const files = listDir(folder).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
      files.sort();
      for (const file of files) {
        const prompt = readJson(join(folder, file));
        if (!prompt || prompt.takenAt) continue;
        if (existsSync(join(folder, file.replace(/\.json$/, ".cancel")))) {
          markPrompt(session, file, prompt, { cancelledAt: nowMs() });
          continue;
        }
        const expiresAt = Number(prompt.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= nowMs()) {
          markPrompt(session, file, prompt, { expiredAt: nowMs() });
          continue;
        }
        markPrompt(session, file, prompt, { takenAt: nowMs() });
        void deliver(session, file, prompt);
      }
    }
  };

  // ---- 面板写下的答复 ----
  const drainAnswers = () => {
    if (stopped || pending.size === 0) return;
    for (const [id, entry] of pending) {
      const answer = readJson(answerFile(id));
      if (!answer) continue;
      const value = acceptAnswer(entry.ask, answer.value);
      if (value === undefined) {
        drop(answerFile(id)); // 不合格：当没答，继续等
        continue;
      }
      entry.resolve(value);
    }
  };

  const safe = (fn) => () => {
    try {
      fn();
    } catch {}
  };

  // 定时器：各自 try，绝不把异常放出去。
  timers.push(setInterval(safe(beat), tick));
  timers.push(
    setInterval(
      safe(() => {
        for (const id of live) checkIn(id);
        expireDeliveries();
      }),
      tick,
    ),
  );
  timers.push(setInterval(safe(drainAnswers), answerPoll));
  timers.push(setInterval(safe(drainPrompts), promptPoll));

  // ---- 挂到宿主 ----
  const offs = [];
  const on = (event, handler, opts) => {
    try {
      const off = ctx.on(event, handler, opts);
      if (typeof off === "function") offs.push(off);
    } catch {}
  };

  on("approval/request", watch("approval", approvalBody), { prepend: true });
  on("user-questions/request", watch("question", questionBody), { prepend: true });
  // 第二证据源：同一进程看到的 durable event 抄一份。session/event 是
  // committed event（带 type/seq/time/data），转录只是它的落盘视图。
  on("session/event", (session, event) => {
    try {
      const id = session?.header?.id ?? session?.id;
      if (typeof id !== "string") return undefined;
      tapAppend(id, event);
      noteDelivery(id, event);
    } catch {}
    return undefined;
  });
  on("agent/created", (event) => {
    try {
      if (isRoot(event?.agent)) checkIn(event.agent.id);
    } catch {}
    return undefined;
  });
  on("agent/disposed", (event) => {
    try {
      const id = event?.agent?.id;
      if (typeof id === "string") end(id);
    } catch {}
  });
  on("tools/pre-execute", (exec, next) => {
    try {
      const name = String(exec?.name ?? "");
      if (MCP_PREFIXES.some((p) => name.startsWith(p)) && exec && typeof exec === "object") {
        exec.__magpieArguments = clip(exec.arguments ?? exec.input ?? "", ARGUMENTS_LIMIT);
      }
    } catch {}
    return next();
  });

  safe(beat)();

  return {
    stop() {
      stopped = true;
      for (const t of timers) {
        try {
          clearInterval(t);
          clearTimeout(t);
        } catch {}
      }
      for (const off of offs) {
        try {
          off();
        } catch {}
      }
      for (const id of [...pending.keys()]) settle(id);
      drop(dir.plugin);
    },
    stats() {
      return { host: HOST, asks: pending.size, watched: watched(), channel: root };
    },
  };
}

export const name = "magpie-hud";
export const inject = ["agents"];

// 宿主加载我们：任何异常都必须被吃掉——这段代码崩了会把整个 harness 带走。
export function apply(ctx, config) {
  let plugin = null;
  try {
    const channel = typeof config?.channel === "string" ? config.channel : "";
    if (!channel) return;
    plugin = start(ctx, channel, { sessionId: config?.sessionId });
  } catch {
    return;
  }
  try {
    ctx.effect(() => () => {
      try {
        plugin.stop();
      } catch {}
    });
  } catch {
    // 没有 effect 的宿主（旧版）也能跑，只是不能优雅卸载。
  }
}
