// 鹊楼的数据引擎：本插件 lib 的注入点。
//
// 会话扫描、journal、额度读取都在本插件自己的 lib 里（原鹊桥
// magpie-agents 插件的 lib，2026-11-12 按用户决定合并进来，插件只剩
// 这一个）。动态导入 + try/catch 保留降级路径：zstd 解压依赖（fzstd）
// 损坏时返回 null，页面服务对 /api/* 返回 requires，面板明说引擎
// 不可用。
// 采样器：10 分钟一次把 list_quotas 读数落进时序（面板的 24h 走势与烧录
// 率靠它）。unref 不挡进程退出；读失败静默跳过（下轮再试）。返回停手
// 函数（测试用）。
export function startQuotaSampler(engine) {
  const tick = async () => {
    try {
      const { QuotaHistory } = await import("./usage/history.mjs");
      new QuotaHistory().record(await engine.listQuotas());
    } catch { /* 读不动就跳过这轮 */ }
  };
  tick(); // 立即首采
  const timer = setInterval(tick, 10 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function bridgeEngine() {
  try {
    const [{ listSessions }, { Journal }, { listQuotas }, { createMessaging }, { QuotaHistory }, { tokenUsage }, { providerQuotas }, { quotaHistory: providerQuotaHistory }, { sessionDetail }, { detectAgents }] = await Promise.all([
      import("./sessions.mjs"),
      import("./journal.mjs"),
      import("./usage/index.mjs"),
      import("./messaging.mjs"),
      import("./usage/history.mjs"),
      import("./usage/tokens.mjs"),
      import("./usage/provider-quotas.mjs"),
      import("./usage/quota-history.mjs"),
      import("./session-detail.mjs"),
      import("./agents.mjs"),
    ]);
    return {
      listSessions,
      journal: () => new Journal(),
      listQuotas,
      quotaHistory: () => new QuotaHistory(),
      tokenUsage: (period) => tokenUsage(period),
      providerQuotas: () => providerQuotas(),
      agents: () => detectAgents(),
      providerQuotaHistory: (sinceMs) => providerQuotaHistory(sinceMs),
      sessionDetail: (id, hours, session) => sessionDetail(id, hours, session),
      // 面板发消息：human 旗标（messaging.send 的语义见彼处注释）。
      send: async (args) => {
        const messaging = createMessaging();
        const rows = (await listSessions()).sessions;
        return messaging.send(args, { allSessions: rows });
      },
      getMessage: (id) => createMessaging().get(id),
    };
  } catch {
    return null;
  }
}
