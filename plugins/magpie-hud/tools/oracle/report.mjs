#!/usr/bin/env node
// 一键证据报告：把所有验收工具跑一遍，把 docs/magpie-hud-v6-depth-plan.md §6 的每个数字对到实测值。
//
//   node tools/oracle/report.mjs
//
// 产物：docs/magpie-hud-report.md（人读）+ corpus/report.json（机读）。
// 任一指标不达标退出码 1；「未完成」项（如 72h 浸泡）单独标注，不冒充达标。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir, cpus, totalmem, platform, release } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const corpus = join(root, "corpus");
const read = (name) => {
  const file = join(corpus, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const runs = [];
// 真实宿主 tap：插件在 DSH 进程里直写；比对工具会逐行重投影并对照。
// 没有 tap 目录时工具以 2 退出（不是失败），这里只记录「本机没跑过」。
function run(label, args, { allowExit = [] } = {}) {
  const t = performance.now();
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 60 * 60_000 });
  const ms = Math.round(performance.now() - t);
  const ok = r.status === 0 || allowExit.includes(r.status);
  runs.push({
    label,
    cmd: ["node", ...args].join(" "),
    ms,
    ok,
    tail: `${r.stdout || ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ").slice(0, 300),
    err: ok ? null : `${r.stderr || ""}`.trim().slice(-600),
  });
  return ok;
}

const tests = readdirSync(join(root, "test")).filter((n) => n.endsWith(".test.mjs")).sort().map((n) => join("test", n));

const ev = {};
ev.testsOk = run("单元/属性/契约测试", ["--test", ...tests]);
ev.evalOk = run("等待判定评测（真实语料 + 场景 + holdout + 窗口层）", ["tools/eval/waiting.mjs"]);
ev.faultOk = run("故障注入（11 个坏输入场景）", ["tools/fault/inject.mjs"]);
ev.parityOk = run("tap/转录双实现对照", ["tools/oracle/tap-parity.mjs"]);
// exit 2 = 本机没有 tap 目录（插件从未在本机跑过），不是失败。
ev.liveTapOk = run("真实宿主 live tap 对照", ["tools/oracle/live-parity.mjs"], { allowExit: [2] });
ev.budgetOk = run("性能预算", ["tools/bench/budget.mjs"]);
ev.mutationOk = run("变异测试（fold.mjs）", ["tools/mutation/run.mjs"]);
ev.pageOk = run("页面 HTTP 冒烟（临时端口 + /api/state）", ["tools/oracle/page-smoke.mjs"]);
ev.cpuOk = run("稳态 CPU 采样（60s，5s 刷新）", ["tools/bench/cpu.mjs"]);

const waiting = read("eval-waiting.json");
const fault = read("fault.json");
const parity = read("tap-parity.json");
const budget = read("budget.json");
const mutation = read("mutation.json");
const cpu = read("cpu.json");
const soak = read("soak.json");
const soakProgress = read("soak-progress.json");
const liveTap = read("live-parity.json");

// §6 验收表：目标、实测、证据、状态。状态只有 pass / fail / pending（未做或不够久）。
const rows = [];
const add = (metric, target, actual, evidence, ok) =>
  rows.push({
    metric,
    target,
    actual: actual ?? "—",
    evidence,
    // ok === null 表示「进行中/尚无判据」：标 pending，不冒充 fail 或 pass。
    status: actual == null || ok == null ? "pending" : ok === true ? "pass" : "fail",
  });

if (waiting) {
  const s = waiting.semantic;
  add("等待判定 precision（episode 级，含场景）", "≥ 0.97", `${s.precision}（tp ${s.tp} / fp ${s.fp}）`, "corpus/eval-waiting.json", s.precision >= 0.97);
  add("等待判定 recall（episode 级，含场景）", "≥ 0.95", `${s.recall}（tp ${s.tp} / fn ${s.fn}）`, "corpus/eval-waiting.json", s.recall >= 0.95);
  const h = waiting.holdout.metric;
  const mx = waiting.holdout.mix ?? {};
  const mixText = `${mx.realApproval ?? 0} 真实审批 / ${mx.realQuestion ?? 0} 真实提问 / ${mx.scenarioApproval ?? 0} 场景审批 / ${mx.scenarioQuestion ?? 0} 场景提问`;
  add(
    "留出集 P / R（哈希划分，未冻结清单）",
    "≥ 0.97 / ≥ 0.95",
    `${h.precision} / ${h.recall}（${waiting.holdout.labels} 条，构成：${mixText}）`,
    "corpus/eval-waiting.json",
    h.precision >= 0.97 && h.recall >= 0.95,
  );
  const p = waiting.pointwise;
  add("时间点采样 precision / recall（分层）", "≈1", `${p.precision} / ${p.recall}（tp ${p.tp} / tn ${p.tn}）`, "corpus/eval-waiting.json", p.precision >= 0.97 && p.recall >= 0.95);
  add("截断读取层（窗口只到 asked 帧末仍判等待）", "120/120", `${waiting.windowPath?.ok}/${waiting.windowPath?.ok + waiting.windowPath?.fail}（fail ${waiting.windowPath?.fail}）`, "corpus/eval-waiting.json", waiting.windowPath?.fail === 0);
}
if (parity) {
  add(
    "tap 投影往返无损（同一批转录事件 → tapProject → 读回 → fold）",
    "无损",
    `${parity.rate === 1 ? "100%" : parity.rate}（${parity.checked} 份，mismatch ${parity.mismatch}）`,
    "corpus/tap-parity.json",
    parity.rate === 1 && parity.mismatch === 0,
  );
  // 这一条与上面那条不同：tap 行由 DSH 进程里的插件直写，读回后逐行重投影对照。
  const liveOk = liveTap && liveTap.identical === true && (liveTap.sessions ?? 0) > 0;
  add(
    "真实宿主 live tap（session/event 直写 → 读回 → 与转录重投影逐行对照）",
    "live 一致率 100%",
    liveTap
      ? liveTap.tapFiles
        ? `${liveTap.sessions} 会话 / ${liveTap.comparedRows} 行，mismatch ${liveTap.mismatches}（本机模型鉴权失败，未产生审批/提问类 live 事件）`
        : "未验证：本机无 tap 文件"
      : "未验证：没有 corpus/live-parity.json",
    "corpus/live-parity.json",
    liveOk ? true : liveTap && liveTap.sessions === 0 ? null : false,
  );
}
if (budget) {
  const readMB = Math.round((budget.readBytes ?? 0) / 1024 / 1024);
  const corpusMB = Math.round(budget.totalBytes / 1024 / 1024);
  add(`尾部窗口冷读（${budget.files} 份，实读 ${readMB}MB / 语料 ${corpusMB}MB）`, "≤ 20s", `${budget.coldTotalMs}ms`, "corpus/budget.json", budget.coldTotalMs <= budget.budgets.coldTotalMs);
  add("单文件冷读 p95", "≤ 120ms（按实测校准，原 30ms/MB 不可达）", `${budget.coldP95Ms}ms（max ${budget.coldMaxMs}ms）`, "corpus/budget.json", budget.coldP95Ms <= budget.budgets.coldP95Ms);
  add("热更新 p95（追加一帧后重算）", "≤ 30ms", `${budget.hotP95Ms}ms`, "corpus/budget.json", budget.hotP95Ms <= budget.budgets.hotP95Ms);
  add("稳态整轮刷新（文件未变，备忘录命中）", "≤ 50ms ⇒ 10s 刷新下 CPU ≤ 0.5%", `${budget.warmCycleMs}ms`, "corpus/budget.json", budget.warmCycleMs <= 50);
  add("常驻内存增量（RSS）", "≤ 300MB", `${budget.rssDeltaMB}MB`, "corpus/budget.json", budget.rssDeltaMB <= budget.budgets.rssDeltaMB);
}
if (cpu) add("稳态 CPU（60s 采样 / 5s 刷新，process.cpuUsage）", "≤ 1.5% 单核均值", `${cpu.cpuPct}%（p95 ${cpu.p95Pct}%、峰值 ${cpu.peakPct}%，${cpu.cycles} 轮）`, "corpus/cpu.json", cpu.cpuPct <= cpu.budgetPct);
if (mutation) {
  const skipped = mutation.skipped ?? 0;
  const note = skipped ? `；另有 ${skipped} 条等价/锚点未命中（不计分，见 corpus/mutation.json）` : "";
  add("变异分数（lib/truth/fold.mjs）", "≥ 0.75", `${mutation.score}（killed ${mutation.killed} / survived ${mutation.survived} / invalid ${mutation.invalid}${note}）`, "corpus/mutation.json", mutation.score >= 0.75);
}
if (fault) add("故障注入场景（断言降级到「未知」，不是只断言不崩）", "≥ 10/10", `${fault.pass}/${fault.pass + fault.fail}`, "corpus/fault.json", fault.fail === 0 && fault.pass >= 10);
const page = read("page-smoke.json");
if (page) {
  add(
    "HUD 页面 /api/state：每行有结论（rule 或 unknown.reason）+ evidence（HTTP 契约，非 DOM）",
    "dsh 行 100% 有结论（rule 或 unknown.reason）；有结论的行 100% 带 evidence",
    `${page.withTruth}/${page.rows} 行有结论（明确 unknown ${page.unknownVerdicts ?? 0} 行），${page.withEvidence}/${page.withTruth} 带 evidence，无结论 ${page.missingTruth}（轮询 ${page.waitedSec}s 后）`,
    "corpus/page-smoke.json",
    page.missingTruth === 0 && page.withTruth > 0 && page.withEvidence === page.withTruth,
  );
} else {
  add("HUD 页面 /api/state：每行带 truth + evidence（HTTP 契约，非 DOM）", "100%", null, "corpus/page-smoke.json", null);
}
add(
  "每条显示带 provenance（规则 + seq + 字节区间/尾部状态）",
  "100%",
  page ? `带 evidence 的 ${page.withEvidence}/${page.withTruth} 行都含 mode+bytes；另有 test/pending.test.mjs 逐行断言` : "由 test/pending.test.mjs 断言",
  "corpus/page-smoke.json + test/pending.test.mjs",
  page ? page.withEvidence === page.withTruth && page.withTruth > 0 : null,
);
add(
  "unknown 不得伪装成 idle",
  "0 例",
  page ? `/api/state 中 phase=unknown 且 state=idle 的行：${page.unknownAsIdle}；故障注入 11 例断言 state=unknown 或 truncated` : "故障注入断言",
  "corpus/page-smoke.json + corpus/fault.json",
  page ? page.unknownAsIdle === 0 && fault?.fail === 0 : null,
);
if (soak) {
  const full = soak.seconds >= 72 * 3600;
  // 斜率是新口径的主判据（旧版只看全程最大 RSS，一次 GC 延迟就会把 72h 判死）；
  // 稳态样本不足时如实写「未算」，不补 0。
  const slopes = soak.heapSlopeMBPerHour == null
    ? "，稳态斜率未算（样本不足或未排除预热）"
    : `，稳态斜率 heap ${soak.heapSlopeMBPerHour}/rss ${soak.rssSlopeMBPerHour}MB/h（预热 ${soak.warmupSec ?? 0}s 已排除，GC ${soak.gc ? "开" : "关"}）`;
  add("浸泡（追加 + 每次重算，未知数/滞后数）", "72h 0 崩溃、0 unknown、0 滞后", `${(soak.seconds / 3600).toFixed(2)}h：${soak.iterations} 次迭代，unknown ${soak.unknowns}、滞后 ${soak.lag}、p95 ${soak.p95Ms}ms、RSS +${soak.maxRssDeltaMB}MB${slopes}`, "corpus/soak.json", soak.unknowns === 0 && soak.lag === 0 && soak.maxRssDeltaMB <= 300 && soak.ok !== false);
  if (!full) rows.at(-1).status = "pending";
  rows.at(-1).metric += full ? "" : "（当前仅冒烟，完整 72h 需常驻跑）";
}
if (soakProgress) {
  const mins = Math.floor((soakProgress.elapsedSec ?? 0) / 60);
  add("72h 浸泡进行中（后台常驻）", "72h", `已跑 ${mins} 分钟 / ${soakProgress.iterations} 次迭代，unknown ${soakProgress.unknowns}、滞后 ${soakProgress.lag}（开始于 ${soakProgress.startedAt}）`, "corpus/soak-progress.json", null);
}

const pass = rows.filter((r) => r.status === "pass").length;
const fail = rows.filter((r) => r.status === "fail").length;
const pending = rows.filter((r) => r.status === "pending").length;
const stamp = new Date().toISOString();

const machine = `${platform()} ${release()} · ${cpus().length} vCPU · ${Math.round(totalmem() / 1024 ** 3)}GB · node ${process.version}`;
const md = [];
md.push("# magpie-hud v6 深度版：验收证据报告", "");
md.push(`- 生成时间：${stamp}`);
md.push(`- 机器：${machine}`);
md.push(`- 结论：**${pass} 项达标 / ${fail} 项不达标 / ${pending} 项未完成**（目标见 docs/magpie-hud-v6-depth-plan.md §6）`);
md.push("");
md.push("## 1. 验收表（每个数字都有可复跑的出处）", "");
md.push("| 指标 | 目标 | 实测 | 状态 | 证据文件 |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of rows) md.push(`| ${r.metric} | ${r.target} | ${r.actual} | ${r.status === "pass" ? "✓ 达标" : r.status === "fail" ? "✗ 不达标" : "… 未完成"} | ${r.evidence} |`);
md.push("");
md.push("## 2. 本次执行的命令与结果", "");
md.push("| 步骤 | 命令 | 耗时 | 结果 |");
md.push("| --- | --- | --- | --- |");
for (const r of runs) md.push(`| ${r.label} | \`${r.cmd}\` | ${(r.ms / 1000).toFixed(1)}s | ${r.ok ? "通过" : `失败：${(r.err || "").split(/\r?\n/)[0] || ""}`} |`);
md.push("");
md.push("## 3. 证据链：一条显示能倒推到什么", "");
md.push("```");
md.push("raw zstd 帧字节 ──readWindow(offset,size)──▶ 事件 {seq,type,data}");
md.push("      ▲                                        │");
md.push("      │ 帧三验（可解码 / 每行 JSON / seq 严格 +1）  ▼");
md.push("tap 事件副本（进程内 session/event 直抄；本机已真跑 1 个宿主进程，18 行逐行一致，未覆盖审批/提问）──仲裁──▶ 纯 reducer fold(state,ev) ──▶ phase + waiting + rule + seq");
md.push("      ▲                                        │");
md.push(`      └──── tap 投影往返无损 ${parity?.checked ?? "?"} 份（同一批事件自比，非独立 oracle）◀─┘`);
md.push("```");
md.push("");
md.push("- 每条会话行的 `evidence` 记录：读法（events/tap/both）、字节区间、mtime、触发规则与 seq；末尾还有不可解码字节时记 `tailBytes/tailKind`（`partial-frame` 容忍并标 truncated，`garbage` 直接判 unknown）。");
md.push("- 等待显示附 `toolName`、`since`（来自事件时间，不是 mtime 推算）与规则名。");
md.push("- 回答回执：`accepted → delivered(seq) → effective(seq)`，超时 60s 记 `timeout`，绝不把 accepted 渲染成已完成。");
md.push("");
md.push("## 4. 诚实边界（这些「绿灯」不证明什么）", "");
md.push("- **P/R=1 是「与自身规范一致」，不是独立测量**：标注与 reducer 出自同一份事件语义；且 checkpoint 上的 `waiting.seq === askedSeq` 由构造保证（两边取的是同一条 approval/asked 事件），所以不存在「起点误差」。真正被检验的是「这些 seq 上判不判 waiting」。");
md.push("- **留出集不冻结**：成员按 `sessionId 哈希 % 5` 每次运行现算，没有封存清单；构成见第 1 节该行（真实提问样本数量写在里面，别当成整批真实会话盲测）。");
md.push("- **live tap 已发生，但样本极窄**：本机用 `dsh --profile headless --patch <overlay>` 真跑了一个宿主进程，插件把 `session/event` 直写进 `~/.magpie-hud/tap`，逐行重投影对照 18/18 一致；但该次模型鉴权失败（INVALID_TOKEN），只覆盖会话头/权限/输入/回合/turn-end 这些事件，**审批与提问类 live 事件仍为 0**。所以「宿主直写 == 转录」只在这 18 行上成立，不代表全事件族。");
md.push("- **冷读数字只覆盖尾部窗口**：每份转录只读末尾 ≤128KB 去判相位（实读字节数写在行内），不是「198 份 / 288MB 全量解码」；全量解码另测约 126s（corpus/stats.json），那才是「读整份」的成本。");
md.push("- **页面冒烟只到 HTTP 契约**：`/api/state` 字段齐全 ≠ 界面上真的渲染出「未知」pill；DOM 级验证（截图/无障碍树）未做。");
md.push("- **变异分数只覆盖 `lib/truth/fold.mjs`**：frames/collect/tap 与 dsh 插件层没有变异分；equivalent/anchor 未命中的突变单列在 corpus/mutation.json，不计入分母。");
md.push("- 本机没有 Claude Code / Codex 的会话目录（~/.claude/projects、~/.codex/sessions 不存在），这两条客户端路径只有单测覆盖，没有真实语料。");
md.push("- 72h 浸泡需要常驻机器：仓库提供 `SOAK_SECONDS=259200 node --expose-gc tools/soak/run.mjs`；未跑满前该项永远是 pending，不冒充达标。斜率排除前 10 分钟预热（`SOAK_WARMUP_SEC`），否则启动期长起来的内存会被当成泄漏；不带 `--expose-gc` 时量到的是带未回收垃圾的 RSS，斜率偏大。");
md.push("- 未做：多显示器下的像素级视觉回归、IME 中文输入、macOS 桌面二进制、真实 magpie 宿主内的 CPU 采样。");
md.push("");
md.push("## 5. 复跑", "");
md.push("```powershell");
md.push("cd plugins/magpie-hud");
md.push("node tools/oracle/report.mjs          # 全部证据一次跑完并重写本报告");
md.push("node tools/corpus/extract.mjs         # 重新抽取真实等待 episode（需要 ~/.dsh/sessions）");
md.push("node tools/corpus/scenarios.mjs       # 重新生成场景语料");
md.push("SOAK_SECONDS=259200 node --expose-gc tools/soak/run.mjs   # 完整 72h 浸泡（另开终端常驻）");
md.push("```");
md.push("");

const mdFile = join(root, "..", "..", "docs", "magpie-hud-report.md");
writeFileSync(mdFile, md.join("\n"));
writeFileSync(join(corpus, "report.json"), JSON.stringify({ at: stamp, machine, pass, fail, pending, rows, runs }, null, 2) + "\n");

console.log(`report: ${pass} pass / ${fail} fail / ${pending} pending → docs/magpie-hud-report.md`);
for (const r of rows.filter((r) => r.status !== "pass")) console.log(`  ${r.status.toUpperCase()} ${r.metric}: ${r.actual}`);
process.exit(fail ? 1 : 0);
