import { readFileSync } from "node:fs";
import { readAll } from "../lib/truth/frames.mjs";
import { fold, summary } from "../lib/truth/fold.mjs";

const file = "C:/Users/Administrator/.dsh/sessions/--F-project-ai-crawler--/session-c6e0b3bf-7ce3-44b4-a90d-b50e03a073ec/session.v4.jsonl.zstd";
const all = readAll(file);
const labels = readFileSync(new URL("../corpus/labels.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l))
  .filter((l) => l.file === file);
console.log("labels:", JSON.stringify(labels, null, 1));
const evs = all.events.filter((e) => e.seq >= 180 && e.seq <= 240);
for (const e of evs) {
  const d = e.data ?? {};
  const brief = e.type.startsWith("approval") ? d : e.type === "tool/call" ? { callId: d.callId, name: d.name } : e.type === "tool/result" ? { via: d.message?.source?.callId } : e.type === "user/message" ? { source: d.source } : {};
  console.log(e.seq, e.type, JSON.stringify(brief), e.surfaceOp ? JSON.stringify(e.surfaceOp) : "");
}
for (const at of [184, 190, 205, 300, 925]) {
  const i = all.events.findIndex((x) => x.seq >= at);
  const st = summary(fold(all.events.slice(0, i + 1)));
  console.log("fold@", at, st.phase, JSON.stringify(st.waiting));
}
