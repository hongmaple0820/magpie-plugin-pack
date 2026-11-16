#!/usr/bin/env node
// 独立 oracle：同一份真实事件，走「转录 → fold」与「tap 投影 → fold」两条路径，
// 逐会话比对阶段与等待点。这是 P3 之前没有的对质：显示层不再只有一个证据源。
//
// 说明：两条路径共享 fold.mjs（同一个 reducer），所以它证明的是「投影没有丢语义」，
// 不是「语义本身正确」；语义正确性由 docs/magpie-hud-truth-model.md 的证据链与
// eval 语料共同支撑。报告里必须这样写。
//
// 用法：node tools/oracle/tap-parity.mjs [--limit 500]（默认覆盖全部 <40MB 的会话）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync as statOf } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAll } from "../../lib/truth/frames.mjs";
import { tapProject } from "../../dsh/magpie-hud.mjs";
import { readTapFrom } from "../../lib/truth/tap.mjs";
import { fold } from "../../lib/truth/fold.mjs";
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
      st = statOf(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".jsonl.zstd")) out.push({ id: name.replace(/\.jsonl\.zstd$/, ""), file: p, size: st.size });
  }
  return out;
}

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 500;

const dir = mkdtempSync(join(tmpdir(), "hud-tap-parity-"));
const rows = [];
let checked = 0;
let mismatch = 0;
try {
  const files = walk(join(dshHome, "sessions"));
  const list = files.filter((s) => s.size < 40 * 1024 * 1024).sort((a, b) => a.size - b.size).slice(0, limit);
  for (const s of list) {
    const all = readAll(s.file);
    if (all.error) continue;
    const events = all.events;
    const truth = fold(events);
    const tapFile = join(dir, "tap.jsonl");
    const tapRows = events.map(tapProject).filter(Boolean);
    writeFileSync(tapFile, tapRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const tap = readTapFrom(tapFile, 0, { maxBytes: 64 * 1024 * 1024 });
    const fromTap = fold(tap.events);
    checked++;
    const a = { phase: truth.phase, kind: truth.waiting?.kind ?? null, seq: truth.waiting?.seq ?? null, turns: truth.counts.turns };
    const b = { phase: fromTap.phase, kind: fromTap.waiting?.kind ?? null, seq: fromTap.waiting?.seq ?? null, turns: fromTap.counts.turns };
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      mismatch++;
      rows.push({ id: s.id, truth: a, tap: b, lastSeq: truth.lastSeq, tapLastSeq: fromTap.lastSeq });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const report = { at: new Date().toISOString(), checked, mismatch, rate: checked ? Math.round(((checked - mismatch) / checked) * 1000) / 1000 : null, rows };
const out = join(import.meta.dirname, "..", "..", "corpus");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "tap-parity.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`tap parity: ${checked - mismatch}/${checked} identical (${report.rate})`);
for (const r of rows.slice(0, 5)) console.log(JSON.stringify(r));
process.exit(mismatch ? 1 : 0);
