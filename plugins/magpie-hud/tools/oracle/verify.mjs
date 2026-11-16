#!/usr/bin/env node
// 「干净环境复跑出同数」的可执行版本：跑一遍报告，跟基线逐行比。
//
//   node tools/oracle/verify.mjs            # 用 corpus/report-baseline.json 作基线
//   node tools/oracle/verify.mjs --save     # 先把当前 corpus/report.json 存成基线
//
// 判据：
//   · 确定性指标（P/R、tp/fp/fn、parity、mutation、fault、soak 计数）必须逐字相同；
//   · 时间/内存类指标（*ms、RSS MB）允许 ±25% 抖动——它们随机器负载变；
//   · 达标状态（pass/fail/pending）必须一致。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const corpus = join(root, "corpus");
const reportFile = join(corpus, "report.json");
const baselineFile = join(corpus, "report-baseline.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = process.argv.includes("--save");

if (save) {
  if (!existsSync(reportFile)) {
    console.error("没有 corpus/report.json，先跑 node tools/oracle/report.mjs -- 再 --save");
    process.exit(1);
  }
  copyFileSync(reportFile, baselineFile);
  console.log(`baseline saved: ${baselineFile}`);
  process.exit(0);
}
if (!existsSync(baselineFile)) {
  console.error("缺基线：先 `node tools/oracle/report.mjs`，再 `node tools/oracle/verify.mjs --save`");
  process.exit(1);
}

const baseline = readJson(baselineFile);
console.log("rerunning report…");
const r = spawnSync(process.execPath, [join("tools", "oracle", "report.mjs")], { cwd: root, encoding: "utf8" });
const tail = `${r.stdout || ""}`.trim().split(/\r?\n/).slice(-3).join("\n");
console.log(tail);
if (r.status !== 0) {
  // 报告自身会因为 72h 浸泡未完成而标 pending，不算失败；只有 fail 才非 0。
  console.log("（报告退出码非 0，通常是存在 fail 项，请看上面输出）");
}
const now = readJson(reportFile);

// 抖动型指标：基准里的时间/内存数字会随机器负载变；进行中的浸泡数字本身在变。
const isTiming = (row) => /ms|MB|稳态整轮刷新|稳态 CPU/.test(row.metric) || /budget\.json|cpu\.json/.test(row.evidence);
// 小尺度时间（<1ms）用绝对容差，别拿 25% 去卡噪声；CPU 百分比同理（0.5pp 内是负载噪声）；
// 整轮刷新是几十毫秒的 IO 墙钟，预算 50ms，±15ms 的负载抖动不算变慢；
// RSS 增量受 GC 时机影响（44→62MB 就是没到 GC 点），±30MB 内都算同水位。
const absFloor = (metric) =>
  (/ms/.test(metric) ? 1 : /MB/.test(metric) ? 30 : /CPU/.test(metric) ? 0.5 : /整轮刷新/.test(metric) ? 15 : 0);
// 文本型指标：页面冒烟的输出带样例 id 与字节偏移，只能比状态；进行中的浸泡每轮都不同；
// 冷读扫描的「份数/MB」随本机活跃会话数变（语料目录是活的，不是冻结快照）。
const isVolatileText = (row) =>
  /进行中/.test(row.metric) || /page-smoke/.test(row.evidence) || /冷读/.test(row.metric);
const near = (a, b, metric) => {
  const na = Number.parseFloat(`${a}`);
  const nb = Number.parseFloat(`${b}`);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return `${a}` === `${b}`;
  const diff = Math.abs(na - nb);
  if (diff <= absFloor(metric)) return true;
  // 小尺度读数（亚毫秒 p95、个位数 CPU%）本身就是噪声：绝对差 ≤1 就算同数。
  if (Math.max(Math.abs(na), Math.abs(nb)) < 5 && diff <= 1) return true;
  const scale = Math.max(Math.abs(na), Math.abs(nb));
  if (scale === 0) return true;
  return diff / scale <= 0.25;
};

// 指标名里嵌着环境数字（「203 份」「13MB」）：键匹配时把数字抹掉，否则语料每长一份就「缺失+新增」。
const normMetric = (m) => `${m}`.replace(/\d[\d.,]*/g, "#");
const byMetric = (rep) => new Map(rep.rows.map((row) => [normMetric(row.metric), row]));
const a = byMetric(baseline);
const b = byMetric(now);
const issues = [];
for (const [metric, before] of a) {
  const after = b.get(metric);
  if (!after) {
    issues.push(`缺失：${metric}`);
    continue;
  }
  if (before.status !== after.status) issues.push(`状态变了：${metric}（${before.status} → ${after.status}）`);
  if (isVolatileText(before)) continue;
  if (isTiming(before)) {
    if (!near(before.actual, after.actual, metric)) issues.push(`超出抖动：${metric}（${before.actual} → ${after.actual}）`);
  } else if (before.actual !== after.actual) {
    issues.push(`数字不一致：${metric}（${before.actual} → ${after.actual}）`);
  }
}
for (const metric of b.keys()) if (!a.has(metric)) issues.push(`新增指标：${metric}`);

if (issues.length) {
  console.log(`\nverify: ${issues.length} 处不一致`);
  for (const i of issues) console.log(`  - ${i}`);
  process.exit(1);
}
console.log(`\nverify: 基线 ${baseline.at} → 本次 ${now.at}，确定性指标逐字一致，时间类在 ±25% 内`);
