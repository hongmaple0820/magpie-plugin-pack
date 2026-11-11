/**
 * lib/bridge.mjs 的纯函数 / 流式协议测试。
 * 独立脚本：node test/bridge.test.mjs 或 bun test/bridge.test.mjs 都能跑。
 */
import assert from "node:assert/strict";
import {
  toOrbitBody,
  orbitResponse,
  errorResponse,
  upstreamErrorToResponse,
} from "../lib/inkstone/bridge.mjs";
import { openMessages } from "../lib/inkstone/orbit.mjs";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✓ ${name}`);
}

function frame(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function parseChunks(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      const raw = line.slice(6);
      return raw === "[DONE]" ? "[DONE]" : JSON.parse(raw);
    });
}

/* ---- a) 请求方向 ---- */
{
  const tools = Array.from({ length: 70 }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, description: `desc ${i}`, parameters: { type: "object", properties: {} } },
  }));
  const body = {
    model: "agents-a1",
    max_tokens: 4096,
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "查天气" },
      {
        role: "assistant",
        content: "好",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "tool_1", arguments: '{"city":"北京"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "晴 25℃" },
      { role: "user", content: "谢谢" },
    ],
    tools,
  };
  const orbit = toOrbitBody({ body, chatId: 42, canonicalId: "agents-a1-2026", supportsThinking: true });
  assert.equal(orbit.protocol_version, "2.0");
  assert.equal(orbit.inference_kind, "detached");
  assert.equal(orbit.chat_id, 42);
  assert.equal(orbit.model, "agents-a1-2026");
  assert.deepEqual(orbit.system, ["你是助手"]);
  assert.equal(orbit.max_output_tokens, 4096);
  assert.equal(orbit.thinking.enabled, true);
  assert.equal(orbit.tool_choice.type, "auto");
  assert.equal(orbit.tools.length, 64);
  assert.ok(orbit.tools.some((t) => t.name === "tool_1"), "已用过的工具要优先保留");
  assert.ok(orbit.request_id && orbit.inference_id && orbit.request_id !== orbit.inference_id);

  const toolUse = orbit.messages.flatMap((m) => m.content).find((b) => b.type === "tool_use");
  assert.deepEqual(toolUse.input, { city: "北京" });
  const toolResult = orbit.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
  assert.equal(toolResult.tool_use_id, "call_1");
  assert.equal(toolResult.content, "晴 25℃");
  assert.equal(typeof toolResult.content, "string");
  assert.equal(toolResult.is_error, false);
  const resultMsg = orbit.messages.find((m) => m.content.includes(toolResult));
  assert.ok(!resultMsg.content.some((b) => b.type === "text"), "tool_result 不能和 text 挤在同一条 user 里");
  ok("toOrbitBody: system/tool_use/tool_result/64 工具上限/max_output_tokens");
}

/* ---- b) thinking 开关 ---- */
{
  const off1 = toOrbitBody({ body: { messages: [] }, chatId: 1, canonicalId: "x", supportsThinking: true });
  assert.equal(off1.thinking.enabled, true);
  const off2 = toOrbitBody({ body: { messages: [], reasoning_effort: "off" }, chatId: 1, canonicalId: "x", supportsThinking: true });
  assert.equal(off2.thinking.enabled, false);
  const off3 = toOrbitBody({ body: { messages: [], thinking: { type: "disabled" } }, chatId: 1, canonicalId: "x", supportsThinking: true });
  assert.equal(off3.thinking.enabled, false);
  const off4 = toOrbitBody({ body: { messages: [] }, chatId: 1, canonicalId: "x", supportsThinking: false });
  assert.equal(off4.thinking.enabled, false);
  const empty = toOrbitBody({ body: { messages: [] }, chatId: 1, canonicalId: "x" });
  assert.deepEqual(empty.messages, [{ role: "user", content: [{ type: "text", text: "" }] }]);
  ok("thinking: 默认开启 / off / disabled / 不支持时关闭 / 空消息占位");
}

/* ---- c) 流式 SSE ---- */
{
  const upstream = sseResponse([
    frame("message_start", { type: "message_start" }),
    frame("thinking_delta", { type: "thinking_delta", text: "想一想" }),
    frame("content_delta", { type: "content_delta", text: "你好" }),
    frame("content_delta", { type: "content_delta", text: "，世界" }),
    frame("tool_use_start", { type: "tool_use_start", id: "toolu_1", name: "get_weather" }),
    frame("tool_input_delta", { type: "tool_input_delta", id: "toolu_1", partial_json: '{"city":' }),
    frame("tool_input_delta", { type: "tool_input_delta", id: "toolu_1", partial_json: '"北京"}' }),
    frame("usage", { type: "usage", usage: { input_tokens: 12, output_tokens: 5, cache_read_tokens: 0 } }),
    frame("message_end", { type: "message_end", stop_reason: "tool_use" }),
  ]);
  const res = await orbitResponse(upstream, { model: "agents-a1", stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(res.headers.get("content-length"), null);
  assert.equal(res.headers.get("content-encoding"), null);
  const rows = parseChunks(await res.text());
  assert.equal(rows.at(-1), "[DONE]");
  const chunks = rows.slice(0, -1).filter((r) => r !== "[DONE]" && r.object === "chat.completion.chunk");
  assert.ok(chunks.length >= 6);
  assert.ok(chunks.some((c) => c.choices[0].delta.reasoning_content === "想一想"));
  const text = chunks.map((c) => c.choices[0].delta.content || "").join("");
  assert.equal(text, "你好，世界");
  const start = chunks.find((c) => c.choices[0].delta.tool_calls?.some((t) => t.id === "toolu_1"));
  assert.equal(start.choices[0].delta.tool_calls[0].function.name, "get_weather");
  const args = chunks.filter((c) => c.choices[0].delta.tool_calls?.some((t) => t.function?.arguments))
    .map((c) => c.choices[0].delta.tool_calls[0].function.arguments).join("");
  assert.equal(args, '{"city":"北京"}');
  const final = chunks.at(-1);
  assert.equal(final.choices[0].finish_reason, "tool_calls");
  assert.equal(final.usage.prompt_tokens, 12);
  assert.equal(final.usage.completion_tokens, 5);
  ok("orbitResponse stream: thinking/text/tool_calls/usage/finish_reason/[DONE]/无 content-length");
}

/* ---- d/e) 开头就报错 ---- */
{
  const auth = sseResponse([frame("error", { type: "error", code: "AUTH_EXPIRED", message: "登录已过期，请重新登录" })]);
  const res = await orbitResponse(auth, { model: "x", stream: true });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
  assert.match((await res.json()).error.message, /登录已过期/);
  ok("早期 AUTH_EXPIRED → 401 + X-Magpie-Sign-In: expired");

  const quota = sseResponse([frame("error", { type: "error", message: "墨点不足，请等待刷新" })]);
  const res2 = await orbitResponse(quota, { model: "x", stream: false });
  assert.equal(res2.status, 429);
  ok("早期额度错误 → 429（交给 magpie 故障切换）");
}

/* ---- f) 非流式 ---- */
{
  const upstream = sseResponse([
    frame("content_delta", { type: "content_delta", text: "甲" }),
    frame("content_delta", { type: "content_delta", text: "乙" }),
    frame("usage", { type: "usage", usage: { input_tokens: 3, output_tokens: 2 } }),
    frame("message_end", { type: "message_end", stop_reason: "end_turn" }),
  ]);
  const res = await orbitResponse(upstream, { model: "x", stream: false });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "甲乙");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.equal(json.usage.prompt_tokens, 3);
  ok("orbitResponse 非流式：拼完整 chat.completion");
}

/* ---- g) 空流 ---- */
{
  const res = await orbitResponse(sseResponse([]), { model: "x", stream: true });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /空响应/);
  ok("空流 → 502 空响应");
}

/* ---- h) 错误映射 ---- */
{
  const r1 = errorResponse(401, "expired", { signIn: "expired" });
  assert.equal(r1.status, 401);
  assert.equal(r1.headers.get("x-magpie-sign-in"), "expired");
  assert.equal(r1.headers.get("content-length"), null);
  assert.equal(upstreamErrorToResponse({ authExpired: true, message: "会话失效" }).status, 401);
  assert.equal(upstreamErrorToResponse({ quota: true, message: "墨点不足" }).status, 429);
  assert.equal(upstreamErrorToResponse({ status: 503, message: "上游挂了" }).status, 502);
  assert.equal(upstreamErrorToResponse(new Error("参数不对")).status, 400);
  ok("errorResponse / upstreamErrorToResponse 状态码与响应头");
}

/* ---- i) 上下文截断：按模型窗口算，user 边界切断，tool 闭环不拆 ---- */
{
  const zh = (n) => "字".repeat(n);
  const longRound = (i) => [
    { role: "user", content: zh(300) },
    { role: "assistant", content: zh(300) },
  ];
  const messages = [
    { role: "system", content: "你是端砚助手" },
    ...Array.from({ length: 20 }, (_, i) => longRound(i)).flat(),
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_x", type: "function", function: { name: "tool_0", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_x", content: zh(100) },
    { role: "user", content: zh(300) },
  ];
  // contextWindow=6000/maxOutput=512 → cap=max(4096, 6000-512-4096)=4096，远小于上文
  const orbit = toOrbitBody({ body: { messages }, chatId: 1, canonicalId: "x", contextWindow: 6000, maxOutput: 512 });
  assert.ok(orbit.system.some((s) => s.includes("上下文已截断")), "要有截断提示");
  assert.equal(orbit.system[0], "你是端砚助手", "system 保留");
  const useIds = new Set(orbit.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use").map((b) => b.id));
  const resultIds = orbit.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
  assert.ok(resultIds.every((id) => useIds.has(id)), "tool_result 必须有配对的 tool_use");
  assert.ok(orbit.messages.length < messages.length, "确实截掉了旧消息");

  // 默认窗口（128000）下同一段对话完全不截
  const full = toOrbitBody({ body: { messages }, chatId: 1, canonicalId: "x" });
  assert.ok(!full.system.some((s) => s.includes("上下文已截断")), "窗口够大时不截断");
  // 40 轮文本 + 末轮 user 文本 = 41 个 text 块，一条不少（相邻同角色会合并，按块数算）
  assert.equal(full.messages.flatMap((m) => m.content).filter((b) => b.type === "text").length, 41, "system 之外全保留");

  // 窗口极小、一轮都放不下：保最后一个完整轮次，tool 闭环仍在
  const tiny = toOrbitBody({ body: { messages }, chatId: 1, canonicalId: "x", contextWindow: 4096, maxOutput: 4096 });
  const useIds2 = new Set(tiny.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use").map((b) => b.id));
  const resultIds2 = tiny.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
  assert.ok(resultIds2.every((id) => useIds2.has(id)), "兜底路径也不拆 tool 闭环");
  ok("toOrbitBody: 截断按模型窗口/user 边界/tool 闭环");
}

/* ---- j) 流停摆看门狗 + 429 退避 ---- */
{
  const encoder = new TextEncoder();
  // 发一帧后永远不关的流：模拟上游停摆
  const stalled = new Response(
    new ReadableStream({
      start(c) { c.enqueue(encoder.encode(frame("content_delta", { text: "半" }))); /* 挂住不关 */ },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const t0 = Date.now();
  const res = await orbitResponse(stalled, { model: "x", stream: true, stallMs: 80 });
  const text = await res.text();
  assert.ok(Date.now() - t0 < 2000, "看门狗要快速掐断，不能挂到分钟级");
  assert.ok(text.includes("半"), "已收到的内容要先吐给客户端");
  assert.ok(text.includes("停摆"), "停摆要给出明确错误帧: " + text.slice(-120));
  ok("停摆看门狗：流式路径部分内容 + 错误帧 + 快速断开");

  // 一个字节都不发的流：首刷阶段就停摆 → 502
  const dead = new Response(
    new ReadableStream({ start() { /* 什么都不发 */ } }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const res2 = await orbitResponse(dead, { model: "x", stream: true, stallMs: 80 });
  assert.equal(res2.status, 502);
  assert.match((await res2.json()).error.message, /停摆/);
  ok("停摆看门狗：零字节流 → 502");

  // 429 退避：前两次 429，第三次给 SSE → 应当重试成功
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) return new Response("rate limited", { status: 429 });
    return sseResponse([frame("content_delta", { text: "好" }), frame("message_end", { stop_reason: "end_turn" })]);
  };
  try {
    const res3 = await openMessages("jwt", "uid", {}, { retryDelays: [5, 5] });
    assert.ok(res3.ok && res3.headers.get("content-type").includes("event-stream"));
    assert.equal(calls, 3, "两次 429 后第三次成功");
    const body = await res3.text();
    assert.ok(body.includes("好"));
  } finally {
    globalThis.fetch = realFetch;
  }
  ok("openMessages：429 退避重试后拿到 SSE");
}

console.log(`\nbridge.test: ${passed} 组通过`);
