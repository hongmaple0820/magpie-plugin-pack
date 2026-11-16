// fake codex app-server：回 initialize / thread/queue/add / thread/start /
// thread/name/set，供测试不依赖真 codex 命令。
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    out({ id: message.id, result: { capabilities: {}, serverInfo: { name: "fake-codex" } } });
    return;
  }
  if (message.method === "thread/queue/add") {
    const text = message.params?.input?.[0]?.text ?? "";
    out({ id: message.id, result: { queuedSubmission: { clientUserMessageId: message.params?.clientUserMessageId, text } } });
    return;
  }
  if (message.method === "thread/start") {
    out({ id: message.id, result: { thread: { id: "11111111-2222-3333-4444-555555555555" } } });
    return;
  }
  if (message.method === "thread/name/set") {
    out({ id: message.id, result: {} });
    return;
  }
  out({ id: message.id, result: {} });
});
