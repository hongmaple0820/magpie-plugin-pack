// 假 Claude Code engine：读 stdin 的 control_request，按 engine_usage.rs 的
// 协议答 get_usage（control_response，response.response 为载荷）。
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
    if (message?.type === "control_request" && message?.request?.subtype === "get_usage") {
      process.stdout.write(JSON.stringify({
        type: "control_response",
        request_id: message.request_id,
        response: {
          subtype: "success",
          response: {
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 42.5, resets_at: "2026-11-11T12:00:00.000Z" },
              seven_day: { utilization: 61, resets_at: "2026-11-14T00:00:00.000Z" },
              seven_day_opus: { utilization: 80, resets_at: "2026-11-14T00:00:00.000Z" },
            },
          },
        },
      }) + "\n");
    }
  }
});
