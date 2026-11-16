import { readAll } from "../lib/truth/frames.mjs";
import { fold, summary } from "../lib/truth/fold.mjs";

const cases = [
  ["C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-.dsh-bot-workspace--/session-83ce94bc-f75f-43c4-8c31-d3162b5ec85e/session.v4.jsonl.zstd", 25, 37],
  ["C:/Users/Administrator/.dsh/sessions/--F-project-audio-transcription--/session-680b60ec-8fcd-4212-b694-bb332900f2ad/session.v4.jsonl.zstd", 33310, 33405],
];
for (const [file, from, to] of cases) {
  const all = readAll(file);
  console.log("==", file.split("/").at(-2), "events", all.events.length, "err", all.error);
  for (const e of all.events.filter((x) => x.seq >= from && x.seq <= to)) {
    const d = e.data ?? {};
    const brief = e.type === "tool/call" ? { callId: d.callId, name: d.name } : e.type === "tool/result" ? { toolCallId: d.toolCallId, isError: d.message?.isError } : e.type === "user/message" ? { source: d.source } : {};
    console.log(e.seq, e.type, JSON.stringify(brief));
  }
  for (const at of [from + 2, to]) {
    const i = all.events.findIndex((e) => e.seq >= at);
    const st = summary(fold(all.events.slice(0, i + 1)));
    console.log("fold@", at, st.phase, JSON.stringify(st.waiting), st.unknown?.reason);
  }
}
