// 会话发现：扫描本机各 AI coding agent 的转录目录。
//
// 范围：Claude Code（~/.claude/projects/<项目>/<sessionId>.jsonl）、
// Codex（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）、DeepSeek Harness
//（~/.dsh/sessions/<项目目录>/<会话id>/session.v4.jsonl.zstd，zstd 压缩；
// 旧布局是顶层 *.jsonl）与 Antigravity（~/.gemini/antigravity{,-cli,-ide}
// /brain/<id>/.system_generated/logs/transcript.jsonl）。行格式照 agent-hud
// agents crate 各 transcript.rs。
//
// 语义照 Agent HUD 的 list_sessions：id、client、title、project、state、
// reachable、self。state 在 M1 用转录 mtime 近似（5 分钟内视为 running），
// M2 起用钩子/进程信号精确化。reachable 在投递落地（M3/M5）前为
// null + 原因。HOME 可用 MAGPIE_AGENTS_HOME 覆盖（测试用）。
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { lastCheckIn } from "./delivery/claude.mjs";
import { presenceOf } from "./clients.mjs";
import { sessionTruth } from "./truth/collect.mjs";

// fzstd（纯 JS zstd 解压器，Bun 可跑）解 DSH 的 session.v4.jsonl.zstd。
// 依赖缺失时为 null：压缩转录被跳过，其余客户端与工具不受影响。
const fzstd = await import("fzstd").catch(() => null);
const zstdDecompress = fzstd?.decompress ?? null;
const ZstdStream = fzstd?.Decompress ?? null;

// 只读转录开头就够：会话头、标题、第一条用户输入都在头几十行/几百行里。
// 整份解压的代价不可接受——本机最大一份 17.8MB，全解 9.6 秒，会把 HTTP
// 服务（和整个扫描）按住十秒，HUD 的 8 秒超时正好撞上。
const HEAD_BYTES = 512 * 1024;
const HEAD_LINES = 400;
// 「等你回答」要看转录尾部，必须整份解压：只对压缩后小于这个体积的转录做

const MAX_SESSIONS = 50;
const TITLE_SCAN_LINES = 80;
const TITLE_CHARS = 80;

// ── 扫描缓存 ───────────────────────────────────────────────────────────
// 为什么必须有它：DSH 的 v4 转录是整份 zstd（本机 171 份共 179MB），全量
// 解压一次要 65–99 秒——面板 8 秒就超时，HUD 于是老实显示成「0 个会话」。
// 做法：以「文件 size + mtime」为键，把解析结果落盘复用。
//   1) 先 stat 一遍（毫秒级）：命中的直接用上次结果；
//   2) 未命中的先当空壳（id 用目录名/文件名，标题暂空）立刻返回，不等解析；
//   3) 空壳按 mtime 从新到旧排进后台队列，一次解析一个，写回缓存。
// 于是第一次扫描之后，每次都是 stat 级——接口秒回，标题最迟一分钟补齐。
// v3：truth 里新增 title（fold 跟踪 session/title 事件），旧缓存没有这个字段，
// 必须整体失效一次，否则升级后标题永远停在旧规则的结果上。
const CACHE_VERSION = 3;
const CACHE_LIMIT = 5000;
const cachePath = () => process.env.MAGPIE_HUD_SESSIONS_CACHE || join(homeDir(), ".magpie-hud", "sessions-cache.json");

let cache = null; // { "绝对路径": { s: size, m: mtime, d: {id, project, title, pending} } }
let cacheDirty = false;

function cacheLoad() {
  if (cache) return cache;
  cache = {};
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (j?.v === CACHE_VERSION && j.files && typeof j.files === "object") cache = j.files;
  } catch { /* 没缓存或坏了：当空缓存跑，解析后覆盖写回 */ }
  return cache;
}

function cacheGet(file, st) {
  const e = cacheLoad()[file];
  return e && e.s === st.size && e.m === st.mtimeMs ? e.d : null;
}

function cacheSet(file, st, data) {
  cacheLoad()[file] = { s: st.size, m: st.mtimeMs, d: data };
  cacheDirty = true;
}

function cacheFlush() {
  if (!cacheDirty) return;
  const entries = Object.entries(cacheLoad());
  if (entries.length > CACHE_LIMIT) {
    // 缓存是加速件不是档案：超量时只留最近活动的
    entries.sort((a, b) => b[1].m - a[1].m);
    cache = Object.fromEntries(entries.slice(0, CACHE_LIMIT));
  }
  const path = cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files: cache }));
    renameSync(tmp, path);
  } catch { /* 写不进去不影响本次扫描，只是下次还要重解析 */ }
  cacheDirty = false;
}

// 后台补队列：文件 → 解析函数。按下一次 tick 只做一个，绝不让一个 17MB
// 转录把事件循环占住几十秒。
const pendingFill = new Map();
let fillTimer = null;

function later(fn, ms) {
  fillTimer = setTimeout(fn, ms);
  if (typeof fillTimer.unref === "function") fillTimer.unref();
}

function queueFill(file, st, compute) {
  const old = pendingFill.get(file);
  if (!old || old.st.mtimeMs !== st.mtimeMs) pendingFill.set(file, { st, compute });
  if (!fillTimer) later(fillStep, 40);
}

// 活跃会话（mtime 在最近 2 分钟内）的补全优先：它们正是用户盯着看的那几行，
// 而且文件一直在长，排到队尾就永远追不上。静止会话按 mtime 新旧排。
function fillPriority(job, now) {
  const age = now - job.st.mtimeMs;
  return age < 120_000 ? Number.POSITIVE_INFINITY - job.st.mtimeMs : job.st.mtimeMs;
}

function fillStep() {
  fillTimer = null;
  const now = Date.now();
  let next = null;
  for (const [file, job] of pendingFill) {
    if (!next || fillPriority(job, now) > fillPriority(next[1], now)) next = [file, job];
  }
  if (!next) {
    cacheFlush();
    return;
  }
  const [file, job] = next;
  pendingFill.delete(file);
  try {
    cacheSet(file, job.st, job.compute(file));
  } catch { /* 坏文件：下次扫描还会重试，不影响其它会话 */ }
  if (pendingFill.size === 0) cacheFlush();
  else later(fillStep, 10);
}

// 小转录同步解析：几十 KB 的文件当场解析只要几毫秒，不值得推迟一轮；
// 再大就要排队——79 份 256KB 的转录加起来是几秒钟。
const SYNC_MAX_BYTES = 32 * 1024;

// stat + 缓存：命中就返回解析结果；小文件当场解析；大文件返回 null 并排进后台
function metaOf(file, st, compute) {
  const hit = cacheGet(file, st);
  if (hit) return hit;
  // 活跃会话（2 分钟内写过）不等后台队列：它就是用户盯着的那行，且文件一直在长，
  // 排队永远追不上。整份解压 6MB 也就一两秒，值得当场做。
  const active = st && Date.now() - st.mtimeMs < 120_000;
  if (st && (st.size <= SYNC_MAX_BYTES || active)) {
    let data = null;
    try { data = compute(file); } catch { /* 坏文件：退回后台重试，不影响本次扫描 */ }
    if (data) {
      cacheSet(file, st, data);
      if (!fillTimer) later(fillStep, 200); // 借后台队列把手上的缓存落盘
      return data;
    }
  }
  queueFill(file, st, compute);
  return null;
}

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

// 只有事件源（truth / tap / registry / transcript）配说 running / waiting / idle。
// Claude / Codex / Antigravity 这三家只有 mtime：能证明「最近写过」，证明不了
// 「还在跑」——刚写完一句就等人的会话，和卡在长工具调用里的会话，mtime 长得一模一样。
// 所以状态一律 unknown 并给出原因，写入时间另放 recent.lastWriteMs 供排序与「只看活跃」用（v7 §4.1）。
function mtimeRow(mtimeMs, now = Date.now()) {
  // statSync 的 mtimeMs 带小数（微秒），契约里是整毫秒，这里统一取整。
  const at = mtimeMs ? Math.round(mtimeMs) : null;
  const nowMs = Math.round(now);
  return {
    state: "unknown",
    phase: "unknown",
    source: { kind: "mtime", verified: false, rule: null, seq: null, observedAt: at, lagMs: at ? Math.max(0, nowMs - at) : null },
    presence: null,
    recent: { lastWriteMs: at },
    unknown: { reason: "no-truth-source" },
  };
}

// 契约（v7 §4.1）的另一半：每行的 phase 都得说清「凭什么」。事件源记 events，
// tap 仲裁过的记 tap，两边都没有就是 none——此时 phase 只能是 unknown。
// verified 的意思是「这个 phase 能被证据证伪」，不是一个装饰字段。
function truthSource(truth, st) {
  const mode = truth?.evidence?.mode ?? "none";
  const kind = mode === "events" ? "events" : mode === "tap" ? "tap" : "none";
  const nowMs = Date.now();
  const raw = truth?.lastEventAt ?? null;
  const lastMs = raw == null ? 0 : Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw) || 0;
  return {
    kind,
    verified: kind !== "none" && truth?.phase != null && truth.phase !== "unknown",
    rule: truth?.evidence?.rule ?? truth?.rule ?? null,
    seq: truth?.evidence?.seq ?? null,
    observedAt: nowMs,
    lagMs: lastMs ? Math.max(0, nowMs - lastMs) : null,
  };
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n").slice(0, TITLE_SCAN_LINES)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 非 JSON 行跳过 */ }
  }
  return out;
}

// Claude Code 转录行：{type:"user", message:{role:"user", content: string | [{type:"text",text}]}}
function claudeUserText(j) {
  if (j?.type !== "user") return "";
  const c = j?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === "text" && typeof p.text === "string") return p.text;
    }
  }
  return "";
}

function claudeSessions(now) {
  const root = join(homeDir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const out = [];
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const proj of dirs) {
    if (!proj.isDirectory()) continue;
    const folder = join(root, proj.name);
    let files;
    try { files = readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = join(folder, f.name);
      const id = f.name.slice(0, -6);
      let st = null;
      try { st = statSync(file); } catch { /* 读不动：只报 id 与项目 */ }
      const meta = st
        ? metaOf(file, st, (p) => {
            let title = "";
            try {
              for (const j of parseLines(readHead(p))) {
                title = claudeUserText(j);
                if (title) break;
              }
            } catch { /* 读不动：空标题 */ }
            return { title: title.slice(0, TITLE_CHARS) };
          })
        : null;
      const checked = lastCheckIn(id);
      const presence = presenceOf("claude", checked ?? null, now);
      const row = mtimeRow(st?.mtimeMs ?? 0, now);
      row.presence = presence.presence;
      if (checked != null) {
        // 有过签到就记 registry：签到是这个客户端最好的证据源，「新不新鲜」由 presence 说，
        // 不拿 kind 来回横跳（否则过期那一刻连「有签到机制」这个事实都丢了）。
        // 但签到证不了 phase：verified 仍为 false、phase 留在 unknown（v7 §5 P1）。
        const at = Math.round(checked);
        row.source = { kind: "registry", verified: false, rule: "registry:checkin", seq: null, observedAt: at, lagMs: Math.max(0, now - at) };
      }
      out.push({
        mtimeMs: st?.mtimeMs ?? 0,
        session: {
          id,
          client: "claude",
          file,
          title: meta?.title ?? "",
          project: proj.name,
          ...row,
          reachable: presence.presence === "online",
          reason: presence.presence === "online" ? "Claude 插件已签到，可以收消息。" : "这个会话还没装配套的 Claude Code 插件（或签到已过期）；装好后它每 5 秒签到一次。",
          self: null,
        },
      });
    }
  }
  return out;
}

// Codex 转录行：{type:"session_meta", payload:{id, cwd}} 与
// {type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text",text}]}}
function codexUserText(j) {
  const p = j?.payload;
  if (j?.type !== "response_item" || p?.type !== "message" || p?.role !== "user") return "";
  for (const c of p?.content ?? []) {
    if (c?.type === "input_text" && typeof c.text === "string") return c.text;
  }
  return "";
}

function codexSessions(now) {
  const root = join(homeDir(), ".codex", "sessions");
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(join(dir, e.name));
    }
  };
  walk(root);
  const out = [];
  for (const file of files) {
    let st = null;
    try { st = statSync(file); } catch { /* 读不动：只报文件名 */ }
    const meta = st
      ? metaOf(file, st, (p) => {
          let head = null;
          let title = "";
          try {
            for (const j of parseLines(readHead(p))) {
              if (!head && j?.type === "session_meta") head = j?.payload ?? null;
              if (!title) title = codexUserText(j);
              if (head && title) break;
            }
          } catch { /* 读不动：只报文件名 */ }
          return {
            id: typeof head?.id === "string" ? head.id : basename(p).slice(0, -6),
            project: typeof head?.cwd === "string" ? head.cwd : "",
            title: title.slice(0, TITLE_CHARS),
          };
        })
      : null;
    out.push({
      mtimeMs: st?.mtimeMs ?? 0,
      session: {
        id: meta?.id || basename(file).slice(0, -6),
        client: "codex",
        file,
        title: meta?.title ?? "",
        project: meta?.project ?? "",
        ...mtimeRow(st?.mtimeMs ?? 0, now),
        reachable: true,
        reason: "Codex 经自身队列收消息，无需插件。",
        self: null,
      },
    });
  }
  return out;
}


// DeepSeek Harness 转录行（照 deepseek/transcript.rs）：
//   {type:"session", version, id, cwd} 起头；用户 prompt 是
//   {type:"user/message", data:{source:{kind:"user"}, content: string |
//   [{type:"text",text}]}}；助手回答 {type:"assistant/message",
//   data:{message:{role:"assistant", content:[{type:"text",text}]}}}。
// DeepSeek Harness 转录行（v4 实测）：会话头 {type:"session",version:4,
// id,createdAt,cwd,…}；标题 {type:"session/title",data:{title}}；用户输入
// {type:"user/message",data:{content,source:{kind}}}——kind 为 "user" 才是
// 真用户输入，"user-approval" 等是系统注入，不算标题；子代理会话没有
// user/message，任务书在 {type:"agent/inbox/spliced",data:{inserted:[{content:
// [{type:"text",text}]}]}}。
// dshUserText 只认 kind:"user" 的真用户输入；"user-approval" 等系统注入
// 不算。dshInboxText 认 agent/inbox/spliced 的任务书文本（子代理会话没有
// user/message），但它也携带系统通知（approval policy 变更），所以标题
// 优先级里垫底。
function dshUserText(j) {
  if (j?.type !== "user/message") return "";
  if (j?.data?.source?.kind !== "user") return "";
  const c = j?.data?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    for (const p of c) if (p?.type === "text" && typeof p.text === "string") return p.text;
  }
  return "";
}

function dshInboxText(j) {
  if (j?.type !== "agent/inbox/spliced" || !Array.isArray(j?.data?.inserted)) return "";
  for (const ins of j.data.inserted) {
    for (const c of Array.isArray(ins?.content) ? ins.content : []) {
      if (c?.type === "text" && typeof c.text === "string" && c.text) return c.text;
    }
  }
  return "";
}

// dshRead 读一个转录文件：明文直读，.zstd 用 fzstd 解压；解压器不在或帧
// 坏了返回空串（该会话只剩目录名兜底），不让一个坏文件拖垮整个扫描。
// 明文转录的开头 N 字节（Claude/Codex/Antigravity 的 jsonl 也可能上百 MB）
function readHead(file, maxBytes = HEAD_BYTES) {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    let n = 0;
    while (n < maxBytes) {
      const got = readSync(fd, buf, n, maxBytes - n, n);
      if (!got) break;
      n += got;
    }
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

// 压缩转录的开头：按 256KB 增量解压，攒够 HEAD_LINES 行就停——不必为了一
// 个标题把 17MB 全部解开。
function dshHead(file) {
  if (!file.endsWith(".zstd")) return readHead(file);
  if (!ZstdStream) return "";
  let text = "";
  const dec = new ZstdStream((chunk) => {
    text += Buffer.from(chunk).toString("utf8");
  });
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const buf = Buffer.alloc(256 * 1024);
    let read = 0;
    while (read < size && read < HEAD_BYTES && text.split("\n").length <= HEAD_LINES) {
      const want = Math.min(buf.length, size - read, HEAD_BYTES - read);
      const n = readSync(fd, buf, 0, want, read);
      if (!n) break;
      read += n;
      try { dec.push(new Uint8Array(buf.subarray(0, n))); } catch { break; }
    }
  } catch {
    return text; // 帧坏了：有多少用多少
  } finally {
    if (fd >= 0) closeSync(fd);
  }
  return text;
}

// DSH_HOME 是「DSH 的家目录」（lib/dsh-plugin.mjs:20 dshHome），转录在它下面的
// sessions/。以前把它当成了 sessions 目录本身，DSH_HOME 一旦被设起来，
// 扫描根就变成 ~/.dsh/*  → 一个会话也扫不到，HUD 显示 0。
function dshRoot() {
  const given = process.env.DSH_HOME;
  if (typeof given === "string" && isAbsolute(given)) {
    const under = join(given, "sessions");
    // 兼容把 DSH_HOME 直接指到 sessions 目录的写法
    return existsSync(under) || !existsSync(given) ? under : given;
  }
  return join(homeDir(), ".dsh", "sessions");
}

function dshSessions(now) {
  const root = dshRoot();
  if (!existsSync(root)) return [];
  const out = [];
  const files = [];
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      // 旧布局：顶层 *.jsonl
      if (project.isFile() && project.name.endsWith(".jsonl")) {
        files.push({ file: join(root, project.name), fallbackId: project.name.slice(0, -6) });
        continue;
      }
      // v4 布局：<项目目录>/<会话id>/session.v4.jsonl(.zstd)
      if (!project.isDirectory()) continue;
      const projectDir = join(root, project.name);
      let ids;
      try { ids = readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
      for (const s of ids) {
        if (!s.isDirectory()) continue;
        const sessionDir = join(projectDir, s.name);
        let names;
        try { names = readdirSync(sessionDir); } catch { continue; }
        for (const name of names) {
          if (/\.jsonl(\.zstd)?$/.test(name)) files.push({ file: join(sessionDir, name), fallbackId: s.name });
        }
      }
    }
  } catch { return []; }
  for (const { file, fallbackId } of files) {
    let st = null;
    try { st = statSync(file); } catch { /* 读不动：只报目录名 */ }
    const meta = st
      ? metaOf(file, st, (p) => {
          let id = "";
          let project = "";
          let title = "";
          let titleUser = "";
          let titleOwn = "";
          let titleInbox = "";
          try {
            const head = dshHead(p);
            for (const j of parseLines(head)) {
              if (!id && j?.type === "session" && typeof j?.id === "string") {
                id = j.id;
                project = typeof j?.cwd === "string" ? j.cwd : "";
                continue;
              }
              if (!titleUser) titleUser = dshUserText(j);
              // 头部窗口里可能有多条 session/title（fallback → provider）：
              // 取最后一条——它比第一条新，也比用户输入原文更像「标题」。
              if (j?.type === "session/title" && typeof j?.data?.title === "string" && j.data.title) titleOwn = j.data.title;
              if (!titleInbox) titleInbox = dshInboxText(j);
              if (id && titleUser) break;
            }
          } catch { /* 解压/解析失败：只剩目录名兜底 */ }
          // 「等你回答」与「在跑/空闲」都由事件真值决定（lib/truth/collect.mjs）：
          // 不再看 mtime，不再扫文本找 ask_user —— 那两条在真实日志上都会说谎。
          let truth = null;
          try { truth = sessionTruth(p, st); } catch { /* 读不动：保持 unknown，不猜 */ }
          if (!truth) {
            // 读不动/解不开：给一个「带原因的 unknown」，而不是 null——
            // null 会让页面行既没有 rule 也没有 unknown.reason，等于把「读失败」藏起来。
            truth = {
              phase: "unknown", state: "unknown", rule: "unknown:unread", title: null,
              unknown: { reason: "unread", sinceSeq: null }, waiting: null,
              phaseSinceSeq: null, activity: null, tokens: null, counts: null,
              lastEventAt: null, lastSeq: null,
              evidence: { mode: "none", bytes: { offset: 0, size: st?.size ?? 0, truncated: true }, mtimeMs: st?.mtimeMs ?? 0, error: "unread", rule: null, seq: null },
            };
          }
          // 标题优先级：truth.title（尾部窗口里的最新 session/title，含用户改过的）
          // > 头部窗口的 titleOwn > 用户输入原文 > 任务书。DSH 明明生成了好标题，
          // 却显示 80 字符的 prompt 截断——那是把最差的证据当成了最好的。
          title = truth.title || titleOwn || titleUser || titleInbox;
          // fingerprint：fork 判重的键。用首条用户输入（不是显示标题——
          // DSH 生成的标题各副本可能不同，首条输入才是 fork 的指纹）。
          const fingerprint = (titleUser || titleInbox).slice(0, 60);
          return { id, project, title: title.slice(0, TITLE_CHARS), fingerprint, truth };
        })
      : null;
    const truth = meta?.truth ?? null;
    const waiting = truth?.waiting ?? null;
    out.push({
      mtimeMs: st?.mtimeMs ?? 0,
      shellSize: st?.size ?? 0,
      fingerprint: meta?.fingerprint ?? "",
      session: {
        id: meta?.id || fallbackId,
        client: "dsh",
        file,
        // 等待形状：kind 是语义类别（approval/question），toolName 用于显示。
        pending: waiting
          ? { kind: waiting.kind, toolName: waiting.toolName ?? waiting.kind, since: waiting.since, askId: waiting.askId, seq: waiting.seq, rule: truth.rule }
          : null,
        title: meta?.title ?? "",
        project: meta?.project ?? "",
        state: truth?.state ?? "unknown",
        phase: truth?.phase ?? "unknown",
        source: truthSource(truth, st),
        evidence: truth?.evidence ?? { mode: "none", bytes: { offset: 0, size: st?.size ?? 0, truncated: true }, mtimeMs: st?.mtimeMs ?? 0, error: null, rule: null, seq: null },
        truth: truth ? { rule: truth.rule, phase: truth.phase, phaseSinceSeq: truth.phaseSinceSeq, unknown: truth.unknown, activity: truth.activity, tokens: truth.tokens, counts: truth.counts, lastEventAt: truth.lastEventAt, lastSeq: truth.lastSeq } : null,
        reachable: false,
        presence: null,
        reason: "DeepSeek Harness 的投递通道还没接（后续里程碑）。",
        self: null,
      },
    });
  }
  return out;
}

// Antigravity 转录行（照 antigravity/transcript.rs）：用户输入
// {type:"USER_INPUT", source != "SYSTEM", step_index, created_at,
//  content: string}，content 里可能包 <USER_REQUEST>…</USER_REQUEST>；
// 助手回答 {type:"PLANNER_RESPONSE", content: string}。
function antigravityClean(raw) {
  if (typeof raw !== "string") return "";
  const open = raw.indexOf("<USER_REQUEST>");
  if (open >= 0) {
    const after = raw.slice(open + "<USER_REQUEST>".length);
    const close = after.indexOf("</USER_REQUEST>");
    if (close >= 0) return after.slice(0, close).trim();
  }
  return raw.trim();
}

function antigravityUserText(j) {
  if (j?.type !== "USER_INPUT") return "";
  if (j?.source === "SYSTEM") return "";
  return antigravityClean(j?.content);
}

function antigravitySessions(now) {
  const gemini = process.env.GEMINI_CLI_HOME || join(homeDir(), ".gemini");
  const out = [];
  for (const variant of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
    const brain = join(gemini, variant, "brain");
    if (!existsSync(brain)) continue;
    let ids;
    try { ids = readdirSync(brain, { withFileTypes: true }); } catch { continue; }
    for (const entry of ids) {
      if (!entry.isDirectory()) continue;
      const file = join(brain, entry.name, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(file)) continue;
      let st = null;
      try { st = statSync(file); } catch { /* 读不动：只报 id */ }
      const meta = st
        ? metaOf(file, st, (p) => {
            let title = "";
            try {
              for (const j of parseLines(readHead(p))) {
                title = antigravityUserText(j);
                if (title) break;
              }
            } catch { /* 读不动：空标题 */ }
            return { title: title.slice(0, TITLE_CHARS) };
          })
        : null;
      out.push({
        mtimeMs: st?.mtimeMs ?? 0,
        session: {
          id: "antigravity:" + entry.name,
          client: "antigravity",
          file,
          title: meta?.title ?? "",
          project: "",
          ...mtimeRow(st?.mtimeMs ?? 0, now),
          reachable: false,
          reason: "Antigravity 的投递通道还没接（后续里程碑）。",
          self: null,
        },
      });
    }
  }
  return out;
}

// startFolders（照 offers_for + listing.rs 的输出形状）：每个客户端从现存
// 本机会话里收项目夹，去重封顶；withoutFolder 一律 true（任务夹自建）。
function startFoldersOf(sessions) {
  const out = {};
  for (const client of ["claude", "codex"]) {
    const folders = [];
    for (const session of sessions) {
      if (session.client !== client || !session.project) continue;
      if (!folders.includes(session.project) && folders.length < 8) folders.push(session.project);
    }
    if (folders.length) out[client] = { folders, withoutFolder: true, app: "" };
  }
  return out;
}

// listSessions 是 list_sessions 工具的数据源：会话按最近活动排序，封顶
// MAX_SESSIONS；startFolders 给 start_session 用。
//
// 三件界面卫生（2026-11-15 界面诊断的结论）：
//   1) fork 副本去重：DSH 的 resume/重开会为同一对话复制出新文件（新 id、
//      相同首条输入、内容前缀重叠）。没有 lineage 字段可查，只能按
//      「同项目 + 同首条输入」分组，组内只留 mtime 最新的一份，行尾记
//      copies=N。用户看到 6 行「下一步做什么」只会觉得是 bug。
//   2) worktree 壳会话：DSH 的 worktree 机制会留下只有 4 个事件
//      （session/permission/sandbox/approval）的空壳，没有任何内容——
//      它们不是会话，是目录占位。折叠成一行计数，不占 50 个名额。
//   3) 在跑口径：tiles 的 running 与列表页的 running 必须同口径
//      （都按去重后的全量算），否则「在跑 3」对「4 个在跑」自相矛盾。
function dedupeSessions(all) {
  // 壳会话：无标题（头部窗口里既没有用户输入也没有 title）且文件极小。
  // 真会话哪怕再短也有首条输入；壳只有 4 个元数据事件。
  const shells = [];
  const real = [];
  for (const x of all) {
    const isShell = !x.session.title && (x.shellSize ?? Number.POSITIVE_INFINITY) <= 4096;
    (isShell ? shells : real).push(x);
  }
  // fork 分组：同项目 + 同首条输入（标题前 60 字符）。
  // 用「首条输入」而不是「显示标题」：显示标题可能是 DSH 生成的（各副本不同），
  // 首条输入才是 fork 的指纹。
  const groups = new Map();
  for (const x of real) {
    const key = `${x.session.client}|${x.session.project}|${x.fingerprint ?? ""}`;
    if (!x.fingerprint) {
      groups.set(Symbol(), [x]); // 没指纹的（读不动的）各自独立
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(x);
    else groups.set(key, [x]);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const head = g[0];
    head.session.copies = g.length - 1;
    out.push(head);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions: out, shellCount: shells.length };
}

export async function listSessions() {
  const now = Date.now();
  const all = [
    ...claudeSessions(now),
    ...codexSessions(now),
    ...dshSessions(now),
    ...antigravitySessions(now),
  ];
  const { sessions: deduped, shellCount } = dedupeSessions(all);
  deduped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = deduped.slice(0, MAX_SESSIONS).map((x) => ({ ...x.session, mtimeMs: x.mtimeMs }));
  return {
    sessions,
    // 列表封顶 50 是为了工具输出别爆；总数和在跑数必须按全部算，
    // 否则 HUD 会把「本机 171 个会话」说成「50 个会话」。
    // 去重后的口径：total 不再数 fork 副本与壳会话（用户视角的「会话数」）。
    total: deduped.length,
    running: deduped.filter((x) => x.session.state === "running").length,
    shellCount,
    startFolders: startFoldersOf(sessions),
    passLimit: Number(process.env.MAGPIE_AGENTS_PASS_LIMIT || 10),
    sendsAs: process.env.MAGPIE_AGENTS_AS_USER === "1" ? "user" : "labelled",
  };
}
