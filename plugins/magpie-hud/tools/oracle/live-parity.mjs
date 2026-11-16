#!/usr/bin/env node
// 真实宿主 live tap 对照：插件在 DSH 进程里把 session/event 直抄成 tap 行；
// 这里读回那些行，和「同一份转录事件再跑一遍 tapProject」逐行比对。
//
// 它证明的是：宿主进程写出的副本 == 我们用同一投影函数从 durable 转录算出的副本
// （跨进程、跨落盘边界）。它不证明语义正确（那是 eval/fold 的事），也不覆盖
// 本机没发生过的询问类事件——那些只有 tap 里真的出现过才算。
import { readdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readAll } from "../../lib/truth/frames.mjs";
import { tapProject } from "../../dsh/magpie-hud.mjs";

const TAP_DIR = process.env.MAGPIE_HUD_TAP ?? join(homedir(), ".magpie-hud", "tap");
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const OUT = "corpus/live-parity.json";

function transcripts() {
  const root = join(DSH_HOME, "sessions");
  const found = new Map(); // sessionId -> file
  if (!existsSync(root)) return found;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const pd = join(root, project.name);
    for (const session of readdirSync(pd, { withFileTypes: true })) {
      if (!session.isDirectory() || !session.name.startsWith("session-")) continue;
      const file = join(pd, session.name, "session.v4.jsonl.zstd");
      if (existsSync(file)) found.set(session.name, file);
    }
  }
  return found;
}

function tapRows(file) {
  const rows = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.type === "string") rows.push(row);
    } catch {}
  }
  return rows;
}

function key(row) {
  return `${row.seq ?? "-"}|${row.type}`;
}

async function main() {
  if (!existsSync(TAP_DIR)) {
    console.log(`live parity: 没有 tap 目录（${TAP_DIR}）——插件在本机从未跑过，没有 live 证据`);
    writeFileSync(OUT, JSON.stringify({ tapDir: TAP_DIR, tapFiles: 0, sessions: 0, comparedRows: 0, mismatches: 0, missing: 0, note: "no tap dir" }, null, 2));
    process.exit(2);
  }
  const byId = transcripts();
  const files = readdirSync(TAP_DIR).filter((name) => name.endsWith(".jsonl"));
  let compared = 0;
  const mismatches = [];
  const details = [];
  for (const name of files) {
    const id = name.replace(/\.jsonl$/, "");
    const file = byId.get(id);
    const rows = tapRows(join(TAP_DIR, name));
    if (!file) {
      details.push({ session: id, rows: rows.length, ok: false, reason: "转录不存在（会话可能已被归档/删除）" });
      continue;
    }
    const full = await readAll(file);
    const wanted = new Map();
    for (const ev of full.events) {
      const row = tapProject(ev);
      if (row) wanted.set(key(row), row);
    }
    let same = 0;
    let diff = 0;
    for (const row of rows) {
      const expect = wanted.get(key(row));
      compared += 1;
      if (!expect) {
        diff += 1;
        if (mismatches.length < 10) mismatches.push({ session: id, seq: row.seq, type: row.type, why: "转录里没有这一条" });
        continue;
      }
      if (JSON.stringify(expect.data) === JSON.stringify(row.data)) {
        same += 1;
      } else {
        diff += 1;
        if (mismatches.length < 10) mismatches.push({ session: id, seq: row.seq, type: row.type, why: "data 不一致", expect: expect.data, got: row.data });
      }
    }
    details.push({ session: id, rows: rows.length, same, diff, transcriptEvents: full.events.length, ok: diff === 0 });
  }
  const report = {
    at: new Date().toISOString(),
    tapDir: TAP_DIR,
    tapFiles: files.length,
    sessions: details.length,
    comparedRows: compared,
    mismatches: mismatches.length,
    identical: mismatches.length === 0 && details.every((d) => d.ok),
    details,
    failures: mismatches,
    note: "tap 由 DSH 进程内插件直写；比对对象是同一批 durable 转录事件重新投影的结果。",
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`live parity: ${report.identical ? "identical" : "MISMATCH"} — ${details.length} 会话 / ${compared} 行，mismatch ${mismatches.length}`);
  if (!report.identical) {
    for (const row of mismatches.slice(0, 5)) console.error(`  ${row.session} seq ${row.seq} ${row.type}: ${row.why}`);
    process.exit(1);
  }
}

await main();
