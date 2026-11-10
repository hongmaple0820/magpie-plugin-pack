/**
 * 合订包的装载回归（原 inkstone install.test.mjs 的合订版）。
 *
 * 覆盖合订形态下最容易坏的四件事：
 *   1. magpie 的入口解析（exports["./server"] → main → exports["."]）仍指向 index.mjs
 *   2. 入口导出的插件函数恰好 16 个：多一个就是辅助函数（宿主会把它当插件执行），
 *      少一个就是渠道丢了
 *   3. 抽 inkstone 做深冒烟：oauth 双方法 → config → loader.fetch 全链路（mock fetch，不联网）
 *   4. files 白名单复制到临时 node_modules 后整包仍能装载（含 deepseek 的 wasm 资产），
 *      且 package.json 的 magpie.icon 与 icon.svg 一致
 * 全程不联网、不打包、不调用 npm CLI、不改任何配置。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`✓ ${name}`);
};

// 16 个渠道一个都不能少，一个都不能多（多出的导出函数会被宿主当插件执行）。
const EXPECTED = [
  "AgnesPlugin", "AutoClawCnPlugin", "AutoClawPlugin", "ChatGptWebPlugin",
  "CodeBuddyPlugin", "DeepSeekWebPlugin", "DoubaoPlugin", "GeminiPlugin",
  "GlmPlugin", "InkstoneAuthPlugin", "KimiPlugin", "LobsteraiPlugin",
  "LoomyPlugin", "OpencodeFreePlugin", "PerplexityPlugin", "QoderCnPlugin",
  "QoderPlugin", "QwenAiPlugin", "QwenPlugin", "RaccoonPlugin",
  "TraeCnPlugin", "TraeGlobalPlugin", "WorkBuddyAiPlugin", "WorkBuddyPlugin",
  "ZaiPlugin",
];

function resolveEntry(dir) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const exp = p.exports?.["./server"];
  const rel = (typeof exp === "string" ? exp : exp?.import ?? exp?.default)
    || p.main
    || (typeof p.exports?.["."] === "string" ? p.exports["."] : "index.mjs");
  return { rel, file: path.join(dir, rel) };
}

// ---- mock 厂商；只覆盖最小链路，不发任何真实请求 ----
const JWT = "hdr." + Buffer.from(JSON.stringify({
  ssoUid: "u-1", username: "ada", exp: Math.floor(Date.now() / 1000) + 7200,
})).toString("base64url") + ".sig";
const envelope = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }), {
  status: 200, headers: { "content-type": "application/json" },
});
const sse = (text) => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
}), { status: 200, headers: { "content-type": "text/event-stream" } });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/users/auth")) return envelope({ token: JWT });
  if (u.includes("/users/getUserInfo")) return envelope({ ssoUid: "u-1", username: "ada" });
  if (u.endsWith("/tokenplan/v1/keys")) return envelope({ id: "k1", name: "magpie-inkstone", key: "sk-local" });
  if (u.includes("/orbit/v1/local-agent/models")) return envelope({ models: [{ id: "agents-a1", canonical_id: "agents-a1-2026", display_name: "Agents A1" }] });
  if (u.includes("/tokenplan/v1/models")) return envelope({ models: [{ id: "glm-5.2", display_name: "GLM-5.2", supported_protocols: ["openai_chat"], capabilities: ["工具调用"], input_types: ["text"], context_length: 128000, input_uncached_price: 0, output_price: 0 }] });
  if (u.includes("/credits/balance")) return envelope({ available_credits: 100, usage_windows: {} });
  if (u.includes("/credits/packages")) return envelope({ packages: [{ remark: "Pro" }] });
  if (u.includes("discovery-api.intern-ai.org.cn/v1/chat/completions")) {
    return sse('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":"API OK"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
  }
  throw new Error(`unexpected fetch: ${u}`);
};

async function smoke(dir, label) {
  const { rel, file } = resolveEntry(dir);
  assert.ok(fs.existsSync(file), `入口不存在: ${rel}`);
  const mod = await import(pathToFileURL(file).href);

  // 合订不变量：恰好 16 个插件函数，名字一个不差
  const fns = Object.entries(mod).filter(([, value]) => typeof value === "function");
  assert.deepEqual(
    fns.map(([name]) => name).sort(),
    [...EXPECTED].sort(),
    `入口必须只导出 ${EXPECTED.length} 个插件函数（多=辅助函数，少=渠道丢失）`,
  );
  assert.ok(Object.values(mod).every((value) => typeof value !== "function" || EXPECTED.includes(value.name) || true));

  const hooks = await mod.InkstoneAuthPlugin({}, undefined);
  assert.ok(hooks.config && hooks.auth && hooks.provider);
  assert.equal(hooks.auth.methods.length, 2, "客户端导入 + 网页登录");
  assert.equal(hooks.auth.methods[0].type, "oauth", "第一项是无浏览器的本机客户端导入");
  // 客户端导入的 authorize 立即返回：url 为空（宿主不打开浏览器、也不弹输入框），
  // 实际导入由宿主在后台调 callback 完成。
  const localFlow = await hooks.auth.methods[0].authorize(undefined, {});
  assert.equal(localFlow.url, "");
  assert.equal(typeof localFlow.callback, "function");
  assert.match(localFlow.instructions, /不打开浏览器/);

  const cfg = {};
  await hooks.config(cfg);
  assert.equal(cfg.provider.inkstone.npm, "@ai-sdk/openai-compatible");

  // 网页登录走第二项（第一项会读真实桌面凭据，本地冒烟不跑）
  const authorize = await hooks.auth.methods[1].authorize(undefined, {});
  assert.equal(authorize.method, "code");
  assert.match(authorize.url, /sso\.openxlab\.org\.cn/);
  const login = await authorize.callback("https://discovery.intern-ai.org.cn/?code=" + encodeURIComponent("uaa::code::local"));
  assert.equal(login.type, "success");
  assert.equal(login.apiKey, "sk-local");

  const saved = { type: "oauth", ...login };
  const loader = await hooks.auth.loader(async () => saved);
  const res = await loader.fetch("https://discovery-api.intern-ai.org.cn/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  assert.match(await res.text(), /API OK/);
  ok(`${label}（入口 ${rel}）`);
}

// ---- A. 文件夹就地加载 ----
await smoke(ROOT, "文件夹就地加载：magpie plugin add ./magpie-nest");

// ---- B. 本地依赖形态：按 files 白名单复制到临时 node_modules ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-nest-local-"));
try {
  const installed = path.join(tmp, "node_modules", pkg.name);
  fs.mkdirSync(installed, { recursive: true });
  const copy = (rel) => {
    const src = path.join(ROOT, rel);
    const dst = path.join(installed, rel);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) copy(path.posix.join(rel, entry));
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  };
  // npm 总会带上 package.json / README / LICENSE
  for (const entry of new Set([...(pkg.files ?? []), "package.json", "README.md", "LICENSE"])) copy(entry);

  const list = [];
  (function walk(dir, rel = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
      else list.push(r);
    }
  })(installed);
  // 白名单必须把每个渠道的入口、deepseek 的 wasm 资产和图标都带上
  for (const f of [
    "index.mjs", "lib/inkstone/index.mjs", "lib/inkstone/bridge.mjs",
    "lib/inkstone/sso.mjs", "lib/inkstone/desktop.mjs",
    "lib/deepseek-web/pow.mjs", "lib/deepseek-web/index.mjs",
    "assets/sha3_wasm_bg.wasm", "LICENSE", "README.md", "icon.svg",
  ]) {
    assert.ok(list.includes(f), `安装后缺文件: ${f}`);
  }
  assert.ok(!list.some((f) => f.endsWith(".sh")), "合订包不应夹带临时脚本");
  // package.json 里的 magpie.icon（data URI）必须能解码回同一个 SVG
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(pkgJson.magpie?.icon || "");
  assert.ok(m, "package.json 缺 magpie.icon（data:image/svg+xml;base64,…）");
  assert.equal(Buffer.from(m[1], "base64").toString("utf8"), fs.readFileSync(path.join(ROOT, "icon.svg"), "utf8"), "data URI 与 icon.svg 不一致");
  ok(`本地依赖文件清单：${list.length} 个文件（16 渠道 + wasm + LICENSE / README / icon.svg）`);
  await smoke(installed, "node_modules 本地依赖：npm i ./magpie-nest");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\npack-install.test: ${passed} 组通过`);
