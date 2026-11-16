// tap：DSH 进程内插件抄下的事件（channel/tap/<session>.jsonl）。
//
// 它和转录是两份独立落盘：转录可能滞后（帧还没 flush）、可能读不懂（新版本编码），
// tap 不会——它是 committed event 的直抄。所以 tap 用来仲裁，不用来替代历史：
//   · tap 更靠后（lastSeq 更大）→ 用 tap 的结论；
//   · 两边都读到同一 lastSeq → 结论必须一致，不一致就是 unknown（不猜）。
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export function tapPath(tapDir, sessionId) {
  if (typeof tapDir !== "string" || !tapDir) return null;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return join(tapDir, sessionId + ".jsonl");
}

/**
 * 增量读：只读 from 之后的字节，返回新事件与新的消费位置。
 * tap 的写入方用 appendFileSync 整行追加，所以中途 offset 一定落在行首。
 */
export function readTapFrom(file, from = 0, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const absent = { exists: false, events: [], badLines: 0, next: from, size: 0, mtimeMs: 0, rotated: false };
  if (!file) return absent;
  let st;
  try {
    st = statSync(file);
  } catch {
    return absent;
  }
  if (st.size < from) {
    // 被滚动改写过：从 0 重读，调用方负责重置状态。
    return { ...readTap(file, { maxBytes }), rotated: true, next: st.size };
  }
  if (st.size === from) return { exists: true, events: [], badLines: 0, next: from, size: st.size, mtimeMs: st.mtimeMs, rotated: false };
  const length = st.size - from;
  if (length > maxBytes) return { ...absent, exists: true, size: st.size, mtimeMs: st.mtimeMs, error: `tap-jump:${length}` };
  const buf = Buffer.allocUnsafe(length);
  let fd = null;
  try {
    fd = openSync(file, "r");
    readSync(fd, buf, 0, length, from);
  } catch (error) {
    return { ...absent, exists: true, size: st.size, mtimeMs: st.mtimeMs, error: String(error?.message ?? error) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  let next = st.size;
  // 末尾半行：留着下次读，不解析、不前进。
  if (lines[lines.length - 1] !== "") {
    lines.pop();
    next = st.size - Buffer.byteLength(text.slice(text.lastIndexOf("\n") + 1));
  }
  const events = [];
  let badLines = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row.type !== "string" || !(Number.isFinite(row.seq) || (row.type === "session" && row.seq == null))) {
        badLines += 1;
        continue;
      }
      events.push(row);
    } catch {
      badLines += 1;
    }
  }
  return { exists: true, events, badLines, next, size: st.size, mtimeMs: st.mtimeMs, rotated: false };
}
/**
 * 读 tap 文件。尾部半行（进程被杀留下的）直接丢掉——半行不是一个事件。
 * 返回 exists=false 表示没有 tap（插件没装/没跑），不是错误。
 */
export function readTap(file, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const absent = { exists: false, events: [], badLines: 0, firstSeq: null, lastSeq: null, size: 0, mtimeMs: 0 };
  if (!file) return absent;
  let st;
  try {
    st = statSync(file);
  } catch {
    return absent;
  }
  if (st.size > maxBytes) {
    return { ...absent, exists: true, size: st.size, mtimeMs: st.mtimeMs, error: `tap-too-big:${st.size}` };
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { ...absent, exists: true, size: st.size, mtimeMs: st.mtimeMs, error: String(error?.message ?? error) };
  }
  const events = [];
  let badLines = 0;
  const lines = text.split("\n");
  // 末尾若是空串，说明最后一行有换行、完整；否则最后一段是半行。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  else if (lines.length > 0 && !text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row.type !== "string" || !(Number.isFinite(row.seq) || (row.type === "session" && row.seq == null))) {
        badLines += 1;
        continue;
      }
      events.push(row);
    } catch {
      badLines += 1;
    }
  }
  const firstSeq = events.length ? events[0].seq : null;
  const lastSeq = events.length ? events[events.length - 1].seq : null;
  return { exists: true, events, badLines, firstSeq, lastSeq, size: st.size, mtimeMs: st.mtimeMs };
}
