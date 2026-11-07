/**
 * 墨点额度 → magpie 的 auth.usage 返回值。
 * 管理面用 JWT（Bearer + Cookie uaa-token），不是 TokenPlan API Key。
 */
import { PROVIDER_NAME } from "./constants.mjs";
import { isAuthFailure } from "./http.mjs";
import { getBalance, listPackages, snapshotOf } from "./tokenplan.mjs";

function windowOf(name, remain, limit, resetsAt, span) {
  const left = Math.max(0, Number(remain) || 0);
  const total = Math.max(0, Number(limit) || 0);
  const row = { name, display: `余 ${left} / ${total} 墨点`, unit: "墨点", span };
  if (resetsAt) row.resetsAt = resetsAt;
  if (total > 0) {
    // magpie 用 amount/limit 算百分比：amount 是「已用」而不是「剩余」。
    row.amount = Math.min(total, Math.max(0, total - left));
    row.limit = total;
  } else {
    // 厂商没给窗口上限时只展示，不让路由误判为 100% 用尽。
    row.aside = true;
  }
  return row;
}

export function usageOf(snapshot, { username = "", apiKeyError = "" } = {}) {
  const s = snapshot || {};
  const result = {
    plan: String(s.packageRemark || PROVIDER_NAME),
    user: username,
    balance: `${Number(s.availableCredits) || 0} 墨点`,
    windows: [
      windowOf("5 小时", s.remain5h, s.limit5h, s.recover5h, 5 * 3600),
      windowOf("7 天", s.remain7d, s.limit7d, s.recover7d, 7 * 24 * 3600),
    ],
    // 成功时不写 signIn：magpie 默认「一次正常读取会清除标记」。
    // 写 kept 反而会让被 401 标过的账号一直解不开；失败路径才需要 kept（见 readUsage）。
  };
  if (s.packageEndAt) result.until = s.packageEndAt;
  // 文案不能出现「重新登录」：usage 的 error 里这类字样会被 magpie 当成登录失效标记账号。
  if (apiKeyError) result.error = apiKeyError;
  return result;
}

export async function readUsage(jwt, username, { signal, apiKeyError = "" } = {}) {
  try {
    const [balance, packages] = await Promise.all([
      getBalance(jwt, { signal }),
      listPackages(jwt, { signal }),
    ]);
    return usageOf(snapshotOf(balance, packages), { username, apiKeyError });
  } catch (error) {
    return {
      error: error?.message || "墨点查询失败",
      windows: [],
      signIn: isAuthFailure(error) ? "expired" : "kept",
    };
  }
}
