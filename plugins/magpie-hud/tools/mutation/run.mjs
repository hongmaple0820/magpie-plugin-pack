#!/usr/bin/env node
// 变异测试：对语义核心 lib/truth/fold.mjs 注入「语义型」突变，看测试能不能杀掉。
//
// 为什么不用 Stryker：本仓库零新依赖（见 docs/magpie-hud-v6-depth-plan.md 的决策）。
// 变异表是手写的——每条都对应一个真实语义分支，不是随机改字符；随机改字符只会
// 产生语法错误和等价突变，分数没有意义。
//
// 判定：
//   · 先 import 一次突变体：语法/运行时加载失败 → 记为 invalid（不计入分母）；
//   · 跑 truth-fold / truth-collect 两套测试：非 0 退出 → killed；全绿 → survived；
//   · 分数 = killed / (killed + survived)，invalid 单独列出。
//
// 用法：node tools/mutation/run.mjs [--json]
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, "..", "..");
const target = join(plugin, "lib", "truth", "fold.mjs");
const tests = ["test/truth-fold.test.mjs", "test/truth-collect.test.mjs"];

const MUTANTS = [
  { id: "unknown-priority", from: "if (state.unknown) {", to: "if (!state.unknown) {" },
  { id: "ask-drop-error", from: "a.resultSeen && !a.resultError && !a.answered", to: "a.resultSeen" },
  { id: "ask-error-invert", from: "a.resultSeen && !a.resultError && !a.answered", to: "a.resultSeen && a.resultError" },
  { id: "ask-answered-invert", from: "&& !a.answered", to: "&& a.answered" },
  { id: "open-any-to-all", from: "if (openTurns || openSteps || openJobs) {", to: "if (openTurns && openSteps && openJobs) {" },
  { id: "user-input-and", from: 'if (state.lastType === "user/message" || state.lastType === "agent/inbox/spliced") {', to: 'if (state.lastType === "user/message" && state.lastType === "agent/inbox/spliced") {' },
  { id: "paused-threshold", from: "if (state.counts.turns > 0)", to: "if (state.counts.turns >= 0)" },
  { id: "starting-invert", from: "if (state.sessionId) return", to: "if (!state.sessionId) return" },
  { id: "dup-seq", from: "if (seq != null && seq <= state.lastSeq) return state;", to: "if (seq != null && seq < state.lastSeq) return state;" },
  { id: "surfaceop-gate", from: 'if (ev.surfaceOp && ev.surfaceOp !== "append") {', to: 'if (ev.surfaceOp && ev.surfaceOp === "append") {' },
  { id: "replace-invert", from: 'ev.surfaceOp.op === "replace"', to: 'ev.surfaceOp.op !== "replace"' },
  { id: "iserror-invert", from: "resultError: d.message?.isError === true,", to: "resultError: d.message?.isError === false," },
  { id: "answered-regex", from: '/"answers"\\s*:/.test(text),', to: '/"answers"/.test(text),', equivalent: "对 {\"answers\":…} 两个正则都成立，属于等价突变" },
  { id: "stuck-gate", from: "if (stuck.length) {", to: "if (!stuck.length) {" },
  { id: "stuck-match", from: "filter(([, a]) => a.callId === callId)", to: "filter(([, a]) => a.callId !== callId)" },
  { id: "interrupt-invert", from: 'd.reason?.kind === "interrupted" && Object.keys(s.approvals).length', to: 'd.reason?.kind !== "interrupted" && Object.keys(s.approvals).length' },
  { id: "user-kind-invert", from: 'if (d?.source?.kind === "user") {', to: 'if (d?.source?.kind !== "user") {' },
  { id: "inbox-kind", from: 'items.some((it) => it?.source?.kind === "user")', to: 'items.some((it) => it?.source?.kind === "assistant")' },
  { id: "close-running-asks", from: "if (!a.resultSeen) next[id] = a;\n        s.asks = next;\n        s.lastUserMessageSeq = seq;\n      }\n      break;\n    }\n    case \"agent/inbox/spliced\"", to: "if (a.resultSeen) next[id] = a;\n        s.asks = next;\n        s.lastUserMessageSeq = seq;\n      }\n      break;\n    }\n    case \"agent/inbox/spliced\"" },
  { id: "gap-compare", from: "if (expected != null && seq != null && seq !== expected) {", to: "if (expected != null && seq != null && seq === expected) {" },
  { id: "fold-dup", from: "if (seq != null && seq <= s.lastSeq) continue;", to: "if (seq != null && seq < s.lastSeq) continue;", equivalent: "reduce 自身也挡重复 seq，fold 的提前跳过只是快路径" },
  { id: "clear-unknown", from: 'if (s.unknown?.reason === "no-evidence") s.unknown = null;', to: 'if (s.unknown?.reason !== "no-evidence") s.unknown = null;' },
  { id: "phase-detect", from: "if (state.phase !== phase) {", to: "if (state.phase === phase) {" },
  { id: "tokens-swap", from: "input: state.tokens.input + (Number(usage.inputTokens) || 0),", to: "input: state.tokens.input + (Number(usage.outputTokens) || 0)," },
  { id: "call-id-gate", from: "if (callId) s.calls = { ...state.calls, [callId]", to: "if (!callId) s.calls = { ...state.calls, [callId]" },
  { id: "ask-tool-exit-plan", from: '/(^|[^a-z])(ask_user|exit_plan_mode)/', to: '/(^|[^a-z])(ask_user)/' },
  { id: "approval-turn", from: "turn: s.currentTurn ?? null }", to: "turn: null }" },
  { id: "count-turns", from: "turns: state.counts.turns + 1 }", to: "turns: state.counts.turns }" },
  { id: "session-id", from: 's.sessionId = String(ev.id ?? s.sessionId ?? "");', to: 's.sessionId = String(s.sessionId ?? "");' },
  { id: "event-time", from: "if (typeof ev.time === \"number\") s.lastEventAt = ev.time;", to: "if (typeof ev.time === \"number\") s.lastEventAt = null;" },
];

function run(cmd, args) {
  const out = spawnSync(cmd, args, { cwd: plugin, encoding: "utf8", timeout: 120_000, env: { ...process.env, DSH_HOME: "", MAGPIE_HUD_SESSIONS_CACHE: join(plugin, "corpus", "mutation-cache.json") } });
  return { code: out.status, out: (out.stdout ?? "") + (out.stderr ?? "") };
}

const original = readFileSync(target, "utf8");
const results = [];
let invalid = 0;
try {
  for (const m of MUTANTS) {
    if (m.equivalent) {
      results.push({ ...m, status: "equivalent" });
      continue;
    }
    const hits = original.split(m.from).length - 1;
    if (hits !== 1) {
      results.push({ ...m, status: "skipped", note: `anchor matched ${hits} times` });
      continue;
    }
    writeFileSync(target, original.replace(m.from, m.to));
    const load = run(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(target).href)}).then(()=>process.exit(0),e=>{console.error(String(e));process.exit(3)})`]);
    if (load.code === 3) {
      invalid++;
      results.push({ ...m, status: "invalid", note: load.out.split("\n")[0] });
      continue;
    }
    const t = run(process.execPath, ["--test", ...tests]);
    const status = t.code === 0 ? "survived" : "killed";
    results.push({ ...m, status });
    process.stdout.write(`${status === "killed" ? "K" : "S"} ${m.id}\n`);
  }
} finally {
  writeFileSync(target, original);
}

const killed = results.filter((r) => r.status === "killed").length;
const survived = results.filter((r) => r.status === "survived").length;
const skipped = results.filter((r) => r.status === "skipped").length;
const score = killed + survived ? killed / (killed + survived) : 0;
const report = {
  at: new Date().toISOString(),
  target: "lib/truth/fold.mjs",
  tests,
  killed,
  survived,
  invalid,
  skipped,
  score: Math.round(score * 1000) / 1000,
  survivors: results.filter((r) => r.status === "survived").map((r) => r.id),
  mutants: results,
};
if (process.argv.includes("--json")) {
  process.stdout.write("\n" + JSON.stringify(report, null, 2) + "\n");
} else {
  mkdirSync(join(plugin, "corpus"), { recursive: true });
  writeFileSync(join(plugin, "corpus", "mutation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`\nmutation score ${report.score} (${killed} killed / ${survived} survived / ${invalid} invalid / ${skipped} skipped)`);
  if (report.survivors.length) console.log("survivors:", report.survivors.join(", "));
}
process.exit(score >= 0.75 ? 0 : 1);
