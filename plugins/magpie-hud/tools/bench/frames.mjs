// 帧读取基准 + 差分自检：
//   1) 197 份真实转录的冷启动读窗耗时（p50/p95）；
//   2) 热更新（追加一个真实帧）耗时；
//   3) 读窗事件必须是整份解码结果的**后缀**（同一份字节，两条路径必须一致）。
//
// 用法：node tools/bench/frames.mjs
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readAll, readAppend, readWindow, seqSpan } from "../../lib/truth/frames.mjs";

function root() {
  const given = process.env.DSH_HOME;
  if (typeof given === "string" && given) return given.endsWith("sessions") ? given : join(given, "sessions");
  return join(homedir(), ".dsh", "sessions");
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl.zstd")) out.push(p);
  }
  return out;
}

const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const files = walk(root()).sort();
const cold = [];
const sizes = [];
const errors = [];
const mismatches = [];
const WINDOW = 1024 * 1024;

for (const file of files) {
  const st = statSync(file);
  sizes.push(st.size);
  const t0 = performance.now();
  const w = readWindow(file, { maxBytes: WINDOW });
  cold.push({ file, ms: performance.now() - t0, events: w.events.length, error: w.error, size: st.size, truncated: w.truncated });
  if (w.error) errors.push({ file, error: w.error });

  // 差分：窗口事件必须是全量事件的连续后缀（seq 对齐），否则说明帧边界判断有误。
  if (st.size < 24 * 1024 * 1024 && w.events.length) {
    try {
      const all = readAll(file);
      const seqs = all.events.filter((e) => typeof e?.seq === "number").map((e) => e.seq);
      const wseqs = w.events.filter((e) => typeof e?.seq === "number").map((e) => e.seq);
      const tail = seqs.slice(seqs.length - wseqs.length);
      const same = tail.length === wseqs.length && tail.every((v, i) => v === wseqs[i]);
      if (!same) mismatches.push({ file, all: seqs.length, win: wseqs.length });
    } catch (error) {
      mismatches.push({ file, error: String(error) });
    }
  }
}

const hot = [];
const dir = mkdtempSync(join(tmpdir(), "hud-bench-"));
try {
  const src = files.find((f) => statSync(f).size > 200_000 && statSync(f).size < 3_000_000) ?? files[0];
  const copy = join(dir, "copy.zstd");
  copyFileSync(src, copy);
  const w = readWindow(copy, { maxBytes: WINDOW });
  let last = seqSpan(w.events).last ?? 0;
  let offset = w.size;
  for (let i = 0; i < 25; i += 1) {
    last += 1;
    const frame = Buffer.from(zstdCompressSync(Buffer.from(JSON.stringify({ type: "job/registered", seq: last, time: Date.now(), data: { jobId: "bench" + i } }) + "\n")));
    writeFileSync(copy, frame, { flag: "a" });
    const t0 = performance.now();
    const next = readAppend(copy, offset, { expectedSeq: last - 1 });
    hot.push({ ms: performance.now() - t0, bytes: frame.length, ok: !next.error, error: next.error });
    offset = next.size ?? offset;
    if (next.error) break;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const out = {
  at: new Date().toISOString(),
  root: root(),
  files: files.length,
  bytes: sizes.reduce((a, b) => a + b, 0),
  cold: {
    p50: q(cold.map((c) => c.ms), 50),
    p95: q(cold.map((c) => c.ms), 95),
    max: Math.max(...cold.map((c) => c.ms)),
    events: cold.reduce((a, c) => a + c.events, 0),
    windowEventsP50: q(cold.map((c) => c.events), 50),
  },
  hot: {
    count: hot.length,
    p50: q(hot.map((h) => h.ms), 50),
    p95: q(hot.map((h) => h.ms), 95),
    perMBp95: q(hot.map((h) => (h.ms / h.bytes) * 1048576), 95),
    errors: hot.filter((h) => !h.ok).length,
  },
  errors,
  differentialMismatches: mismatches,
  truncatedWindows: cold.filter((c) => c.truncated).length,
};

writeFileSync(join(process.cwd(), "corpus", "bench-frames.json"), JSON.stringify({ ...out, coldDetail: cold.sort((a, b) => b.ms - a.ms).slice(0, 10) }, null, 2));
console.log(JSON.stringify({ ...out, coldDetail: undefined }, null, 2));
