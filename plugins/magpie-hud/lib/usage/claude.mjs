// Claude 的套餐窗口：经 Claude Code 自家 engine 的 get_usage 读，协议与字段
// 照 Agent HUD 的 claude/engine_usage.rs + quota_windows.rs，不猜。
//
// spawn `claude -p --input-format stream-json --output-format stream-json
// --verbose --settings {"disableAllHooks":true}`，写一行 control_request
// {subtype:"get_usage"}，读 stream-json 行里的 control_response：
// response.response 即载荷（rate_limits_available + rate_limits）。
// 账号与套餐来自 .claude.json 的 oauthAccount（CLAUDE_CONFIG_DIR 下，否则
// ~/.claude.json）。只读：不写任何凭证、不改任何配置。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENGINE_DEADLINE_MS = 30_000;
const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function claudeCommand() {
  return (process.env.MAGPIE_AGENTS_CLAUDE_CMD || "claude").split(/\s+/).filter(Boolean);
}

// .claude.json 的位置：CLAUDE_CONFIG_DIR 设了就在它下面，否则在家目录
// （Claude Code 自己的约定，account.rs 的 global_config）。
function globalConfigPath() {
  const dir = process.env.MAGPIE_AGENTS_HOME || process.env.CLAUDE_CONFIG_DIR || homeDir();
  return join(dir, ".claude.json");
}

function profile() {
  try {
    return JSON.parse(readFileSync(globalConfigPath(), "utf8")).oauthAccount ?? {};
  } catch {
    return {};
  }
}

function identityOf(value) {
  const user = typeof value.accountUuid === "string" ? value.accountUuid : "";
  const org = typeof value.organizationUuid === "string" ? value.organizationUuid : "";
  return user || org ? user + "/" + org : null;
}

// plan 的叫法照 quota_windows.rs 的 plan()：organizationType 映射，max 再看
// tier 是 5x 还是 20x；没有 organizationType 时从 tier 猜。
function planOf(value) {
  const type = typeof value.organizationType === "string" ? value.organizationType : "";
  const tier =
    typeof value.userRateLimitTier === "string" ? value.userRateLimitTier
    : typeof value.organizationRateLimitTier === "string" ? value.organizationRateLimitTier
    : "";
  let base = { claude_max: "max", claude_pro: "pro", claude_team: "team", claude_enterprise: "enterprise" }[type];
  if (!base) {
    base = type.startsWith("claude_")
      ? type.slice("claude_".length)
      : ["max", "pro", "team", "enterprise"].find((plan) => tier.includes(plan)) ?? null;
  }
  if (!base) return null;
  if (base === "max" && type === "claude_max") {
    if (tier === "default_claude_max_5x") return "max_5x";
    if (tier === "default_claude_max_20x") return "max_20x";
  }
  return base;
}

function statusOf(percent) {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}

function windowOf(object, valueKey) {
  if (!object || typeof object !== "object") return null;
  const percent = object[valueKey];
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const reset =
    typeof object.resets_at === "string" && !Number.isNaN(Date.parse(object.resets_at)) ? object.resets_at : null;
  return { percent, reset };
}

function familyOf(model) {
  for (const word of String(model).toLowerCase().split(/[^a-z0-9]+/)) {
    if (FAMILIES.includes(word)) return word;
  }
  return null;
}

// rate_limits 的窗口，顺序照 Claude Code 自己的 /usage 屏：会话、全模型周窗、
// 各模型家族周窗（家族按字母序）。limits[] 里 kind=weekly_scoped 的条目优先。
function windowsOf(limits) {
  const session = windowOf(limits.five_hour, "utilization");
  const week = windowOf(limits.seven_day, "utilization");
  if (!session && !week) return null;
  const families = new Map();
  for (const family of FAMILIES) {
    const found = windowOf(limits["seven_day_" + family], "utilization");
    if (found) families.set(family, found);
  }
  for (const entry of Array.isArray(limits.limits) ? limits.limits : []) {
    if (entry?.kind !== "weekly_scoped") continue;
    const model = entry?.scope?.model ?? {};
    const name =
      typeof model.display_name === "string" ? model.display_name
      : typeof model.id === "string" ? model.id
      : null;
    if (!name) continue;
    const key = familyOf(name) ?? name.toLowerCase();
    const found = windowOf(entry, "percent");
    if (found) families.set(key, found);
  }
  const rows = [];
  if (session) {
    rows.push({ id: "claude-session", name: "Current session", shortLabel: "5h", usedPercent: session.percent, resetAt: session.reset, status: statusOf(session.percent), windowDurationSeconds: 5 * 3600 });
  }
  if (week) {
    rows.push({ id: "claude-weekly", name: "Weekly limit · All models", shortLabel: "7d", usedPercent: week.percent, resetAt: week.reset, status: statusOf(week.percent), windowDurationSeconds: 7 * 86400 });
  }
  for (const [family, found] of [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push({
      id: "claude-weekly-" + family,
      name: "Weekly limit · " + family[0].toUpperCase() + family.slice(1),
      shortLabel: "7d " + family,
      usedPercent: found.percent,
      resetAt: found.reset,
      status: statusOf(found.percent),
      windowDurationSeconds: 7 * 86400,
    });
  }
  return rows;
}

function runEngine() {
  return new Promise((resolve) => {
    const [cmd, ...base] = claudeCommand();
    const args = [...base, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--settings", '{"disableAllHooks":true}'];
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "magpie-agents" } });
    } catch (error) {
      resolve({ error: "Claude Code engine could not start: " + error.message });
      return;
    }
    let buffer = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(value);
    };
    const timer = setTimeout(() => done({ error: "Claude Code engine query timed out" }), ENGINE_DEADLINE_MS);
    child.on("error", (error) => done({ error: "Claude Code engine (claude command) not found: " + error.message }));
    child.on("exit", () => done({ error: "Claude Code engine exited before answering get_usage" }));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.type !== "control_response") continue;
        if (message?.response?.subtype === "error") {
          done({ error: "Claude Code engine query failed: " + (message.response.error ?? "unknown error") });
          return;
        }
        const payload = message?.response?.response;
        if (payload && typeof payload === "object") done({ payload });
      }
    });
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "magpie-agents-usage", request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
  });
}

// list_quotas 的 Claude 部分：ok（带账号与窗口）/ no_plan_limits / failed。
export async function readClaudeQuota() {
  const before = profile();
  const engine = await runEngine();
  if (engine.error) return { client: "claude", status: "failed", notice: engine.error };
  const payload = engine.payload;
  if (payload.rate_limits_available === true && !payload.rate_limits) {
    return { client: "claude", status: "failed", notice: "Couldn't read the Claude quota this time; retry shortly" };
  }
  if (payload.rate_limits_available !== true) {
    // get_usage 对 API key 登录和未登录都报无套餐限额（engine_usage.rs）。
    return { client: "claude", status: "no_plan_limits", notice: "Claude Code reports no plan limits: an API key login, or signed out" };
  }
  const rows = windowsOf(payload.rate_limits);
  if (!rows) return { client: "claude", status: "failed", notice: "The Claude Code engine returned unrecognised usage data" };
  const after = profile();
  if (identityOf(before) !== identityOf(after)) {
    return { client: "claude", status: "failed", notice: "The Claude account changed during the quota query; retry shortly" };
  }
  return {
    client: "claude",
    status: "ok",
    account: { label: typeof before.emailAddress === "string" ? before.emailAddress : null, plan: planOf(before) },
    quotas: rows,
  };
}
