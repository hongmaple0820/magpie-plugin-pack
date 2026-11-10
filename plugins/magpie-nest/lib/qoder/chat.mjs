// Qoder 加密推理通道：Chat Completions -> agent_chat_generation -> Chat Completions。
//
// 移植自社区 index.mjs 的请求构造（1091-1540）、错误映射（1592-1680）、
// 回复解析（1907-2417）三块；协议事实：
//   - 上游不是 OpenAI 兼容：请求体要 COSY 信封 + encodeBody，响应是 SSE
//     信封 { body: "<OpenAI chunk json>", statusCodeValue }；
//   - 模型名是目录 key（qfmodel / dmodel…），不是展示名；未知 key 网关会
//     静默换成别的模型，必须在本地拒绝；
//   - 工具调用写在文本里的 <tool_call> JSON 或 XML 标签，要 lift 成
//     OpenAI tool_calls。

import { createHash, randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { encodeBody, chatHeaders } from "./cosy.mjs";
import { CHAT_PATH, COSY_VERSION } from "./constants.mjs";

const QODER_SYS = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user.";
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const SMALL_BUDGET = 1024;

// ---------------- 错误映射（社区 index.mjs:1592-1680） ----------------

const QUEUED = "10605";
// 免费档排队：上游回 10605 + retryAfterSeconds，等一等就能排到。按它的
// 建议等待重试（最多 QUEUE_RETRIES 次，单次等待封顶 QUEUE_MAX_WAIT_S 秒），
// 否则用户每点一次都只看到「排 1 位，60 秒后再试」。
const QUEUE_RETRIES = 2;
const QUEUE_MAX_WAIT_S = 60;

function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(Object.assign(new Error("qoder: aborted"), { status: 499 }));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
const QUOTA_CODES = new Set(["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"]);
const REQUEST_CODES = new Set(["406", "416", "430", "80411", "80412", "100400", "100401", "100403"]);
const UPSTREAM_FAILED = /\berror in upstream response\b/i;

export function failure(status, text) {
  if (status < 400 || status > 599) status = 502;
  let msg = String(text ?? "").trim();
  let code = "";
  let queue;
  try {
    let j = JSON.parse(msg);
    const outerCode = j?.code == null ? "" : String(j.code);
    if (["", "401", "403"].includes(outerCode) && typeof j?.message === "string") {
      try {
        const inner = JSON.parse(j.message.trim());
        if (inner && !Array.isArray(inner) && String(inner.code) === QUEUED) j = inner;
      } catch {}
    }
    code = j?.code == null ? "" : String(j.code);
    if (j?.message) msg = String(j.message);
    const d = typeof j?.details === "string" ? JSON.parse(j.details.trim()) : j?.details;
    if (d?.error?.message) msg += ": " + d.error.message;
    queue = j?.queue && typeof j.queue === "object" ? j.queue : undefined;
    if (!queue && typeof j?.message === "string" && j.message.trim().startsWith("{")) {
      const q = JSON.parse(j.message.trim());
      if (q && typeof q === "object" && ("isQueued" in q || "serviceAvailable" in q || "retryAfterSeconds" in q)) queue = q;
    }
  } catch {}
  msg ||= STATUS_CODES[status] ?? ("HTTP " + status);
  if (code === QUEUED || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const n = Number(queue?.retryAfterSeconds);
    const wait = Number.isFinite(n) && n > 0 ? Math.ceil(n) : 30;
    const model = queue?.modelKey ? (" for " + queue.modelKey) : "";
    const ahead = Number(queue?.queueCount) > 0 ? (", " + Math.floor(Number(queue.queueCount)) + " ahead") : "";
    return { status: 503, message: "Qoder " + (queue?.isQueued === true ? "queued the request" : "is busy") + model + ahead + "; try again in " + wait + "s", retryAfter: wait, signIn: "", queue: queue ?? {} };
  }
  if (QUOTA_CODES.has(code)) return { status: 429, message: "usage limit reached: " + msg, signIn: "" };
  if (REQUEST_CODES.has(code)) return { status: 400, message: "Qoder refused the request (" + code + "): " + msg, signIn: "" };
  if (UPSTREAM_FAILED.test(msg)) return { status: 502, message: msg, signIn: "" };
  if (status === 401 || status === 403) {
    const said = msg && msg !== STATUS_CODES[status] ? (" (Qoder said " + status + ": " + msg.slice(0, 300) + ")") : "";
    return { status: 401, message: "the sign-in lapsed — sign in again" + said, lapsed: true };
  }
  if (status === 429 || msg.toLowerCase().includes("quota")) return { status: 429, message: "usage limit reached: " + msg, signIn: "" };
  return { status, message: msg };
}

export function errorResponse({ status, message, signIn = status === 401 ? "kept" : undefined, retryAfter }) {
  return new Response(JSON.stringify({ error: { message, type: "qoder_error", code: status } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}),
      ...(retryAfter > 0 ? { "Retry-After": String(retryAfter) } : {}),
    },
  });
}

// ---------------- 模型条目 ----------------

export function modelConfig(m, thinking) {
  const key = String(m.key ?? "").trim();
  if (!key || ["auto", "default"].includes(key)) throw new Error("no Qoder model key for " + JSON.stringify(m.key ?? ""));
  return {
    key,
    display_name: m.name || key,
    model: "",
    format: m.format ?? "openai",
    is_vl: !!m.isVl,
    is_reasoning: !!m.isReasoning && thinking,
    api_key: "",
    url: "",
    source: m.source || "system",
    max_input_tokens: m.maxInput || 200_000,
  };
}

function fitEffort(want, levels) {
  if (want === "ultra" && !levels.includes(want)) want = "max";
  if (!levels.length || levels.includes(want)) return want;
  const at = EFFORT_RANK.indexOf(want);
  if (at < 0) return want;
  let best = want;
  let dist = EFFORT_RANK.length;
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l);
    if (i < 0 || l === "none") continue;
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d];
  }
  return best;
}

function effortFor(asked, m, budget = 0) {
  let want = String(asked ?? "").toLowerCase();
  if (!EFFORT_RANK.includes(want)) want = "";
  if (want === "" && budget > 0 && budget <= SMALL_BUDGET) want = "none";
  if (!m.isReasoning || (want === "none" && !m.alwaysThinks)) return [false, ""];
  const efforts = m.efforts ?? [];
  if (!efforts.length) return [true, ""];
  if (want === "") return [true, m.defaultEffort];
  if (want === "none") return [true, efforts[0]];
  return [true, fitEffort(want, efforts)];
}

// ---------------- 消息转换（社区 index.mjs:1136-1340） ----------------

function imageBlock(p) {
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
  return url ? { type: "image_url", image_url: { url } } : null;
}

function blocksOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out = [];
  for (const p of content ?? []) {
    if (p?.type === "text" && p.text != null) out.push({ type: "text", text: p.text });
    else if (p?.type === "image_url") {
      const b = imageBlock(p);
      if (b) out.push(b);
    }
  }
  return out;
}

const textOf = (c) => (typeof c === "string" ? c : blocksOf(c).filter((b) => b.type === "text").map((b) => b.text).join(""));

function reasoningOf(m) {
  let text = "";
  for (const k of ["reasoning_content", "reasoning"]) if (!text && typeof m[k] === "string") text = m[k];
  if (!text && Array.isArray(m.reasoning_details)) text = m.reasoning_details.map((d) => (typeof d?.text === "string" ? d.text : typeof d?.summary === "string" ? d.summary : "")).join("");
  return text.trim() ? text : "";
}

function callID(at, k, c) {
  const args = c.function?.arguments;
  const said = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return "call_" + createHash("sha256").update(at + "\0" + k + "\0" + (c.function?.name ?? "") + "\0" + said).digest("hex").slice(0, 32);
}

// qoderMessages：把 OpenAI 历史变成 Qoder 的消息块。工具结果只带文本，
// 工具返回的图片挪到随后的 user 轮（社区 index.mjs:1156-1283）。
export function qoderMessages(msgs) {
  const out = [];
  const names = {};
  let seen = [];
  const showSeen = () => {
    if (seen.length) out.push({ role: "user", content: seen });
    seen = [];
  };
  let turn = null;
  const asText = (txt, ims) => {
    const said = txt.trim();
    if (!said && !ims.length) return;
    if (seen.length) seen.push({ type: "text", text: "\n\n" });
    if (said) seen.push({ type: "text", text: said });
    seen.push(...ims);
  };
  for (const [i, m] of msgs.entries()) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "user") turn = null;
    if (m.role !== "user" && m.role !== "tool") showSeen();
    if (m.role === "tool") {
      const txt = textOf(m.content);
      const ims = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url").map(imageBlock).filter(Boolean) : [];
      const named = String(m.tool_call_id ?? "").trim();
      const at = named ? (turn?.open.findIndex((id) => id === named) ?? -1) : -1;
      const pick = at >= 0 ? at : turn ? turn.open.findIndex((id) => !turn.kept.has(id)) : -1;
      if (pick < 0) {
        asText(txt, ims);
        continue;
      }
      const answered = turn.open.splice(pick, 1)[0];
      if (ims.length) {
        const name = names[answered] || m.name;
        const of = "tool call " + answered;
        seen.push({ type: "text", text: "[From the result of " + (name ? name + " (" + of + ")" : of) + ":]" }, ...ims);
        const note = ims.length === 1 ? "[The tool returned an image; it follows in the next message.]" : "[The tool returned " + ims.length + " images; they follow in the next message.]";
        out.push({ role: "tool", tool_call_id: answered, content: txt.trim() ? txt + "\n\n" + note : txt + note });
      } else {
        out.push({ role: "tool", tool_call_id: answered, content: txt });
      }
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c, k) => {
        const id = String(c.id ?? "").trim() || callID(i, k, c);
        names[id] = c.function?.name;
        const args = c.function?.arguments;
        return { id, type: "function", function: { name: c.function?.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } };
      });
      const think = reasoningOf(m);
      out.push({ role: "assistant", content: textOf(m.content), ...(think ? { reasoning_content: think } : {}), tool_calls: calls });
      const open = calls.map((c) => c.id);
      const kept = new Set();
      for (let j = i + 1; j < msgs.length && msgs[j].role === "tool"; j++) {
        const id = String(msgs[j].tool_call_id ?? "").trim();
        if (open.includes(id)) kept.add(id);
      }
      turn = { open, kept };
      continue;
    }
    let blocks = blocksOf(m.content);
    if (m.role === "assistant") blocks = blocks.filter((b) => b.type === "text");
    if (!blocks.length) continue;
    if (m.role === "user" && seen.length) [blocks, seen] = [[...seen, ...blocks], []];
    const think = m.role === "assistant" ? reasoningOf(m) : "";
    out.push({ role: m.role, content: blocks, ...(think ? { reasoning_content: think } : {}) });
    turn = null;
  }
  showSeen();
  return out;
}

// cacheMarked：prompt cache 标记（社区 index.mjs:1304-1326）。
const UNCACHED = new Set(["thinking", "redacted_thinking", "tool_use", "tool_result"]);

function cacheMarked(msgs) {
  const out = msgs.map((m) => (m.role === "user" && Array.isArray(m.content) ? { ...m, contents: m.content } : m));
  const last = out.at(-1);
  if (last?.role !== "user" || !Array.isArray(last.content)) return out;
  const at = last.content.findLastIndex((b) => b?.type && !UNCACHED.has(b.type));
  if (at < 0) return out;
  const blocks = last.content.slice();
  blocks[at] = { ...blocks[at], cache_control: { type: "ephemeral" } };
  out[out.length - 1] = { ...last, content: blocks, contents: blocks };
  return out;
}

// sessionOf：同一会话每轮用同一 session_id（社区 index.mjs:1339-1360）。
function sessionOf(chat, named = "") {
  const seed = named ? "session\0" + named
    : String(chat.prompt_cache_key ?? "").trim() ? "key\0" + chat.prompt_cache_key
    : String(chat.user ?? "").trim() ? "user\0" + chat.user
    : (chat.messages ?? []).filter((m) => m.role === "system" || m.role === "developer" || m.role === "user").slice(0, 2).map((m) => textOf(m.content)).join("\n");
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

// taskOf：一个用户提示的整轮 tool loop 共享 request_set_id（社区 1382-1418 简化）。
const TASKS = new Map();
const TASK_MAX = 512;
const TASK_IDLE = 2 * 60 * 60 * 1000;

function taskOf(sid, chat) {
  const now = Date.now();
  for (const [k, v] of TASKS) if (now - v.at > TASK_IDLE) TASKS.delete(k);
  const known = TASKS.get(sid);
  const first = (chat.messages ?? []).find((m) => m.role === "user");
  const marker = first ? textOf(first.content).slice(0, 200) : "";
  if (known && (known.answered || marker === known.marker)) {
    known.answered = false;
    return { id: known.id, name: sid, begin: known.begin, answered: false };
  }
  if (TASKS.size >= TASK_MAX) TASKS.delete(TASKS.keys().next().value);
  const task = { id: randomUUID(), name: sid, begin: now, answered: false, marker };
  TASKS.set(sid, task);
  return task;
}

// typedUnions：把 oneOf 全为 object 的 schema 补上 type:"object"
//（社区 index.mjs:1419-1447），Qoder 的工具编解码需要它。
function typedUnions(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const root = structuredClone(schema);
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const target = (ref) => {
    if (!ref.startsWith("#/")) return undefined;
    let at = root;
    for (const k of ref.slice(2).split("/")) at = at?.[k.replaceAll("~1", "/").replaceAll("~0", "~")];
    return isObj(at) ? at : undefined;
  };
  const object = (b, seen = []) => {
    if (!isObj(b)) return false;
    if ("type" in b) return b.type === "object";
    if (typeof b.$ref !== "string" || seen.includes(b.$ref) || seen.length > 16) return false;
    return object(target(b.$ref), [...seen, b.$ref]);
  };
  const walk = (s, depth) => {
    if (!isObj(s) || depth > 64) return;
    if (!("type" in s) && Array.isArray(s.oneOf) && s.oneOf.length && s.oneOf.every((b) => object(b))) s.type = "object";
    for (const k of ["items", "additionalItems", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames", "additionalProperties", "unevaluatedProperties"]) walk(s[k], depth + 1);
    for (const k of ["anyOf", "oneOf", "allOf", "prefixItems"]) for (const v of Array.isArray(s[k]) ? s[k] : []) walk(v, depth + 1);
    for (const k of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) if (isObj(s[k])) for (const v of Object.values(s[k])) walk(v, depth + 1);
  };
  walk(root, 0);
  return root;
}

// ---------------- 请求体（社区 index.mjs:1495-1533） ----------------

export function qoderBody(chat, m, named = "", task, site) {
  const system = (chat.messages ?? []).filter((x) => x.role === "system" || x.role === "developer").map((x) => textOf(x.content)).filter(Boolean).join("\n\n");
  const tools = chat.tool_choice !== "none" ? (chat.tools ?? []).filter((t) => t?.type === "function" && t.function?.name) : [];
  let sysText = system ? QODER_SYS + "\n\n" + system : QODER_SYS;
  if (chat.tool_choice === "required" && tools.length) sysText += "\nYou must call an available function in this response.";
  const sys = { type: "text", text: sysText };
  const budget = chat.max_completion_tokens || chat.max_tokens || 0;
  const [thinking, effort] = effortFor(chat.reasoning_effort, m, typeof budget === "number" ? budget : 0);
  const asked = chat.max_completion_tokens || chat.max_tokens || 32000;
  const params = { enable_thinking: thinking, max_tokens: asked };
  if (effort) params.reasoning_effort = effort;
  const window = m.maxInput || m.context || 0;
  if (window > 0) params.context_length = window;
  const request = randomUUID();
  const session = sessionOf(chat, named);
  task ??= taskOf(session, chat);
  const body = {
    request_id: request,
    request_set_id: task.id,
    chat_record_id: request,
    session_id: session,
    parameters: params,
    business: {
      product: site?.businessProduct ?? "app",
      version: COSY_VERSION,
      type: "agent",
      id: task.id,
      name: task.name ?? "",
      begin_at: task.begin,
      stage: task.answered ? "processing" : "start",
      model_key: m.key,
    },
    agent_id: "agent_common",
    task_id: "common",
    session_type: site?.sessionType ?? "app",
    model_config: modelConfig(m, thinking),
    system: [sys],
    messages: [{ role: "system", content: [sys] }, ...cacheMarked(qoderMessages(chat.messages ?? []))],
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: typedUnions(t.function.parameters) ?? { type: "object", properties: {} },
      },
    }));
  }
  return body;
}

// ---------------- 回复解析（社区 index.mjs:1907-2417） ----------------

const CALL_OPEN = "<tool_call>";
const CALL_CLOSE = "</tool_call>";
const FUNC = /<function=([^>]+)>([\s\S]*?)<\/function>/;
const PARAM = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

const propsOf = (tools, name) => (tools.find((t) => (t.function ?? t)?.name === name)?.function ?? {}).parameters?.properties ?? {};

function valueOf(v, prop) {
  if (prop?.type === "string") return v;
  try {
    return JSON.parse(v.trim());
  } catch {
    return v;
  }
}

function parseCall(v, tools = []) {
  try {
    const f = JSON.parse(v.trim());
    if (String(f?.name ?? "").trim() && f.arguments && typeof f.arguments === "object" && !Array.isArray(f.arguments)) {
      return { name: f.name.trim(), args: JSON.stringify(f.arguments) };
    }
  } catch {}
  const m = FUNC.exec(v);
  if (!m || !m[1].trim()) return null;
  const name = m[1].trim();
  const props = propsOf(tools, name);
  const args = {};
  for (const pm of m[2].matchAll(PARAM)) {
    const key = pm[1].trim();
    if (!key) continue;
    args[key] = valueOf(pm[2].trim(), props[key]);
  }
  return { name, args: JSON.stringify(args) };
}

const XML_AT = /<(?:antml:)?(?:function_calls>|invoke\s+name\s*=|function=)/;
const XML_HOLD = /<(?:antml:)?(?:invoke\s[^<>]{0,300}|function=[^<>]{0,300})$/;
const XML_STARTS = ["<invoke ", "<antml:invoke ", "<function="];
const XML_MARKS = ["<function_calls>", "<antml:function_calls>", ...XML_STARTS];
const XML_NEXT = /<(?:antml:)?invoke\s+name\s*=|<function=/;
const XML_PARAM = /<(?:antml:)?parameter(?:\s+name\s*=\s*"([^"]+)"|=([^\s>]+))\s*>/g;
const XML_CLOSES = ["</function_calls>", "</antml:function_calls>", "</invoke>", "</antml:invoke>", "</function>"];
const XML_LEFT = /^(?:\s+|<\/(?:antml:)?(?:function_calls|invoke|function)>)+/;

function xmlArgs(s, props) {
  const opens = [...s.matchAll(XML_PARAM)];
  const args = {};
  let closed = opens.length > 0;
  opens.forEach((m, k) => {
    let v = s.slice(m.index + m[0].length, k + 1 < opens.length ? opens[k + 1].index : s.length);
    const c = v.search(/<\/(?:antml:)?parameter>/);
    if (c >= 0) v = v.slice(0, c);
    else closed = false;
    args[m[1] ?? m[2]] = valueOf(v.replace(/^\r?\n|\r?\n$/g, ""), props[m[1] ?? m[2]]);
  });
  return { args, closed };
}

function xmlCall(s, end, tools) {
  const w = s.match(/^<(?:antml:)?function_calls>/);
  if (w) {
    const rest = s.slice(w[0].length).replace(/^\s+/, "");
    if (!end && (!rest || XML_STARTS.some((k) => k.startsWith(rest)))) return { wait: true };
    s = rest;
  }
  let m = s.match(/^<(?:antml:)?invoke\s+name\s*=\s*"([^"<>]+)"\s*>/);
  let closeRe = /<\/(?:antml:)?invoke\s*>/;
  if (!m) {
    m = s.match(/^<function=([^\s<>]+?)\s*>/);
    closeRe = /<\/function\s*>/;
  }
  if (!m) {
    if (!end && (XML_STARTS.some((k) => k.startsWith(s)) || /^<(?:antml:)?(?:invoke\s|function=)[^<>]{0,300}$/.test(s))) return { wait: true };
    return { text: true };
  }
  const name = m[1].trim();
  if (!tools.some((t) => (t.function ?? t)?.name === name)) return { text: true };
  const body = s.slice(m[0].length);
  const c = body.match(closeRe);
  const n = body.search(XML_NEXT);
  let stop = c ? c.index : -1;
  if (n >= 0 && (stop < 0 || n < stop)) stop = n;
  if (stop < 0) {
    if (!end) return { wait: true };
    stop = body.length;
  }
  const whole = !!c && c.index === stop;
  const p = xmlArgs(body.slice(0, stop), propsOf(tools, name));
  if (!whole && !p.closed) {
    if (!/<(?:antml:)?parameter\b/.test(body.slice(0, stop))) return { text: true };
    return { error: CUT_SHORT };
  }
  return { call: { name, args: JSON.stringify(p.args) }, rest: whole ? body.slice(stop + c[0].length) : body.slice(stop) };
}

function quoted(text) {
  const fence = String.fromCharCode(96);
  if ((text.match(new RegExp(fence + "{3}", "g"))?.length ?? 0) % 2) return true;
  const line = text.slice(text.lastIndexOf("\n") + 1).replace(new RegExp(fence + "{3}", "g"), "");
  return (line.match(new RegExp(fence, "g"))?.length ?? 0) % 2 === 1;
}

const callish = (v) => v.trimStart().startsWith("{") || v.includes("<function=");
const CUT_SHORT = "the model's tool call, written as text, was cut short; it is not sent on as the answer";
const UNREADABLE = "the model's tool call, written as text, can't be read; it is not sent on as the answer";

// Splitter：把流式文本按 tool-call 边界切分（社区 index.mjs:2050-2204）。
class Splitter {
  textBuf = "";
  callBuf = "";
  inCall = false;
  sawTool = false;
  after = false;
  sent = "";
  constructor(tools = []) {
    this.tools = tools.filter((t) => (t?.function ?? t)?.name);
  }
  text(out, t) {
    this.sent += t;
    out.push({ text: t });
  }
  bare(out, comb, x, end) {
    const head = comb.slice(0, x);
    const at = comb.slice(x);
    const opener = at.match(/^<[^<>]*>?/)[0];
    if (quoted(this.sent + head)) {
      this.text(out, head + opener);
      return at.slice(opener.length);
    }
    const b = xmlCall(at, end, this.tools);
    if (b.wait) {
      if (head) this.text(out, head);
      this.textBuf = at;
      return null;
    }
    if (b.text) {
      this.text(out, head + opener);
      return at.slice(opener.length);
    }
    if (head) this.text(out, head);
    if (b.error) {
      out.push({ error: b.error });
      return false;
    }
    this.sawTool = true;
    out.push({ call: b.call });
    this.after = true;
    return b.rest;
  }
  left(comb, end) {
    const rest = comb.replace(XML_LEFT, "");
    if (!end && (!rest || XML_CLOSES.some((c) => c.length > rest.length && c.startsWith(rest)))) return null;
    this.after = false;
    return rest;
  }
  feed(input) {
    const out = [];
    while (input) {
      if (!this.inCall) {
        let comb = this.textBuf + input;
        this.textBuf = "";
        if (this.after) {
          const rest = this.left(comb, false);
          if (rest === null) {
            this.textBuf = comb;
            break;
          }
          comb = rest;
          if (!comb) break;
        }
        const i = comb.indexOf(CALL_OPEN);
        const x = this.tools.length ? comb.search(XML_AT) : -1;
        if (x >= 0 && (i < 0 || x < i)) {
          const next = this.bare(out, comb, x, false);
          if (next === false) return out;
          if (next === null) break;
          input = next;
          continue;
        }
        if (i < 0) {
          let keep = 0;
          for (const mark of this.tools.length ? [CALL_OPEN, ...XML_MARKS] : [CALL_OPEN]) {
            for (let n = Math.min(mark.length - 1, comb.length); n > keep; n--) {
              if (comb.endsWith(mark.slice(0, n))) {
                keep = n;
                break;
              }
            }
          }
          const h = this.tools.length ? comb.search(XML_HOLD) : -1;
          if (h >= 0) keep = Math.max(keep, comb.length - h);
          if (keep < comb.length) this.text(out, comb.slice(0, comb.length - keep));
          this.textBuf = comb.slice(comb.length - keep);
          break;
        }
        if (i > 0) this.text(out, comb.slice(0, i));
        input = comb.slice(i + CALL_OPEN.length);
        this.inCall = true;
        continue;
      }
      const comb = this.callBuf + input;
      this.callBuf = "";
      const j = comb.indexOf(CALL_CLOSE);
      if (j < 0) {
        this.callBuf = comb;
        break;
      }
      const body = comb.slice(0, j);
      const c = parseCall(body, this.tools);
      if (c) {
        this.sawTool = true;
        out.push({ call: c });
      } else if (callish(body) && !quoted(this.sent)) {
        this.inCall = false;
        out.push({ error: UNREADABLE });
        return out;
      } else {
        this.text(out, CALL_OPEN + body + CALL_CLOSE);
      }
      input = comb.slice(j + CALL_CLOSE.length);
      this.inCall = false;
    }
    return out;
  }
  flush() {
    if (this.inCall) {
      const body = this.callBuf;
      this.inCall = false;
      this.callBuf = "";
      if (callish(body) && !quoted(this.sent)) {
        const c = parseCall(body, this.tools);
        if (!c) return [{ error: CUT_SHORT }];
        this.sawTool = true;
        return [{ call: c }];
      }
      const t = CALL_OPEN + body;
      this.sent += t;
      return [{ text: t }];
    }
    if (this.textBuf) {
      let t = this.textBuf;
      this.textBuf = "";
      if (this.after) t = this.left(t, true);
      const out = [];
      while (t) {
        const x = this.tools.length ? t.search(XML_AT) : -1;
        if (x < 0) {
          this.text(out, t);
          break;
        }
        const next = this.bare(out, t, x, true);
        if (next === false) break;
        t = this.after ? this.left(next, true) : next;
      }
      return out;
    }
    return [];
  }
}

async function* sseLines(body) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let n;
    while ((n = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, n).trim();
      buf = buf.slice(n + 1);
    }
  }
  if (buf.trim()) yield buf.trim();
}

// events：把 Qoder SSE 信封拆成 OpenAI chunk 事件（社区 index.mjs:2223-2341）。
async function* events(body, tools = []) {
  const a = new Splitter(tools);
  let index = -1;
  const native = new Map();
  const piece = (f) => (f.call ? { tool: { index: ++index, id: "call_" + randomUUID().replaceAll("-", ""), name: f.call.name, args: f.call.args } } : f.error ? { error: { status: 502, message: f.error } } : { text: f.text });
  let usage;
  let fr = "";
  let said = false;
  for await (const line of sseLines(body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    let env;
    try {
      env = JSON.parse(payload);
    } catch {
      continue;
    }
    const inner = typeof env?.body === "string" ? env.body : "";
    if (env?.statusCodeValue != null && env.statusCodeValue !== 200) {
      yield { error: failure(Number(env.statusCodeValue), inner || payload) };
      return;
    }
    if (inner.trim() === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(inner.trim());
    } catch {
      continue;
    }
    if (!Array.isArray(chunk?.choices) && (chunk?.error || (chunk?.code != null && chunk?.message))) {
      yield { error: failure(502, inner) };
      return;
    }
    const delta = chunk?.choices?.[0]?.delta ?? {};
    if (delta.reasoning_content) {
      said = true;
      yield { reasoning: delta.reasoning_content };
    }
    if (typeof delta.content === "string") {
      for (const f of a.feed(delta.content)) {
        if (!f.call && !f.error && !f.text) continue;
        const e = piece(f);
        yield e;
        if (e.error) return;
        said = true;
      }
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0);
      const name = typeof tc.function?.name === "string" ? tc.function.name.trim() : "";
      const args = tc.function?.arguments ?? "";
      if (!tc.id && !name && !args) continue;
      let call = native.get(i);
      if (!call) {
        call = { id: "", args: "" };
        native.set(i, call);
      }
      if (tc.id) call.id = tc.id;
      if (call.index === undefined) {
        call.args += args;
        if (!name) continue;
        for (const f of a.flush()) {
          const e = piece(f);
          yield e;
          if (e.error) return;
        }
        a.sawTool = said = true;
        call.index = ++index;
        yield { tool: { index: call.index, id: call.id || "call_" + randomUUID().replaceAll("-", ""), name, args: call.args } };
      } else if (args) {
        yield { args: { index: call.index, text: args } };
      }
    }
    fr = chunk?.choices?.[0]?.finish_reason || fr;
    const u = chunk?.usage;
    if (u) {
      usage = {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        ...(u.prompt_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}),
        ...(u.completion_tokens_details?.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } } : {}),
      };
    }
  }
  for (const f of a.flush()) {
    const e = piece(f);
    yield e;
    if (e.error) return;
    said = true;
  }
  const nameless = [...native.values()].filter((call) => call.index === undefined).length;
  if (nameless && !said) {
    yield { error: { status: 502, message: UNREADABLE, nameless: true } };
    return;
  }
  if (nameless) console.warn("qoder: dropped " + nameless + " native tool call" + (nameless > 1 ? "s" : "") + " the model never named");
  yield { stop: a.sawTool ? "tool_calls" : fr === "length" ? "length" : "stop", usage };
}

async function opened(res, tools) {
  const it = events(res.body, tools);
  return { it, first: await it.next() };
}

// answer：把 Qoder 回复翻回 OpenAI Chat Completions（社区 index.mjs:2358-2417）。
async function answer({ it, first }, chat, servedName = chat.model) {
  const id = "chatcmpl-" + randomUUID().replaceAll("-", "");
  const created = Math.floor(Date.now() / 1000);
  if (first.value?.error) return errorResponse(first.value.error);
  if (first.done) return errorResponse({ status: 502, message: "Qoder ended without an answer" });

  if (!chat.stream) {
    const msg = { role: "assistant", content: "" };
    let reasoning = "";
    const calls = [];
    let stop = "stop";
    let usage;
    for (let r = first; !r.done; r = await it.next()) {
      const e = r.value;
      if (e.error) return errorResponse(e.error);
      if (e.text) msg.content += e.text;
      if (e.reasoning) reasoning += e.reasoning;
      if (e.tool) calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } });
      if (e.args) calls[e.args.index].function.arguments += e.args.text;
      if (e.stop) [stop, usage] = [e.stop, e.usage];
    }
    if (reasoning) msg.reasoning_content = reasoning;
    if (calls.length) msg.tool_calls = calls;
    return Response.json({ id, object: "chat.completion", created, model: servedName, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(usage ? { usage } : {}) });
  }

  const enc = new TextEncoder();
  const chunk = (delta, finish_reason = null, extra = {}) =>
    enc.encode("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: servedName, choices: [{ index: 0, delta, finish_reason }], ...extra }) + "\n\n");
  let pending = first;
  let began = false;
  const stream = new ReadableStream({
    async pull(ctl) {
      const r = pending ?? (await it.next());
      pending = null;
      if (!began) {
        began = true;
        ctl.enqueue(chunk({ role: "assistant", content: "" }));
      }
      if (r.done) {
        ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        return ctl.close();
      }
      const e = r.value;
      if (e.text) ctl.enqueue(chunk({ content: e.text }));
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }));
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } }] }));
      else if (e.args) ctl.enqueue(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }));
      else if (e.stop) ctl.enqueue(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}));
      else if (e.error) {
        ctl.enqueue(enc.encode("data: " + JSON.stringify({ error: { message: e.error.message, code: e.error.status } }) + "\n\n"));
        ctl.close();
      }
    },
    cancel() {
      it.return?.();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

// ask：一次 Chat Completions 请求的完整通路。
export async function ask(chat, cred, init, site, model, named = "") {
  const CHAT_URL = site.api + CHAT_PATH;
  const task = taskOf(sessionOf(chat, named), chat);
  let body;
  try {
    body = qoderBody(chat, model, named, task, site);
  } catch (e) {
    return errorResponse({ status: 400, message: e?.message ?? String(e) });
  }
  let res = null;
  for (let attempt = 0; ; attempt++) {
    // 每次重试都重建请求体：request_id 是这次请求自己的。
    const attemptBody = attempt === 0 ? body : qoderBody(chat, model, named, task, site);
    const wire = encodeBody(JSON.stringify(attemptBody));
    const headers = chatHeaders(CHAT_URL, cred, wire, site, model);
    try {
      res = await fetch(CHAT_URL, { method: "POST", headers, body: wire, signal: init?.signal });
    } catch (e) {
      return errorResponse({ status: 502, message: e.message });
    }
    if (res.ok) break;

    const text = await res.text().catch(() => "");
    const f = failure(res.status, text);
    const wait = Number(f?.retryAfter);
    if (attempt < QUEUE_RETRIES && Number.isFinite(wait) && wait > 0) {
      try {
        await sleepMs(Math.min(wait, QUEUE_MAX_WAIT_S) * 1000, init?.signal);
      } catch (e) {
        return errorResponse({ status: 499, message: e.message });
      }
      continue;
    }

    const out = new Headers(res.headers);
    out.delete("content-length");
    out.delete("content-encoding");
    if (f?.signIn) out.set("x-magpie-sign-in", f.signIn);
    else if (res.status === 401 || res.status === 403) out.set("x-magpie-sign-in", "kept");
    if (!out.has("content-type")) out.set("content-type", "application/json");
    return new Response(text, { status: res.status, headers: out });
  }
  let open;
  try {
    open = await opened(res, chat.tool_choice !== "none" ? (chat.tools ?? []).filter((t) => t?.type === "function") : []);
  } catch (e) {
    return errorResponse({ status: 502, message: e.message });
  }
  if (!open.first.value?.error) task.answered = true;
  const name = model.name?.trim();
  const servedName = name && name !== model.key ? name : chat.model;
  return answer(open, chat, servedName);
}
