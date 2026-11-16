#!/usr/bin/env node
// 浸泡体检：只读 corpus/soak-progress.json 与 corpus/soak.json，不启动浸泡、不碰被测代码。
//
//   node tools/soak/status.mjs
//
// 退出码：0 正常推进 / 1 进度停滞（job 可能已死）/ 2 没有在跑也没有完成记录
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const corpus = join(import.meta.dirname, "..", "..", "corpus");
const progressFile = join(corpus, "soak-progress.json");
const heartbeatFile = join(corpus, "soak-heartbeat.json");
const doneFile = join(corpus, "soak.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
/** pid 还在吗；EPERM 说明进程存在但不归我们管，按活着算。 */
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};
const fmt = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
};

if (existsSync(progressFile)) {
  // 有 progress 不一定在跑：进程被杀后这两个文件会留在原地（旧版就是这样骗了 13h）。
  // 判生死看两个独立信号——心跳文件的 pid 是否还活着，以及心跳是否已经停了。
  const p = readJson(progressFile);
  const hb = existsSync(heartbeatFile) ? readJson(heartbeatFile) : null;
  const ageSec = (Date.now() - statSync(progressFile).mtimeMs) / 1000;
  const hbAgeSec = hb ? (Date.now() - statSync(heartbeatFile).mtimeMs) / 1000 : Infinity;
  const alive = hb?.pid ? pidAlive(hb.pid) : null;
  const dead = hbAgeSec > 60 || alive === false || (!hb && ageSec > 60);
  const total = p.seconds ?? 259200;
  const left = Math.max(0, total - p.elapsedSec);
  const eta = new Date(Date.now() + left * 1000).toISOString();
  console.log(`进行中：${fmt(p.elapsedSec)} / ${fmt(total)}（${((p.elapsedSec / total) * 100).toFixed(1)}%）`);
  console.log(`迭代 ${hb?.iterations ?? p.iterations}，unknown ${p.unknowns}、滞后 ${p.lag}`);
  if (hb) console.log(`心跳 ${hbAgeSec.toFixed(0)}s 前（pid ${hb.pid}${alive === null ? "" : alive ? " 存活" : " 已不在"}）`);
  else console.log(`没有心跳文件（旧版脚本或刚开始）——只能看进度文件，${ageSec.toFixed(0)}s 前更新`);
  console.log(`预计完成 ${eta}（UTC）`);
  if (existsSync(doneFile)) console.log(`（corpus/soak.json 是更早的 ${fmt(readJson(doneFile).seconds)} 冒烟存档，不算本次结论）`);
  console.log(dead ? "判定：已死（心跳停了或 pid 不在）——删掉 progress 与 heartbeat 后重跑" : "判定：在跑");
  process.exit(dead ? 1 : 0);
}

if (!existsSync(doneFile)) {
  console.log("没有浸泡在跑，也没有完成记录（先跑 node tools/soak/run.mjs）");
  process.exit(2);
}

const s = readJson(doneFile);
const full = s.seconds >= 259200;
const slopes = typeof s.heapSlopeMBPerHour === "number"
  ? `，heap ${s.heapSlopeMBPerHour}MB/h、rss ${s.rssSlopeMBPerHour}MB/h（GC ${s.gc ? "开" : "关"}）`
  : "";
console.log(`${full ? "完成" : "仅冒烟"}：${fmt(s.seconds)} / ${s.iterations} 次迭代，unknown ${s.unknowns}、滞后 ${s.lag}、p95 ${s.p95Ms}ms、RSS +${s.maxRssDeltaMB}MB${slopes}`);
process.exit(full && s.ok !== false && s.unknowns === 0 && s.lag === 0 ? 0 : 1);
