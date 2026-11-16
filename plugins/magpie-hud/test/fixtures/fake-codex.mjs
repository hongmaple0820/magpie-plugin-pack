// 假 Codex app-server：initialize → account/rateLimits/read + account/read，
// 按 codex/account.rs 的 JSON-RPC 形状答。
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  let index;
  while ((index = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { protocol: 1 } }) + "\n");
    } else if (message?.method === "account/rateLimits/read") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        accountId: "ws-1",
        rateLimitsByLimitId: {
          codex: {
            limitName: "Codex",
            planType: "pro",
            primary: { usedPercent: 33.3, windowDurationMins: 300, resetsAt: 1762900000 },
            secondary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1763400000 },
          },
        },
        rateLimitResetCredits: { availableCount: 2, credits: [{ id: "c1", expiresAt: 1763000000 }, { id: "c0", expiresAt: 1762900000 }] },
      } }) + "\n");
    } else if (message?.method === "account/read") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { account: { email: "dev@example.com", planType: "pro" }, requiresOpenaiAuth: false } }) + "\n");
    }
  }
});
