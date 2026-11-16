// 鹊桥 M1 验收：插件形状（tool 钩子、5 工具、JSON Schema args）、
// list_sessions 的 Claude/Codex 扫描（HOME 指向临时夹具）、未实现工具的
// 里程碑提示、package.json 清单。额度工具的真实协议测试在 quotas.test.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopPageServices } from "../lib/pageservice.mjs";
import { AGENTS_TOOLS } from "../lib/tools.mjs";

// 夹具都在临时 HOME 下：别让真机的 DSH_HOME / 会话缓存混进来。
process.env.DSH_HOME = "";
process.env.MAGPIE_HUD_SESSIONS_CACHE = join(tmpdir(), `hud-tools-cache-${process.pid}.json`);
// 载入插件会按默认策略拉起原生 HUD（lib/desktop.mjs 的 desktopWanted）。测试里必须关掉：
// 否则每跑一次 npm test 就在真实桌面上留一个窗口进程（实测堆过 6 个），
// 而且它占着 desktop-rust/*.exe，临时目录随后删不掉（EPERM）。
process.env.MAGPIE_HUD_DESKTOP = "0";

// zstdFrame 造一个最小 zstd 帧（单个 raw block，无校验和）：魔数小端
// 28 B5 2F FD，帧头描述符 0x00（无 FCS/单段/校验和/字典），窗口描述符
// 0x38（128KB）。夹具都小于一个块。fzstd 解它走真实解压路径。
function zstdFrame(bytes) {
  const h = 1 | (0 << 1) | (bytes.length << 3);
  return Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38]),
    Buffer.from([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]),
    bytes,
  ]);
}


const here = dirname(fileURLToPath(import.meta.url));
const { MagpieHudPlugin } = await import(pathToFileURL(join(here, "..", "index.mjs")).href);

const NAMES = ["list_sessions", "send_message", "start_session", "get_message", "list_quotas"];

test("plugin returns one tool hook with the five tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-hud-tools-"));
  const wasHome = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = home; // 空 HOME：入口预热扫描即时完成
  process.env.MAGPIE_HUD_PAGE_PORT = "0"; // 临时端口：不抢 3477（真实实例可能占着）
  let hooks;
  try {
    hooks = await MagpieHudPlugin({}, {});
  } finally {
    await stopPageServices();
    delete process.env.MAGPIE_HUD_PAGE_PORT;
    if (wasHome == null) delete process.env.MAGPIE_AGENTS_HOME; else process.env.MAGPIE_AGENTS_HOME = wasHome;
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(typeof hooks.tool, "object");
  for (const name of NAMES) {
      const t = hooks.tool[name];
      assert.ok(t, name + " registered");
      assert.equal(typeof t.execute, "function", name + ".execute");
      assert.equal(typeof t.description, "string", name + ".description");
      assert.ok(t.description.length > 40, name + ".description says something");
      assert.equal(t.args.type, "object", name + ".args is a JSON Schema object");
      assert.equal(t.args.additionalProperties, false, name + ".args closes the shape");
  }
});

test("list_sessions scans claude and codex transcripts under HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-agents-"));
  const proj = join(home, ".claude", "projects", "F--maple-demo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "sess-claude-1.jsonl"),
    JSON.stringify({ type: "user", message: { role: "user", content: "fix the login bug" } }) + "\n"
  );
  const day = join(home, ".codex", "sessions", "2026", "11", "11");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-11-11T10-00-00-abc.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "sess-codex-1", cwd: "F:/maple/other" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "write tests" }] } }) + "\n"
  );
  const dsh = join(home, ".dsh", "sessions");
  mkdirSync(dsh, { recursive: true });
  // 旧布局：顶层 *.jsonl
  writeFileSync(
    join(dsh, "dsh-session-1.jsonl"),
    JSON.stringify({ type: "session", version: 4, id: "dsh-1", cwd: "F:/maple/dsh-demo" }) + "\n" +
      JSON.stringify({ type: "user/message", seq: 1, time: 1, data: { source: { kind: "user" }, content: "dsh prompt" } }) + "\n" +
      JSON.stringify({ type: "assistant/message", seq: 2, time: 2, data: { message: { role: "assistant", content: [{ type: "text", text: "dsh answer" }] } } }) + "\n"
  );
  // v4 真实布局：<项目目录>/<会话id>/session.v4.jsonl.zstd（session/title 优先）
  const nested = join(dsh, "--F-maple-dsh-nested--", "11111111-2222-3333-4444-555555555555");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(nested, "session.v4.jsonl.zstd"),
    zstdFrame(Buffer.from(
      JSON.stringify({ type: "session", version: 4, id: "dsh-zstd-1", createdAt: 1, cwd: "F:/maple/dsh-nested" }) + "\n" +
        JSON.stringify({ type: "session/title", seq: 1, time: 1, data: { title: "zstd 会话标题" } }) + "\n" +
        JSON.stringify({ type: "user/message", seq: 2, time: 2, data: { source: { kind: "user" }, content: [{ type: "text", text: "zstd prompt" }] } }) + "\n", "utf8"))
  );
  // 子代理会话：没有 user/message，任务书在 agent/inbox/spliced
  const sub = join(dsh, "--F-maple-dsh-nested--", "sub-1");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, "session.v4.jsonl.zstd"),
    zstdFrame(Buffer.from(
      JSON.stringify({ type: "session", version: 4, id: "dsh-sub-1", createdAt: 1, cwd: "F:/maple/dsh-nested", origin: "subagent" }) + "\n" +
        JSON.stringify({ type: "agent/inbox/spliced", seq: 1, time: 1, data: { target: "next-turn", inserted: [{ content: [{ type: "text", text: "子代理任务书" }] }] } }) + "\n", "utf8"))
  );
  const agBrain = join(home, ".gemini", "antigravity", "brain", "ag-1", ".system_generated", "logs");
  mkdirSync(agBrain, { recursive: true });
  writeFileSync(
    join(agBrain, "transcript.jsonl"),
    JSON.stringify({ type: "USER_INPUT", step_index: 1, created_at: "2026-11-11T10:00:00Z", content: "<USER_REQUEST>ag prompt</USER_REQUEST>" }) + "\n" +
      JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, created_at: "2026-11-11T10:01:00Z", content: "ag answer" }) + "\n"
  );
  process.env.MAGPIE_AGENTS_HOME = home;
  try {
    const hooks = { tool: AGENTS_TOOLS };
    const out = JSON.parse(await hooks.tool.list_sessions.execute({}, {}));
    const byClient = new Map(out.sessions.map((s) => [s.client, s]));
    const claude = byClient.get("claude");
    assert.ok(claude, "claude session found");
    assert.equal(claude.id, "sess-claude-1");
    assert.equal(claude.title, "fix the login bug");
    assert.equal(claude.project, "F--maple-demo");
    // v7 §4.1（2026-11-16）：Claude 只有 mtime，能证明「最近写过」不能证明「在跑」，
    // 所以 state/phase 一律 unknown 并给原因；写入时间改放 recent.lastWriteMs。
    assert.equal(claude.state, "unknown");
    assert.equal(claude.phase, "unknown");
    assert.equal(claude.source.kind, "mtime");
    assert.equal(claude.source.verified, false);
    assert.equal(claude.unknown.reason, "no-truth-source");
    assert.ok(claude.recent.lastWriteMs > 0, "写入时间照给，供排序与「只看活跃」用");
    // presence（v7 §5 P1）：没有签到 → 离线；mtime 不能冒充在线。
    assert.equal(claude.presence, "offline", "没有签到就是离线");
    assert.equal(claude.source.kind, "mtime", "没签到就没有 registry 证据");
    const codex = byClient.get("codex");
    assert.ok(codex, "codex session found");
    assert.equal(codex.id, "sess-codex-1");
    assert.equal(codex.title, "write tests");
    assert.equal(codex.project, "F:/maple/other");
    assert.equal(codex.state, "unknown", "codex 只有 mtime，不该猜在跑");
    assert.ok(out.startFolders.claude, "claude startFolders offered");
    assert.deepEqual(out.startFolders.claude.folders, ["F--maple-demo"]);
    assert.equal(out.startFolders.claude.withoutFolder, true);
    const dshRows = out.sessions.filter((s) => s.client === "dsh");
    assert.ok(dshRows.length >= 3, "dsh sessions found (legacy + zstd + subagent)");
    const dshRow = dshRows.find((s) => s.id === "dsh-1");
    assert.ok(dshRow, "legacy dsh session found");
    assert.equal(dshRow.title, "dsh prompt");
    // 契约：能说 running/idle 的行必须带可证来源（v7 §4.1）
    assert.equal(dshRow.source.kind, "events");
    assert.equal(dshRow.source.verified, true);
    assert.ok(dshRow.source.rule, "要能说出是哪条规则判的");
    assert.ok(dshRow.source.observedAt > 0, "要有观察时刻");
    assert.equal(dshRow.project, "F:/maple/dsh-demo");
    assert.equal(dshRow.reachable, false);
    assert.equal(dshRow.presence, null, "dsh 没有签到通道，presence 只能是 null");
    // 跨客户端不变式（v7 §5 P1 出口）：凡是敢给非 unknown 的 phase，就必须有能被证伪的事件证据。
    // mtime / registry 一律只能 unknown——这条一旦破了，页面又会开始拿文件时间冒充「在跑」。
    for (const s of out.sessions) {
      if (s.phase === "unknown") continue;
      assert.ok(["events", "tap"].includes(s.source.kind), `${s.client}/${s.id} 用 ${s.source.kind} 给出了 ${s.phase}`);
      assert.equal(s.source.verified, true, `${s.client}/${s.id} 的 ${s.phase} 没有可证来源`);
    }
    const zstdRow = dshRows.find((s) => s.id === "dsh-zstd-1");
    assert.ok(zstdRow, "zstd dsh session found");
    // 标题优先级（2026-11-15 界面诊断）：truth.title（尾部窗口最新 session/title）
    // > 头部 titleOwn > 用户输入原文。DSH 生成的标题比 80 字符 prompt 截断更像标题。
    assert.equal(zstdRow.title, "zstd 会话标题");
    assert.equal(zstdRow.project, "F:/maple/dsh-nested");
    const subRow = dshRows.find((s) => s.id === "dsh-sub-1");
    assert.ok(subRow, "subagent dsh session found");
    assert.equal(subRow.title, "子代理任务书");
    const agRow = byClient.get("antigravity");
    assert.ok(agRow, "antigravity session found");
    assert.equal(agRow.id, "antigravity:ag-1");
    assert.equal(agRow.title, "ag prompt");
    assert.equal(agRow.state, "unknown", "antigravity 只有 mtime，不该猜在跑");
    assert.ok(out.startFolders.codex, "codex startFolders offered");
    assert.deepEqual(out.startFolders.codex.folders, ["F:/maple/other"]);
  } finally {
    delete process.env.MAGPIE_AGENTS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("send_message and get_message answer instead of a milestone message", async () => {
  // 空 HOME：send_message 会先 listSessions，别扫真实会话（zstd 解压很慢）。
  const home = mkdtempSync(join(tmpdir(), "magpie-hud-send-"));
  const wasHome = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = home;
  try {
    const hooks = { tool: AGENTS_TOOLS };
    const out = await hooks.tool.send_message.execute({ to: "none", text: "hi" }, {});
    const parsed = JSON.parse(out);
    assert.equal(parsed.state, "refused");
    assert.ok(typeof parsed.reason === "string" && parsed.reason.length > 0);
    const got = JSON.parse(await hooks.tool.get_message.execute({ id: "m-none" }, {}));
    assert.equal(got.state, "unknown");
    assert.ok(typeof got.reason === "string" && got.reason.length > 0);
  } finally {
    if (wasHome == null) delete process.env.MAGPIE_AGENTS_HOME; else process.env.MAGPIE_AGENTS_HOME = wasHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("start_session refuses a call with no text instead of a milestone message", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-hud-start-"));
  const wasHome = process.env.MAGPIE_AGENTS_HOME;
  process.env.MAGPIE_AGENTS_HOME = home;
  try {
    const hooks = { tool: AGENTS_TOOLS };
    const out = await hooks.tool.start_session.execute({ client: "claude" }, {});
    const parsed = JSON.parse(out);
    assert.equal(parsed.state, "refused");
    assert.ok(String(parsed.reason).length > 0, "refused with a reason");
  } finally {
    if (wasHome == null) delete process.env.MAGPIE_AGENTS_HOME; else process.env.MAGPIE_AGENTS_HOME = wasHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("package.json keeps the magpie manifest and the test script", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  assert.equal(pkg.name, "magpie-hud");
  assert.equal(pkg.magpie.name, "鹊楼");
  assert.ok(pkg.magpie.summary.zh.includes("list_sessions"));
  // files 是发布面的唯一事实：漏一个目录 = 装完少一块功能。
  // 这里断言「必须有什么、必须没有什么」，而不是钉死整张表——加目录不该红，漏目录必须红。
  for (const p of ["index.mjs", "lib", "page", "webapp", "dsh"]) {
    assert.ok(pkg.files.includes(p), "files 缺 " + p);
  }
  assert.ok(!pkg.files.includes("desktop"), "已弃用的 wails 目录不该再发布");
  // 桌面桥：desktopBinary() 只认这两个目录（lib/desktop.mjs），漏发等于装完 HUD 静默失效。
  for (const dir of ["desktop-rust", "desktop-native"]) {
    assert.ok(pkg.files.some((f) => f.startsWith(dir + "/")), "files 缺 " + dir + "/");
  }
  assert.ok(pkg.files.some((f) => f.startsWith("desktop-rust/") && f.endsWith(".exe")), "Rust 桥的二进制要进包");
  // dsh/ 是装到 DSH 侧的那段插件，漏发就没人能替你回答审批。
  assert.ok(existsSync(join(here, "..", "dsh", "magpie-hud.mjs")), "dsh/magpie-hud.mjs ships");
  assert.match(pkg.scripts.test, /node --test/);
});
