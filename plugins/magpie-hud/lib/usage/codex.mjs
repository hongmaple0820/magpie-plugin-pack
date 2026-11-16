// Codex 的套餐窗口：经 Codex CLI 自家 app-server 的 JSON-RPC 读，协议与
// 字段照 Agent HUD 的 codex/account.rs + limits.rs，不猜。
//
// spawn `codex app-server --listen stdio://`（env CODEX_HOME），发
// initialize → initialized → account/rateLimits/read + account/read；
// id=2 的 result 是限额（rateLimitsByLimitId 多桶或旧版单桶 rateLimits，
// 外加 rateLimitResetCredits），id=3 的 result 是 {account, requiresOpenaiAuth}。
// 只读：不写任何凭证、不改任何配置。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DEADLINE_MS = 25_000;

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

function codexCommand() {
  return (process.env.MAGPIE_AGENTS_CODEX_CMD || "codex").split(/\s+/).filter(Boolean);
}

function codexHome() {
  if (process.env.MAGPIE_AGENTS_HOME) return join(process.env.MAGPIE_AGENTS_HOME, ".codex");
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function statusOf(percent) {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}

function periodOf(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  if (seconds <= 5 * 3600 + 60) return { name: "5-hour usage", short: "5h" };
  if (seconds <= 7 * 86400 + 60) return { name: "Weekly usage", short: "7d" };
  if (seconds <= 30 * 86400 + 60) return { name: "Monthly usage", short: "30d" };
  return { name: "Usage", short: Math.round(seconds / 86400) + "d" };
}

// rateLimitResetCredits：availableCount + credits[]（按过期时间排序），照
// limits.rs 的 parse_reset_credits。
function resetCreditsOf(limits) {
  const raw = limits.rateLimitResetCredits ?? limits.rate_limit_reset_credits;
  if (!raw || typeof raw !== "object") return null;
  const count = raw.availableCount ?? raw.available_count;
  if (typeof count !== "number") return null;
  const credits = (Array.isArray(raw.credits) ? raw.credits : [])
    .map((item) => {
      if (typeof item?.id !== "string") return null;
      const rawExp = item.expiresAt ?? item.expires_at;
      let expiresAt = null;
      if (typeof rawExp === "number" && Number.isFinite(rawExp)) expiresAt = new Date(rawExp * 1000).toISOString();
      else if (typeof rawExp === "string") expiresAt = rawExp;
      return { id: item.id, expiresAt };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.expiresAt ?? "").localeCompare(String(b.expiresAt ?? "")));
  const out = { availableCount: count };
  if (credits.length) out.credits = credits;
  return out;
}

// 限额解析照 limits.rs 的 parse：多桶 rateLimitsByLimitId 优先（空映射也算
// 权威），否则旧版单桶 rateLimits（limitId）；codex 桶排最前；每桶
// primary/secondary 两个窗口（usedPercent 有限才算数）。
function parseLimits(limits, account) {
  const email = typeof account?.email === "string" ? account.email : "";
  let buckets = [];
  if (limits.rateLimitsByLimitId && typeof limits.rateLimitsByLimitId === "object") {
    buckets = Object.entries(limits.rateLimitsByLimitId);
  } else if (limits.rateLimits && typeof limits.rateLimits === "object") {
    buckets = [[typeof limits.rateLimits.limitId === "string" ? limits.rateLimits.limitId : "codex", limits.rateLimits]];
  }
  buckets.sort((a, b) => (a[0] === "codex" ? -1 : b[0] === "codex" ? 1 : a[0].localeCompare(b[0])));
  const plan =
    buckets.map(([, bucket]) => (typeof bucket?.planType === "string" ? bucket.planType : null)).find(Boolean) ??
    (typeof account?.planType === "string" ? account.planType : null);
  const quotas = [];
  for (const [bucketId, bucket] of buckets) {
    const service = typeof bucket?.limitName === "string" ? bucket.limitName : bucketId;
    for (const slot of ["primary", "secondary"]) {
      const window = bucket?.[slot];
      const percent = window?.usedPercent;
      if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
      const seconds = typeof window?.windowDurationMins === "number" ? window.windowDurationMins * 60 : null;
      const period = periodOf(seconds);
      const name =
        bucketId === "codex"
          ? slot === "secondary" ? "Secondary window" : period?.name ?? "Usage"
          : service + " · " + (period?.name ?? slot === "secondary" ? "Secondary" : "Usage");
      const resetAt =
        typeof window?.resetsAt === "number" && Number.isFinite(window.resetsAt)
          ? new Date(window.resetsAt * 1000).toISOString()
          : null;
      quotas.push({
        id: "codex:" + bucketId + ":" + slot,
        name,
        shortLabel: bucketId === "codex" ? period?.short ?? (slot === "secondary" ? "2nd" : "usage") : (period ? service + " " + period.short : service),
        usedPercent: percent,
        resetAt,
        status: statusOf(percent),
        windowDurationSeconds: seconds,
      });
    }
  }
  const out = {
    client: "codex",
    status: quotas.length ? "ok" : "no_plan_limits",
    account: { label: email || null, plan },
    quotas,
  };
  const credits = resetCreditsOf(limits);
  if (credits) out.resetCredits = credits;
  return out;
}

function runAppServer() {
  return new Promise((resolve) => {
    const [cmd, ...base] = codexCommand();
    let child;
    try {
      child = spawn(cmd, [...base, "app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: codexHome() } });
    } catch (error) {
      resolve({ error: "Codex app-server could not start: " + error.message });
      return;
    }
    let buffer = "";
    let settled = false;
    let limits = null;
    let refused = null;
    let account = null;
    let requiresOpenaiAuth = null;
    let accountAnswered = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ limits, refused, account, requiresOpenaiAuth });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ error });
    };
    const timer = setTimeout(() => fail("Codex quota query timed out"), DEADLINE_MS);
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", (error) => fail("Codex engine (codex command) not found: " + error.message));
    child.on("exit", () => fail("Codex exited before reporting limits; check local sign-in"));
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
        const id = typeof message?.id === "number" ? message.id : null;
        if (id === null) continue;
        if (message.error && typeof message.error === "object") {
          // 没有 account/read 的老 app-server 也能报限额；id=2 报错说明限额
          // 需要登录，id=3 报错只是拿不到邮箱。
          if (id === 3) accountAnswered = true;
          else if (id === 2) refused = message.error.message ?? "app-server error";
          else fail("Codex: " + (message.error.message ?? "app-server error"));
        } else if (message.result !== undefined) {
          if (id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read" });
            send({ id: 3, method: "account/read", params: {} });
          } else if (id === 2) {
            limits = message.result;
          } else if (id === 3) {
            account = message.result?.account ?? null;
            requiresOpenaiAuth = message.result?.requiresOpenaiAuth ?? null;
            accountAnswered = true;
          }
        }
        if ((limits || refused) && accountAnswered) finish();
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "magpie-agents", title: "magpie-agents", version: "0.1.0" } } });
  });
}

// list_quotas 的 Codex 部分：ok / signed_out / no_plan_limits / failed。
export async function readCodexQuota() {
  const result = await runAppServer();
  if (result.error) return { client: "codex", status: "failed", notice: result.error };
  const { limits, refused, account, requiresOpenaiAuth } = result;
  if (!limits) {
    if (refused) {
      if (requiresOpenaiAuth === true && !account) {
        return { client: "codex", status: "signed_out", notice: "Codex is not signed in. Run codex login with ChatGPT to read its quota" };
      }
      if (account?.type === "apiKey") {
        return { client: "codex", status: "no_plan_limits", notice: "Codex is signed in with an API key, which has no ChatGPT plan limits" };
      }
      return { client: "codex", status: "no_plan_limits", notice: "Codex: " + refused };
    }
    return { client: "codex", status: "failed", notice: "Codex exited before reporting limits; check local sign-in" };
  }
  return parseLimits(limits, account);
}
