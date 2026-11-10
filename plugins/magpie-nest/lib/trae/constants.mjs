// TRAE (ByteDance AI IDE) protocol facts, both deployments.
//
// TRAE is not OpenAI-compatible in either direction: the agent endpoint
// /api/agent/v3/llm_utils_chat takes a SOLO-shaped body (messages content as
// a parts array, assistant tool_calls[].function renamed function_call,
// tools[].function.parameters as a JSON string, model + config_name beside
// the routing "function") and answers its own SSE events (output / done /
// error / token_usage). The loader in index.mjs rewrites OpenAI -> SOLO and
// projects the SOLO stream back onto OpenAI SSE.
//
// Protocol facts per:
//   F:/maple/ChatLink/src/main/providers/builtin/trae.ts:6-20
//   F:/maple/ChatLink/src/main/proxy/adapters/trae.ts:117-228
//   C:/Users/Administrator/.config/magpie/plugins/node_modules/@magpie-community/opencode-trae-auth/index.mjs:34-88,153-199

import { randomUUID } from "node:crypto";

export const CHAT_PATH = "/api/agent/v3/llm_utils_chat";
export const DEFAULT_CHANNEL = "solo_agent";
export const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

// The IDE's chat functions. A model is only callable through a channel that
// lists it; solo_agent is the widest, the one Auto Mode uses.
// (ChatLink providers/builtin/trae.ts:16-20)
export const FUNCTIONS = ["chat_v3", "solo_work_lite", "solo_agent", "solo_agent_lite", "solo_coder"];

// Every host the two deployments name, and what it serves. Only the model
// host answers chat; the others serve auth, usage or the site itself.
// (community index.mjs:34-88 CN, :153-199 global)
export const REGIONS = {
  "trae-global": {
    id: "trae-global",
    name: "Trae Global",
    npm: "@ai-sdk/openai-compatible",
    site: "https://www.trae.ai",
    // api-sg-central / api-us-east serve usage (dollar entitlements);
    // core*-normal serve the models (SG default, coreva for US accounts);
    // grow*-normal serve tokens/account.
    apiDomains: [
      "api-sg-central.trae.ai",
      "api-us-east.trae.ai",
      "core*.trae.ai",
      "grow*.trae.ai",
    ],
    chatBase: "https://coresg-normal.trae.ai",
    usChatBase: "https://coreva-normal.trae.ai",
    clientVersion: "0.1.69",
    clientVersionCode: "20260917",
    models: [
      ["gpt-5.4", "GPT-5.4"],
      ["gemini-3-flash", "Gemini 3 Flash"],
      ["kimi-k2.5", "Kimi K2.5"],
      ["minimax-m2", "MiniMax M2"],
      ["deepseek-v3.2", "DeepSeek V3.2"],
    ],
  },
  "trae-cn": {
    id: "trae-cn",
    name: "Trae CN",
    npm: "@ai-sdk/openai-compatible",
    site: "https://www.trae.cn",
    // api.trae.cn / api.trae.com.cn serve auth, credits and the daily
    // check-in; trae-api-cn.mchost.guru is the only model host.
    apiDomains: ["api.trae.cn", "api.trae.com.cn", "trae-api-cn.mchost.guru"],
    chatBase: "https://trae-api-cn.mchost.guru",
    clientVersion: "0.1.69",
    clientVersionCode: "20260917",
    models: [
      ["glm-5.2", "GLM-5.2"],
      ["glm-5", "GLM-5"],
      ["kimi-k2.6", "Kimi K2.6"],
      ["qwen-3.7-plus", "Qwen 3.7 Plus"],
      ["DeepSeek-V4-Pro", "DeepSeek V4 Pro"],
      ["DeepSeek-V4-Flash", "DeepSeek V4 Flash"],
    ],
  },
};

export function regionOf(id) {
  return REGIONS[id];
}

/** The model rows this plugin serves for one region. */
export function modelRows(regionId) {
  const region = REGIONS[regionId];
  const out = {};
  for (const [id, name] of region?.models ?? []) {
    out[id] = { name, tool_call: true, reasoning: true, limit: { context: 128_000 } };
  }
  return out;
}

/** magpie may name a model "trae-cn/kimi-k2.6"; upstream wants the bare id. */
export function stripModel(providerId, value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith(providerId + "/") ? id.slice(providerId.length + 1) : id;
}

function toSoloMessage(message) {
  const out = { ...message };

  if (out.role === "assistant" && Array.isArray(out.tool_calls)) {
    const kept = [];
    for (const raw of out.tool_calls) {
      if (typeof raw !== "object" || raw === null) continue;
      const call = { ...raw };
      if (typeof call.function === "object" && call.function !== null) {
        call.function_call = call.function;
        delete call.function;
      }
      const fn = call.function_call;
      if (fn === undefined || typeof fn.name !== "string" || fn.name.trim().length === 0) continue;
      kept.push(call);
    }
    if (kept.length > 0) out.tool_calls = kept;
    else delete out.tool_calls;
  }

  if (typeof out.content === "string") {
    out.content = [{ type: "text", text: out.content }];
  }
  return out;
}

function normalizeToolChoice(body) {
  const choice = body.tool_choice;
  if (choice === undefined) return;
  if (choice === "none") {
    delete body.tool_choice;
    delete body.tools;
    return;
  }
  if (typeof choice === "string") return;
  if (typeof choice === "object" && choice !== null) {
    if (choice.type === "none") {
      delete body.tool_choice;
      delete body.tools;
      return;
    }
    if (choice.type === "auto" || choice.type === "required") {
      body.tool_choice = choice.type;
      return;
    }
    if (choice.type === "function") {
      const fn = choice.function;
      if (fn !== undefined && typeof fn.name === "string" && fn.name.length > 0) {
        body.tool_choice = fn.name;
        return;
      }
    }
  }
  delete body.tool_choice;
}

function normalizeTools(body) {
  const raw = body.tools;
  if (!Array.isArray(raw) || raw.length === 0) return;
  const kept = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const tool = { ...item };
    const fn = tool.function;
    if (fn === undefined) continue;
    if (typeof fn.parameters === "object" && fn.parameters !== null) {
      fn.parameters = JSON.stringify(fn.parameters);
    }
    kept.push(tool);
  }
  if (kept.length > 0) body.tools = kept;
  else delete body.tools;
}

/**
 * OpenAI request body -> SOLO request body.
 * (ChatLink proxy/adapters/trae.ts:117-228, plus the community's
 * request_id / session_id fields, index.mjs:1484-1534)
 */
export function toSoloBody(req, { channel = DEFAULT_CHANNEL, sessionId, config } = {}) {
  const body = {
    model: req.model,
    messages: Array.isArray(req.messages) ? req.messages.map(toSoloMessage) : [],
    stream: true,
    function: channel && channel.length > 0 ? channel : DEFAULT_CHANNEL,
  };

  for (const key of ["temperature", "top_p", "stop", "reasoning_effort", "tools", "tool_choice", "parallel_tool_calls"]) {
    if (req[key] !== undefined) body[key] = req[key];
  }
  const asked = req.max_completion_tokens ?? req.max_tokens;
  if (Number.isFinite(asked) && asked > 0) body.max_tokens = Math.floor(asked);

  // config 是账号目录里的那一项；没给才退回从模型名里猜。
  const model = typeof body.model === "string" ? body.model : "";
  const base = config && String(config).trim() ? String(config).trim() : model.includes("__") ? model.split("__")[0] : model;
  body.config_name = base;
  body.model = base;

  normalizeToolChoice(body);
  normalizeTools(body);

  body.request_id = randomUUID();
  body.session_id = sessionId && sessionId.length > 0 ? sessionId : randomUUID();
  return body;
}

/**
 * The chat headers the IDE sends for an account: the token is repeated in
 * four headers on purpose (the gateway checks them independently), and
 * uid / machineId / deviceId are the device identity it verifies.
 * (ChatLink proxy/adapters/trae.ts:286-319; community index.mjs:765-780)
 */
export function clientHeaders(region, token, creds) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "X-Ide-Token": token,
    "X-Uid": creds.uid ?? "",
    "X-App-Id": APP_ID,
    "X-Device-Id": creds.deviceId ?? "",
    "X-Machine-Id": creds.machineId ?? "",
    "X-Request-Id": randomUUID(),
    "X-App-Version": region.clientVersion,
    "X-App-Version-Code": region.clientVersionCode,
    "X-Ide-Version": region.clientVersion,
    "X-Ide-Version-Code": region.clientVersionCode,
    "X-Ide-Version-Type": "stable",
    "X-Device-Cpu": "AMD",
    "X-Device-Brand": "Windows",
    "X-Device-Type": "windows",
    "X-Os-Version": "Windows 10",
    "X-System-Type": "Windows",
  };
}
