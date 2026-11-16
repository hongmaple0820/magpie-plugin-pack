#!/usr/bin/env node
// 浸泡：持续追加事件，看「状态永远跟着最后一条事件走」是否长期成立、内存是否增长。
//
// 72h 的完整浸泡需要宿主机常驻跑：
//   $env:SOAK_SECONDS=259200; node --expose-gc tools/soak/run.mjs
// 默认值只做冒烟（60s），结果写进 corpus/soak.json 并标明时长。
//
// 断言（收尾时一次判定，任一不满足 exit 1）：
//   · 每次调用都返回快照，且 lastSeq 等于刚追加的 seq（不滞后）；
//   · phase 不得变成 unknown（合法输入不该降级）；
//   · 回收后的常驻内存增量 ≤ 300MB；
//   · 斜率：heapUsed ≤ 0.2MB/h、rss ≤ 1MB/h（首尾各取 20% 采样的中位数）。
//
// 为什么加斜率：GC 延迟会让 RSS 出现与泄漏无关的锯齿，只看全程峰值会把一次
// 正常的延迟回收判成失败；反过来，真正的缓慢泄漏也可能在 300MB 以内。带
// --expose-gc 时每次采样前强制回收，量到的才是活对象（没带时报告里 gc:false，
// 斜率会偏大——这是口径，不是结论）。
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { sessionTruth, resetTruthCache } from "../../lib/truth/collect.mjs";

const seconds = Number(process.env.SOAK_SECONDS ?? 60);
const sessions = Number(process.env.SOAK_SESSIONS ?? 20);
// 旧版把每次迭代的延迟都推进数组（13h = 178 万个样本），采样器本身成了被测对象。
const RING = 20_000;
const LIMITS = { maxRssMB: 300, heapSlopeMBPerHour: 0.2, rssSlopeMBPerHour: 1 };
// 采样间隔跟 v6 的 10s 刷新对齐：2h 冒烟得 720 个点，够看出斜率；采样要强制 GC、
// 会打断循环，所以不能更密。
const SAMPLE_MS = 10_000;
// 全量进度（带所有样本）60s 写一次：72h 是 4320 次写盘；10s 一次要多写 6 倍、
// 每次还要序列化整个样本数组，写的 I/O 自己就会影响内存曲线。
const PROGRESS_MS = 60_000;
// 预热期不进斜率：前 10 分钟是折窗缓存与 V8 堆的长起来阶段（2h 冒烟实测
// 前 4 分 52 秒中位 RSS 就从 +37MB 涨到 +62MB），把它算进去会让任何一次
// 「先涨后平」的启动都判成泄漏；排除后斜率只回答「稳态下还涨不涨」。
const WARMUP_SEC = Number(process.env.SOAK_WARMUP_SEC ?? 600);

const gc = typeof global.gc === "function" ? global.gc : null;
const startedAt = new Date().toISOString();
const startedAtMs = Date.now();
const end = startedAtMs + seconds * 1000;
const dir = mkdtempSync(join(tmpdir(), "hud-soak-"));
resetTruthCache();

const frame = (event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + "\n"));
const files = [];
for (let i = 0; i < sessions; i++) {
  const file = join(dir, `soak-${i}.jsonl.zstd`);
  writeFileSync(file, frame({ type: "session", seq: 0, time: Date.now(), data: { id: `soak-${i}` } }));
  files.push({ file, seq: 0, turn: 0 });
}

const outDir = process.env.SOAK_OUT_DIR || join(import.meta.dirname, "..", "..", "corpus");
mkdirSync(outDir, { recursive: true });
const progressFile = join(outDir, "soak-progress.json");
const heartbeatFile = join(outDir, "soak-heartbeat.json");

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const lat = new Float64Array(RING);
let latN = 0;
let latI = 0;
const samples = [];
let base = null;
let iterations = 0;
let unknowns = 0;
let lag = 0;
let lastProgress = 0;

/** 延迟只留最近 RING 个：定长环形，内存不随迭代数增长。 */
function pushLatency(ms) {
  lat[latI] = ms;
  latI = (latI + 1) % RING;
  latN++;
}

/** 采样一次内存（有 --expose-gc 时先回收），返回刚记下的样本。 */
function takeSample() {
  if (gc) gc();
  const t = Math.round((Date.now() - startedAtMs) / 1000);
  const m = process.memoryUsage();
  if (!base) base = { rss: m.rss, heapUsed: m.heapUsed };
  const sample = {
    t,
    it: iterations,
    rssMB: mb(m.rss),
    heapUsedMB: mb(m.heapUsed),
    heapTotalMB: mb(m.heapTotal),
    externalMB: mb(m.external),
    rssDeltaMB: mb(m.rss - base.rss),
    heapUsedDeltaMB: mb(m.heapUsed - base.heapUsed),
  };
  samples.push(sample);
  return sample;
}

// 心跳每 10s 一次，只为一个问题服务：进程还在不在。停机超过 60s 即可判死，
// 不必等 72h 结束、也不必靠人记着看一眼。
function heartbeat() {
  try {
    writeFileSync(
      heartbeatFile,
      JSON.stringify({
        pid: process.pid,
        startedAt,
        elapsedSec: Math.round((Date.now() - startedAtMs) / 1000),
        iterations,
        samples: samples.length,
        at: new Date().toISOString(),
      }) + "\n",
    );
  } catch { /* 心跳写不进去不影响浸泡本身 */ }
}

// progress 带全量采样，60s 写一次；10s 一次的写盘在 72h 上是纯 I/O 负担。
function progress() {
  try {
    writeFileSync(
      progressFile,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt,
          seconds,
          sessions,
          iterations,
          unknowns,
          lag,
          gc: !!gc,
          limits: LIMITS,
          elapsedSec: Math.round((Date.now() - startedAtMs) / 1000),
          rssSamples: samples.map((s) => ({ at: s.t, mb: s.rssDeltaMB })),
          memSamples: samples,
        },
        null,
        2,
      ) + "\n",
    );
  } catch { /* 进度文件写不进去不影响浸泡本身 */ }
  lastProgress = Date.now();
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 稳态样本：跳过预热期。 */
const steadySamples = () => samples.filter((s) => s.t >= WARMUP_SEC);

/** 首尾各取 20% 稳态采样，用中位数差除以两段中位时刻的间隔（小时）。样本太少返回 null。 */
function slopePerHour(key) {
  const st = steadySamples();
  if (st.length < 10) return null;
  const k = Math.max(1, Math.floor(st.length * 0.2));
  const head = st.slice(0, k);
  const tail = st.slice(-k);
  const hours = (median(tail.map((s) => s.t)) - median(head.map((s) => s.t))) / 3600;
  if (!(hours > 0)) return 0;
  return (median(tail.map((s) => s[key])) - median(head.map((s) => s[key]))) / hours;
}

try {
  takeSample();
  progress();
  heartbeat();
  let lastSample = Date.now();
  while (Date.now() < end) {
    for (const s of files) {
      s.seq += 1;
      // 真实转录的形状：一轮里 turn/start → tool/call → tool/result → turn/end。
      // 关键在「开了就关」：state 里的 turns / calls 才保持有界。旧版每次轮换只发
      // turn/start 与 tool/call、从不发 end/result，打开的 turn/call 越积越多，
      // 每帧的 { ...state.calls } 拷贝就变成 O(n)（实测 200 帧 0.27ms → 4000 帧 1.20ms）。
      // 那样量到的不是「文件变长」，是自己的负载不真实。
      const stage = s.seq % 4;
      const nowMs = Date.now();
      const event =
        stage === 1
          ? { type: "turn/start", seq: s.seq, time: nowMs, data: { turn: ++s.turn } }
          : stage === 2
            ? { type: "tool/call", seq: s.seq, time: nowMs, data: { turn: s.turn, step: 1, callId: "c" + s.seq, name: "pwsh" } }
            : stage === 3
              ? { type: "tool/result", seq: s.seq, time: nowMs, data: { message: { source: { callId: "c" + (s.seq - 1) } } } }
              : { type: "turn/end", seq: s.seq, time: nowMs, data: { turn: s.turn } };
      appendFileSync(s.file, frame(event));
      const t = performance.now();
      const snap = sessionTruth(s.file);
      pushLatency(performance.now() - t);
      iterations++;
      if (snap.phase === "unknown") unknowns++;
      if (snap.lastSeq !== s.seq) lag++;
    }
    const now = Date.now();
    if (now - lastSample > SAMPLE_MS) {
      takeSample();
      heartbeat();
      lastSample = now;
    }
    if (now - lastProgress > PROGRESS_MS) progress();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const latArr = Array.from(lat.subarray(0, Math.min(latN, RING)));
const sorted = latArr.sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
// 峰值与斜率都只看稳态：启动期的峰值是长起来的代价，不是泄漏。
const steady = steadySamples();
const peakPool = steady.length ? steady : samples;
const maxRss = peakPool.reduce((max, s) => Math.max(max, s.rssDeltaMB), 0);
// 迭代率会随转录文件变长而下降（每帧都要过一遍折窗），所以记首尾两段，
// 不记一个平均——平均会把「一开始很快」的假象留在报告里。
const rate = (list) => {
  if (list.length < 2) return null;
  const span = list.at(-1).t - list[0].t;
  return span > 0 ? Math.round(((list.at(-1).it - list[0].it) / span) * 10) / 10 : null;
};
const firstRate = rate(samples.slice(0, Math.max(2, Math.floor(samples.length * 0.2))));
const lastRate = rate(steady.slice(-Math.max(2, Math.floor(steady.length * 0.2))));
const heapSlope = slopePerHour("heapUsedMB");
const rssSlope = slopePerHour("rssDeltaMB");
const slopeReliable = heapSlope != null && rssSlope != null;
const ok =
  unknowns === 0 &&
  lag === 0 &&
  maxRss <= LIMITS.maxRssMB &&
  (!slopeReliable || (heapSlope <= LIMITS.heapSlopeMBPerHour && rssSlope <= LIMITS.rssSlopeMBPerHour));

const report = {
  at: new Date().toISOString(),
  startedAt,
  seconds: Math.round((Date.now() - startedAtMs) / 1000),
  plannedSeconds: seconds,
  sessions,
  iterations,
  unknowns,
  lag,
  p95Ms: round2(p95),
  maxLatencyMs: round2(sorted.at(-1) ?? 0),
  gc: !!gc,
  warmupSec: WARMUP_SEC,
  steadySampleCount: steady.length,
  iterationsPerSec: { first: firstRate, last: lastRate },
  limits: LIMITS,
  sampleCount: samples.length,
  slopeReliable,
  heapSlopeMBPerHour: slopeReliable ? round2(heapSlope) : null,
  rssSlopeMBPerHour: slopeReliable ? round2(rssSlope) : null,
  maxRssDeltaMB: maxRss,
  rssSamples: samples.map((s) => ({ at: s.t, mb: s.rssDeltaMB })),
  memSamples: samples,
  ok,
  full72hCommand: "SOAK_SECONDS=259200 node --expose-gc tools/soak/run.mjs",
};
writeFileSync(join(outDir, "soak.json"), JSON.stringify(report, null, 2) + "\n");
rmSync(progressFile, { force: true }); // 完成即撤掉「进行中」标记
rmSync(heartbeatFile, { force: true });

console.log(
  `soak ${report.seconds}s: ${iterations} iterations, unknown=${unknowns}, lag=${lag}, p95=${report.p95Ms}ms, rss+${maxRss}MB${gc ? " (gc)" : ""}`,
);
if (slopeReliable) console.log(`slopes: heap ${round2(heapSlope)}MB/h, rss ${round2(rssSlope)}MB/h`);
console.log(ok ? "PASS" : "FAIL (see corpus/soak.json)");
process.exit(ok ? 0 : 1);
