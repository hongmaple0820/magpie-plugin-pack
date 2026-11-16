#!/usr/bin/env node
// 稳态 CPU 采样：模拟面板刷新（默认 5s 一轮），连续 60s 记 process.cpuUsage，
// 给出「占单核百分比」。这是宿主里真实进程的口径，不是按耗时折算。
//
//   node tools/bench/cpu.mjs            # 60s 采样，5s 刷新
//   CPU_SECONDS=600 CPU_REFRESH_MS=10000 node tools/bench/cpu.mjs   # 10 分钟口径
//
// 判据：≤ 1.5% 单核（docs/magpie-hud-v6-depth-plan.md §6）。
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionTruth, resetTruthCache } from "../../lib/truth/collect.mjs";

const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const budgetPct = Number(process.env.CPU_BUDGET_PCT ?? 1.5);
const seconds = Number(process.env.CPU_SECONDS ?? 60);
const refreshMs = Number(process.env.CPU_REFRESH_MS ?? 5000);

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
    else if (name.endsWith(".jsonl.zstd")) out.push(p);
  }
  return out;
}

const files = walk(join(dshHome, "sessions"));
resetTruthCache();
for (const f of files) sessionTruth(f); // 先冷一轮，让备忘录进入稳态

const cpu0 = process.cpuUsage();
const wall0 = performance.now();
let cycles = 0;
let totalCpuMs = 0;
const samples = [];
let nextRefresh = performance.now();
while (performance.now() - wall0 < seconds * 1000) {
  if (performance.now() >= nextRefresh) {
    const c0 = process.cpuUsage();
    for (const f of files) sessionTruth(f);
    const c = process.cpuUsage(c0);
    const cpuMs = (c.user + c.system) / 1000;
    totalCpuMs += cpuMs;
    cycles++;
    samples.push(Math.round((cpuMs / refreshMs) * 10000) / 100); // 该轮占单核 %
    nextRefresh += refreshMs;
  } else {
    await new Promise((r) => setTimeout(r, 20));
  }
}
const wallMs = performance.now() - wall0;
const cpu = process.cpuUsage(cpu0);
const cpuPct = Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 10000) / 100;
const peak = Math.max(0, ...samples);
const sorted = [...samples].sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;

const report = {
  at: new Date().toISOString(),
  files: files.length,
  seconds: Math.round(wallMs / 1000),
  refreshMs,
  cycles,
  cpuPct,
  peakPct: peak,
  p95Pct: p95,
  totalCpuMs: Math.round(totalCpuMs),
  budgetPct,
  ok: cpuPct <= budgetPct,
  samplesPct: samples,
};
const out = join(import.meta.dirname, "..", "..", "corpus");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "cpu.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`cpu: ${cycles} 轮 / ${report.seconds}s，均值 ${cpuPct}% 单核（p95 ${p95}%、峰值 ${peak}%），判据 ≤${budgetPct}% → ${report.ok ? "ok" : "FAIL"}`);
process.exit(report.ok ? 0 : 1);
