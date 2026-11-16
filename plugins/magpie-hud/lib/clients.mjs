// 客户端描述符（v7 §5 P1）：每个客户端「状态从哪来、能不能被证伪、有没有在线证据」
// 只在这里声明一次。扫描器仍各自实现（各家目录布局差异太大），但契约与界面档位从这里读。
//
// stateSource：
//   events   —— 有事件流（transcript / tap），结论能被下一条事件证伪 → verified:true
//   registry —— 只有签到（Claude Code 插件每 5s 写一次 sessions/<id>.json）：
//               证明插件进程活着，不证明在跑还是在等人 → verified:false
//   mtime    —— 只有文件写入时间：证明「最近写过」，别的都证明不了 → verified:false
//   none     —— 什么都没有（客户端目录都不存在时）
//
// badge 是界面右侧的档位（v7 §5 P1 要求三档）：
//   evidence —— 「证据」：phase 由事件决定，可被证伪
//   online   —— 「在线」：只有签到能证明 presence，phase 仍是未知
//   approx   —— 「近似」：只有 mtime，连 presence 都判不了
export const CLIENTS = Object.freeze({
  dsh: { id: "dsh", name: "DSH", stateSource: "events", verified: true, presenceSource: null, badge: "evidence" },
  claude: { id: "claude", name: "Claude Code", stateSource: "registry", verified: false, presenceSource: "registry", badge: "online" },
  codex: { id: "codex", name: "Codex", stateSource: "mtime", verified: false, presenceSource: null, badge: "approx" },
  antigravity: { id: "antigravity", name: "Antigravity", stateSource: "mtime", verified: false, presenceSource: null, badge: "approx" },
});

// 签到的有效期：插件每 5s 写一次，20s 没新写就认为进程没了（agent-hud 同口径）。
export const PRESENCE_FRESH_MS = 20_000;

export function clientOf(id) {
  return CLIENTS[id] ?? null;
}

/**
 * 签到 → presence。只回答「进程在不在」，不回答「在跑还是在等人」。
 * @param {string|null} checkedAt 最近一次签到的时刻（ms），没签过传 null
 * @returns {{presence: "online"|"offline"|null, reason: string}}
 */
export function presenceOf(clientId, checkedAt, now = Date.now(), freshMs = PRESENCE_FRESH_MS) {
  const c = clientOf(clientId);
  if (!c?.presenceSource) return { presence: null, reason: "这个客户端没有签到或投递通道，判断不了在线状态。" };
  if (checkedAt == null) return { presence: "offline", reason: "还没收到过签到。" };
  const fresh = now - checkedAt < freshMs;
  return {
    presence: fresh ? "online" : "offline",
    reason: fresh ? "签到是新的：插件进程活着。" : `最近一次签到在 ${Math.round((now - checkedAt) / 1000)} 秒前，已过期。`,
  };
}
