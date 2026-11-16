#!/usr/bin/env node
// 性能预算：把 docs/magpie-hud-v6-depth-plan.md §6 的数字变成可执行断言。
//
// 预算（本机实测校准后）：
//   · 全量冷读 198 份转录（约 281MB）：总耗时 ≤ 20s，p95 ≤ 120ms/文件；
//   · 热更新（追加一帧后重算）：p95 ≤ 30ms；
//   · 常驻内存：RSS 增量 ≤ 300MB（不缓存整份文本）。
//
// 输出 corpus/budget.json；超预算退出码 1。
import { readdirSync, statSync, copyFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readWindow } from "../../lib/truth/frames.mjs";
import { sessionTruth, resetTruthCache } from "../../lib/truth/collect.mjs";

const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
function walk(dir, out = []) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".jsonl.zstd")) out.push({ file: p, size: st.size, sizeKB: Math.round(st.size / 1024) });
  }
  return out;
}

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const files = walk(join(dshHome, "sessions")).filter((f) => f.size < 40 * 1024 * 1024);
const budgets = { coldTotalMs: 20_000, coldP95Ms: 120, hotP95Ms: 30, rssDeltaMB: 300 };

const rss0 = process.memoryUsage().rss;
// 冷读：每次先换一个不存在的路径清掉 fzstd 之外没有缓存，readWindow 本身无状态。
const cold = [];
let readBytes = 0;
const t0 = performance.now();
for (const f of files) {
  const a = performance.now();
  const w = readWindow(f.file);
  // 只统计真正读进来的字节（尾部窗口），不是文件大小——否则「198 份 / 288MB 读得快」是假的。
  if (w && Number.isFinite(w.size) && Number.isFinite(w.offset)) readBytes += Math.max(0, w.size - w.offset);
  cold.push({ file: f.file, sizeKB: f.sizeKB, ms: Math.round((performance.now() - a) * 10) / 10 });
}
const coldTotalMs = Math.round(performance.now() - t0);
const coldP95 = percentile(cold.map((c) => c.ms), 95);

// 热更新：复制一份会话，追加 25 个合成帧，每次都走 sessionTruth（备忘录命中 + readAppend）。
resetTruthCache();
const tmp = mkdtempSync(join(tmpdir(), "hud-budget-"));
const src = files.sort((a, b) => b.size - a.size)[0];
const hotFile = join(tmp, "hot.jsonl.zstd");
copyFileSync(src.file, hotFile);
const hot = [];
let seq = 1;
try {
  const first = sessionTruth(hotFile); // 冷启动一次
  // 合成帧的 seq 必须接上真实文件的最后一条；否则 readAppend 会判定 seq 缺口并退回整窗重读，
  // 那测到的就不是热路径了（第一次跑正是踩了这个坑：30ms 其实是 readWindow）。
  seq = (first?.lastSeq ?? 0) + 1; // 快照的 lastSeq 在顶层
  for (let i = 0; i < 25; i++) {
    const frame = zstdCompressSync(Buffer.from(JSON.stringify({ type: "turn/start", seq: seq++, time: Date.now(), data: { turn: 999 } }) + "\n"));
    appendFileSync(hotFile, frame);
    const a = performance.now();
    sessionTruth(hotFile);
    hot.push(Math.round((performance.now() - a) * 100) / 100);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const hotP95 = percentile(hot, 95);
const rssDeltaMB = Math.round((process.memoryUsage().rss - rss0) / 1024 / 1024);

// 稳态 CPU：文件没变时的整轮刷新必须全部命中备忘录（否则每 10s 一次就要 5.6s CPU）。
resetTruthCache();
for (const f of files) sessionTruth(f.file); // 冷一轮
const w0 = performance.now();
for (const f of files) sessionTruth(f.file); // 暖一轮
const warmCycleMs = Math.round(performance.now() - w0);

// 帧数增长下的单帧成本：真实转录每轮都会关掉自己开的 turn 与 tool call，所以
// fold 里 { ...state.turns } / { ...state.calls } 的拷贝规模有界，单帧成本应当恒定。
// 这条断言存在的理由：浸泡曾用「只开不关」的负载，把 O(n) 拷贝量成了「文件变长」，
// 于是错误地得出「每帧成本随帧数上涨」的结论（200 帧 0.27ms → 4000 帧 1.20ms）。
// 用真实形状复测是平的（0.259ms → 0.217ms），所以这里钉住「不许变斜率」。
const growth = { frames: Number(process.env.BUDGET_GROWTH_FRAMES ?? 4000), toleranceRatio: 1.6 };
const gTmp = mkdtempSync(join(tmpdir(), "hud-growth-"));
const gFile = join(gTmp, "growth.jsonl.zstd");
let gSeq = 0;
const gPush = (body) => {
  gSeq += 1;
  appendFileSync(gFile, zstdCompressSync(Buffer.from(JSON.stringify({ ...body, seq: gSeq, time: Date.now() }) + "\n")));
  const a = performance.now();
  sessionTruth(gFile);
  return performance.now() - a;
};
const growthPoints = [];
try {
  resetTruthCache();
  writeFileSync(gFile, zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", seq: 0, time: Date.now(), data: { id: "growth" } }) + "\n")));
  const perBlock = [];
  let block = [];
  const rounds = Math.floor(growth.frames / 4);
  for (let i = 1; i <= rounds; i++) {
    const callId = "c" + i;
    block.push(gPush({ type: "turn/start", data: { turn: i } }));
    block.push(gPush({ type: "tool/call", data: { turn: i, step: 1, callId, name: "pwsh" } }));
    block.push(gPush({ type: "tool/result", data: { message: { source: { callId } } } }));
    block.push(gPush({ type: "turn/end", data: { turn: i } }));
    if (block.length >= 200) {
      perBlock.push(percentile(block, 50));
      block = [];
    }
  }
  const head = perBlock[0] ?? 0;
  const tail = perBlock.at(-1) ?? 0;
  growthPoints.push({ headMs: Math.round(head * 1000) / 1000, tailMs: Math.round(tail * 1000) / 1000, blocks: perBlock.length });
  growth.ratio = head > 0 ? Math.round((tail / head) * 100) / 100 : null;
} finally {
  rmSync(gTmp, { recursive: true, force: true });
}

const checks = [
  { name: `尾部窗口冷读 ${files.length} 份（实读 ${Math.round(readBytes / 1024 / 1024)}MB）总耗时 ≤ ${budgets.coldTotalMs}ms`, actual: coldTotalMs, ok: coldTotalMs <= budgets.coldTotalMs },
  { name: `冷读 p95 ≤ ${budgets.coldP95Ms}ms`, actual: coldP95, ok: coldP95 <= budgets.coldP95Ms },
  { name: `热更新 p95 ≤ ${budgets.hotP95Ms}ms`, actual: hotP95, ok: hotP95 <= budgets.hotP95Ms },
  { name: `RSS 增量 ≤ ${budgets.rssDeltaMB}MB`, actual: rssDeltaMB, ok: rssDeltaMB <= budgets.rssDeltaMB },
  { name: `稳态整轮刷新（${files.length} 份，备忘录命中）≤ 50ms，即 10s 刷新下的 CPU ≤0.5%`, actual: warmCycleMs, ok: warmCycleMs <= 50 },
  { name: `帧数增长下单帧成本不涨（首段 ${growthPoints[0]?.headMs ?? "?"}ms → 末段 ${growthPoints[0]?.tailMs ?? "?"}ms，比值 ≤ ${growth.toleranceRatio}）`, actual: growth.ratio, ok: growth.ratio != null && growth.ratio <= growth.toleranceRatio },
];
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name} — 实测 ${c.actual}`);

const report = {
  at: new Date().toISOString(),
  files: files.length,
  totalBytes: files.reduce((n, f) => n + f.size, 0),
  readBytes,
  coldTotalMs,
  coldP50Ms: percentile(cold.map((c) => c.ms), 50),
  coldP95Ms: coldP95,
  coldMaxMs: Math.max(...cold.map((c) => c.ms), 0),
  hotP50Ms: percentile(hot, 50),
  hotP95Ms: hotP95,
  hotMaxMs: Math.max(...hot, 0),
  rssDeltaMB,
  warmCycleMs,
  growth,
  growthPoints,
  budgets,
  checks,
};
const out = join(import.meta.dirname, "..", "..", "corpus");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "budget.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\nbudget: ${checks.filter((c) => c.ok).length}/${checks.length} pass`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
