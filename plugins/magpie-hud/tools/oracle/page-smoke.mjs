#!/usr/bin/env node
// 页面服务冒烟：不依赖 magpie 宿主，直接在临时端口起页面服务，拉 /api/state，
// 断言 HUD 实际吐出的每一行都带 truth/evidence（P2 接线在 HTTP 层也成立）。
//
// 会话元数据是「先返回、后台补」的（lib/sessions.mjs 的 pendingFill 队列）：
// 超过 32KB 的转录第一轮只给空壳，后台一次补一个。所以这里像真实面板一样轮询，
// 最多 60 秒，直到 dsh 行全部有真值。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPageService } from "../../lib/pageservice.mjs";
import { bridgeEngine } from "../../lib/engine.mjs";

const engine = await bridgeEngine();
const service = createPageService({ port: 0, engine: engine ?? null });
await service.start();
const port = service.port;

const getState = async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  if (!res.ok) throw new Error(`/api/state HTTP ${res.status}`);
  return res.json();
};

try {
  let state = await getState();
  let dshRows = (state.sessions ?? []).filter((s) => s.client === "dsh");
  let seconds = 0;
  // 「有结论」= 给了规则，或明确给了 unknown 原因。两者都没有的行才继续等。
  const hasVerdict = (s) => Boolean(s.truth && (typeof s.truth.rule === "string" || s.truth.unknown?.reason));
  for (; seconds < 60 && dshRows.some((s) => !hasVerdict(s)); seconds++) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await getState();
    dshRows = (state.sessions ?? []).filter((s) => s.client === "dsh");
  }
  const rows = state.sessions ?? [];
  const withTruth = rows.filter(hasVerdict);
  const missingTruth = dshRows.filter((s) => !hasVerdict(s));
  const unknownVerdicts = withTruth.filter((s) => s.phase === "unknown");
  const withEvidence = withTruth.filter((s) => s.evidence && s.evidence.mode && s.evidence.bytes);
  const unknownAsIdle = rows.filter((s) => s.phase === "unknown" && s.state === "idle");
  const checks = [
    { name: `/api/state 返回会话行`, ok: rows.length > 0, detail: `${rows.length} 行（dsh ${dshRows.length}）` },
    { name: `dsh 行全部有结论（rule 或 unknown.reason；后台补全 ${seconds}s 后）`, ok: dshRows.length > 0 && missingTruth.length === 0, detail: `${dshRows.length - missingTruth.length}/${dshRows.length}（其中明确 unknown ${unknownVerdicts.length} 行）` },
    { name: `有结论的行都带 evidence（读法 + 字节区间）`, ok: withTruth.length > 0 && withEvidence.length === withTruth.length, detail: `${withEvidence.length}/${withTruth.length}` },
    { name: `unknown 不被写成 idle`, ok: unknownAsIdle.length === 0, detail: `${unknownAsIdle.length} 行` },
  ];
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name} — ${c.detail}`);
  for (const s of missingTruth.slice(0, 5)) {
    console.log(`  缺真值：${s.id} state=${s.state} evidence=${JSON.stringify(s.evidence)} file=${s.file}`);
  }
  const sample = withTruth.find((s) => s.phase === "waiting") ?? withTruth[0];
  if (sample) {
    console.log(
      `\n样例：${sample.id.slice(0, 24)} phase=${sample.phase} state=${sample.state} rule=${sample.truth.rule} ` +
        `waiting=${sample.pending ? `${sample.pending.kind}/${sample.pending.toolName}/${sample.pending.since}` : "null"} ` +
        `evidence=${sample.evidence.mode}@${sample.evidence.bytes.offset}+${sample.evidence.bytes.size}`,
    );
  }
  // 把实测计数落盘，报告直接引用数字而不是抄控制台散文。
  const out = join(import.meta.dirname, "..", "..", "corpus");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "page-smoke.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        // 范围：只验 HTTP /api/state 契约，不渲染 DOM、不跑浏览器——UI 上的「未知」pill 由 app.js 决定，未被本脚本执行。
        scope: "http-api-only",
        waitedSec: seconds,
        rows: rows.length,
        dshRows: dshRows.length,
        withTruth: withTruth.length,
        unknownVerdicts: unknownVerdicts.length,
        withEvidence: withEvidence.length,
        missingTruth: missingTruth.length,
        unknownAsIdle: unknownAsIdle.length,
        sample: sample
          ? { id: sample.id, phase: sample.phase, state: sample.state, rule: sample.truth.rule, mode: sample.evidence.mode }
          : null,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
} finally {
  await service.stop();
}
