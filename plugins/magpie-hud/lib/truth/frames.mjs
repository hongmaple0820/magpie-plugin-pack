// DSH 转录（session.v4.jsonl.zstd）的帧级读取。
//
// 为什么不用「整份解压」：本机 197 份转录压缩后 279.7MB，全量解压一次 65–99 秒
// （lib/sessions.mjs 的注释记着这件事）。v4 转录是**多帧追加**写的——每批写入
// 是一个独立 zstd 帧，帧与帧首尾相接。所以只要找到帧边界，就能只解新追加的那几
// 帧，代价和新增字节成正比。
//
// 帧边界的判定不能只看魔数 0x28B52FFD（压缩数据里可能偶然出现同一序列）：
//   1) 从候选起点解码，必须成功；
//   2) 解出的每一行都必须是合法 JSON；
//   3) 有 seq 的事件，seq 必须严格 +1。
// 三条同时成立才认。否则往更早的候选退；全失败就返回 error，让上层标 unknown，
// 绝不猜。
//
// 本模块只读字节，不判断业务含义（那是 lib/truth/fold.mjs 的事）。
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { decompress, Decompress } from "fzstd";

export const MAGIC = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]);

export function isZstd(name) {
  return name.endsWith(".zstd");
}

// 所有魔数候选位置（升序）。只扫一遍，O(n)，不做拷贝。
export function frameCandidates(buf) {
  const out = [];
  outer: for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] !== MAGIC[0]) continue;
    for (let k = 1; k < 4; k += 1) if (buf[i + k] !== MAGIC[k]) continue outer;
    out.push(i);
  }
  return out;
}

// 从 offset 开始流式解码：出错时保留已经解出的前缀（one-shot decompress 会整块丢失）。
export function decodeFrom(raw, offset = 0) {
  let text = "";
  let error = null;
  const dec = new Decompress((chunk) => {
    text += Buffer.from(chunk).toString("utf8");
  });
  try {
    dec.push(raw.subarray(offset));
  } catch (e) {
    error = String(e?.message ?? e);
  }
  return { text, error };
}

// 行 → 事件。返回 {events, badLines, carry}：carry 是最后一段没有换行结尾的
// 半行，交给下一次追加读取拼接。
export function parseLines(text, carry = "") {
  const joined = carry + text;
  const lines = joined.split("\n");
  const rest = lines.pop() ?? "";
  const events = [];
  let badLines = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { badLines += 1; }
  }
  return { events, badLines, carry: rest };
}

// seq 连续性：忽略没有 seq 的事件（会话头等），其余必须严格 +1。
// 返回第一个破坏连续的位置（events 下标），-1 表示连续。
export function continuityBreak(events) {
  let prev = null;
  for (let i = 0; i < events.length; i += 1) {
    const seq = events[i]?.seq;
    if (typeof seq !== "number") continue;
    if (prev != null && seq !== prev + 1) return i;
    prev = seq;
  }
  return -1;
}

export function seqSpan(events) {
  let first = null;
  let last = null;
  for (const e of events) {
    if (typeof e?.seq !== "number") continue;
    if (first == null) first = e.seq;
    last = e.seq;
  }
  return { first, last };
}

// 一个候选起点是否可信：解码成功、坏行数为 0、seq 连续、至少解出一个事件。
export function verifyCandidate(raw, offset) {
  const { text, error } = decodeFrom(raw, offset);
  if (error) return { ok: false, error };
  const { events, badLines, carry } = parseLines(text);
  if (!events.length) return { ok: false, error: "empty" };
  if (badLines > 0) return { ok: false, error: `bad-lines:${badLines}` };
  const brk = continuityBreak(events);
  if (brk >= 0) return { ok: false, error: `seq-break-at:${brk}` };
  return { ok: true, events, carry, text };
}

// 读文件的一段（不整份读，适合大文件）。
export function readRange(file, start, end) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const to = Math.min(end, size);
    if (to <= start) return Buffer.alloc(0);
    const buf = Buffer.alloc(to - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (!n) break;
      got += n;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

// 单个帧：candidates[i] 到 candidates[i+1]（最后一帧到文件末尾）。
// 帧内解码失败时尝试把起点往前挪一格——魔数可能出现在压缩数据内部，把一帧
// 切成两段；真正的帧起点一定更早。
function decodeFrame(buf, candidates, i) {
  for (let back = 0; back <= 2; back += 1) {
    const start = candidates[i - back];
    if (start == null) break;
    const end = candidates[i + 1] ?? buf.length;
    if (end <= start) continue;
    const { text, error } = decodeFrom(buf.subarray(start, end), 0);
    if (error) continue;
    const parsed = parseLines(text);
    if (!parsed.events.length || parsed.badLines > 0) continue;
    if (continuityBreak(parsed.events) >= 0) continue;
    return { start, end, events: parsed.events, back };
  }
  return null;
}

// 带标记回看的窗口：从末尾往前扫帧，直到找到 lookback 个「可能是等待起点」的帧
// （审批/提问），再从那帧连续解到文件末尾。
//
// 为什么需要回看：审批可能在很早的一帧就已 asked，之后没有任何新事件；只看最后
// 一帧会把它漏成 idle。回看有上限（maxBytes / maxFrames），超出就交给上层标
// unknown（window-truncated），不猜。
export function readWindow(file, {
  maxBytes = 128 * 1024,
  maxFrames = 48,
  lookback = 3,
  markers = [/approval\/asked/, /"ask_user"/, /"exit_plan_mode"/],
} = {}) {
  const fd = openSync(file, "r");
  let size;
  let mtimeMs;
  try {
    const st = fstatSync(fd);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } finally {
    closeSync(fd);
  }
  if (size === 0) return { events: [], badLines: 0, carry: "", offset: 0, size, mtimeMs, error: null };
  if (!isZstd(file)) {
    const raw = readRange(file, 0, Number.MAX_SAFE_INTEGER);
    const parsed = parseLines(raw.toString("utf8"));
    return { ...parsed, offset: 0, size, mtimeMs, error: null };
  }
  const from = Math.max(0, size - maxBytes);
  const raw = readRange(file, from, size);
  const buf = Buffer.from(raw);
  const candidates = frameCandidates(buf);
  if (!candidates.length) {
    return { events: [], badLines: 0, carry: "", offset: size, size, mtimeMs, error: "no-frame" };
  }

  // 从末尾往前逐帧解码（每帧只解一次，结果留着复用）。
  // 记录第一个「带等待标记」的帧；找不到就只覆盖最近 maxFrames 帧。
  const frames = []; // 升序：{start, end, events}
  let markerStart = null;
  let matched = 0;
  const limit = Math.max(1, Math.min(candidates.length, maxFrames));
  for (let i = candidates.length - 1; i >= candidates.length - limit; i -= 1) {
    const f = decodeFrame(buf, candidates, i);
    if (!f) continue;
    frames.unshift(f);
    const text = JSON.stringify(f.events);
    if (markers.some((re) => re.test(text))) {
      matched += 1;
      markerStart = f.start;
      if (matched >= lookback) break;
    }
  }
  if (!frames.length) {
    return { events: [], badLines: 0, carry: "", offset: size, size, mtimeMs, error: "no-valid-frame" };
  }

  // 末尾最后一帧之后还有字节：要么是正在写入的半帧（魔数还在），要么是腐坏垃圾。
  // 两种情况都必须让上层知道，不能把「只读到一半」当成完整证据。
  const lastEndAbs = from + frames.at(-1).end;
  const tailBytes = Math.max(0, size - lastEndAbs);
  let tailKind = null;
  if (tailBytes > 0) {
    const t = readRange(file, lastEndAbs, Math.min(size, lastEndAbs + 4));
    tailKind = t.length >= 4 && t.readUInt32LE(0) === MAGIC ? "partial-frame" : "garbage";
  }
  const tail = { tailBytes, tailKind };

  const startPos = markerStart ?? frames[0].start;
  // 很常见的情形：标记帧就是窗口里的第一帧，已经解过——直接拼，不重复解。
  if (startPos === frames[0].start) {
    const events = frames.flatMap((f) => f.events);
    const brk = continuityBreak(events);
    if (brk >= 0) {
      return { events: [], badLines: 0, carry: "", offset: size, size, mtimeMs, error: `seq-break-at:${brk}` };
    }
    return {
      events,
      badLines: 0,
      carry: "",
      offset: from + startPos,
      size,
      mtimeMs,
      windowStart: from,
      truncated: !events.some((e) => e?.seq === 0) || tailKind === "partial-frame",
      ...tail,
      error: null,
    };
  }

  // 标记帧比窗口里的第一帧更早：从标记帧连续解到末尾，失败就往后挪。
  const absoluteStart = from + startPos;
  const forward = readRange(file, absoluteStart, Number.MAX_SAFE_INTEGER);
  const cands2 = frameCandidates(forward);
  const starts = [0, ...cands2.filter((x) => x !== 0)].slice(0, 5);
  for (const s of starts) {
    const { text, error } = decodeFrom(forward.subarray(s), 0);
    if (error) continue;
    const parsed = parseLines(text);
    if (!parsed.events.length) continue;
    const brk = continuityBreak(parsed.events);
    if (brk >= 0) continue;
    return {
      events: parsed.events,
      badLines: parsed.badLines,
      carry: parsed.carry,
      offset: absoluteStart + s,
      size,
      mtimeMs,
      windowStart: from,
      truncated: !parsed.events.some((e) => e?.seq === 0),
      error: parsed.badLines > 0 ? `bad-lines:${parsed.badLines}` : null,
    };
  }
  return {
    events: [],
    badLines: 0,
    carry: "",
    offset: size,
    size,
    mtimeMs,
    windowStart: from,
    error: "no-valid-window",
  };
}

// 尾部窗口（不带回看）：从文件末尾往回最多 maxBytes 找可信帧起点，只解这一段。
export function readTail(file, { maxBytes = 512 * 1024, maxCandidates = 12 } = {}) {
  const fd = openSync(file, "r");
  let size;
  let mtimeMs;
  try {
    const st = fstatSync(fd);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } finally {
    closeSync(fd);
  }
  if (size === 0) return { events: [], badLines: 0, carry: "", offset: 0, size, mtimeMs, error: null };
  const from = Math.max(0, size - maxBytes);
  const raw = readRange(file, from, size);
  const candidates = frameCandidates(raw);
  // 从最靠后的候选往前试；0 号候选在 from>0 时不可信（可能是半个帧的中间）。
  const order = candidates.slice().reverse().slice(0, maxCandidates);
  if (from === 0 && !order.includes(0)) order.push(0);
  const tried = [];
  for (const pos of order) {
    const absolute = from + pos;
    // 只从窗口内的候选起解；窗口起点之前的帧不该被当作从中间开始解。
    const slice = raw.subarray(pos);
    const { text, error } = decodeFrom(slice, 0);
    if (error) { tried.push({ at: absolute, error }); continue; }
    const parsed = parseLines(text);
    if (!parsed.events.length) { tried.push({ at: absolute, error: "empty" }); continue; }
    if (parsed.badLines > 0) { tried.push({ at: absolute, error: `bad-lines:${parsed.badLines}` }); continue; }
    const brk = continuityBreak(parsed.events);
    if (brk >= 0) { tried.push({ at: absolute, error: `seq-break-at:${brk}` }); continue; }
    return {
      events: parsed.events,
      badLines: 0,
      carry: parsed.carry,
      offset: absolute,
      size,
      mtimeMs,
      windowStart: from,
      error: null,
    };
  }
  return {
    events: [],
    badLines: 0,
    carry: "",
    offset: size,
    size,
    mtimeMs,
    windowStart: from,
    error: order.length ? `no-valid-frame:${JSON.stringify(tried).slice(0, 300)}` : "no-frame",
    tried,
  };
}

// 增量追加：从 offset 解到文件末尾。offset 必须是上次读到的帧边界（上次的 size）。
// 校验：新事件第一条 seq 必须等于 expectedSeq+1（expectedSeq 为 null 时跳过），
// 否则返回 error 让上层标 unknown，而不是把乱序数据当真。
export function readAppend(file, offset, { expectedSeq = null, carry = "" } = {}) {
  const raw = readRange(file, offset, Number.MAX_SAFE_INTEGER);
  if (raw.length === 0) return { events: [], badLines: 0, carry, size: offset, error: null, appended: 0 };
  const { text, error } = decodeFrom(raw, 0);
  if (error) {
    return { events: [], badLines: 0, carry, size: offset, error, appended: raw.length };
  }
  const parsed = parseLines(text, carry);
  if (parsed.badLines > 0) {
    return { events: [], badLines: parsed.badLines, carry: parsed.carry, size: offset, error: `bad-lines:${parsed.badLines}`, appended: raw.length };
  }
  // 还没解出任何事件（帧写到一半）：不前进 offset、不留下 carry，
  // 下次从同一帧起点重读整帧——半个帧不是「一行」，不能按行拼接。
  if (!parsed.events.length) {
    return { events: [], badLines: 0, carry: "", size: offset, error: null, appended: raw.length };
  }
  if (expectedSeq != null && parsed.events.length) {
    const spans = seqSpan(parsed.events);
    if (spans.first != null && spans.first !== expectedSeq + 1) {
      return { events: [], badLines: 0, carry: parsed.carry, size: offset, error: `seq-gap:expected:${expectedSeq + 1}:got:${spans.first}`, appended: raw.length };
    }
  }
  return { events: parsed.events, badLines: 0, carry: parsed.carry, size: offset + raw.length, error: null, appended: raw.length };
}

// 整份解码：只给工具/测试用（会话详情、语料、差分 oracle），HUD 热路径禁止调用。
// 必须分块喂给流式解码器：一次性 push 20MB（一万多个帧）会递归过深，
// 抛 "Maximum call stack size exceeded"（实测 4/197 份文件命中）。
export function readAll(file) {
  const raw = readRange(file, 0, Number.MAX_SAFE_INTEGER);
  if (!isZstd(file)) {
    const parsed = parseLines(raw.toString("utf8"));
    return { ...parsed, bytes: raw.length, error: null };
  }
  let text = "";
  let error = null;
  const dec = new Decompress((chunk) => {
    text += Buffer.from(chunk).toString("utf8");
  });
  const CHUNK = 256 * 1024;
  try {
    for (let i = 0; i < raw.length; i += CHUNK) {
      dec.push(new Uint8Array(raw.subarray(i, Math.min(raw.length, i + CHUNK))));
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const parsed = parseLines(text);
  return { ...parsed, bytes: raw.length, error };
}
