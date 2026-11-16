// 回复提醒的判定逻辑：纯函数，无 DOM、无全局状态，可单测。
//
// 为什么要抽出来：面板的轮询与 /api/state 的 60s 缓存叠加后，靠人眼在浏览器里
// 卡时间点验证极易误判（提醒卡片只活 15 秒）。判定逻辑一旦是纯函数，
// 边界（首轮基线、同一条只提醒一次、非终态不提醒）就都能用测试钉住，
// 页面里只剩下「渲染」这一件事。

export const TERMINAL = ["done", "replied", "refused", "expired"];

export const STATE_TEXT = {
  done: "已回答",
  replied: "用消息回复了",
  refused: "被拒",
  expired: "过期没送到",
};

/**
 * 额度越线告警：只报「这一轮刚刚跨过阈值」的窗口，不重复报。
 *
 * prev 是上一次的 {key: percent}，返回新的 prev 与新越线的窗口。
 * 回落（重置、降档）会把该窗口的记账清掉，下次再越线会重新报——
 * 这正是用户要的：每次烧到 90% 提醒一次，而不是每 30 秒提醒一次。
 *
 * @param {Record<string, number>} prev 上次各窗口的百分比
 * @param {Array<{key:string, provider:string, window:string, percent:number|null}>} windows
 * @param {number} threshold 默认 90
 * @param {{seed?: boolean}} [opts] seed: 只记账不报警。首次加载时用它——
 *   打开面板就弹 6 张「已到 100%」的卡是骚扰，不是提醒。
 */
export function quotaAlerts(prev, windows, threshold = 90, opts = {}) {
  const seed = !!opts.seed;
  const next = { ...prev };
  const fresh = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
    const key = w.key;
    const was = next[key];
    if (w.percent >= threshold) {
      if (!seed && (was == null || was < threshold)) fresh.push({ ...w, threshold });
      next[key] = w.percent;
    } else {
      // 未越线（含回落）：只记新值。回落后再越线会被重新判为「刚跨过」。
      next[key] = w.percent;
    }
  }
  return { prev: next, fresh };
}

/**
 * 这一轮该弹哪些提醒。
 * @param {Set<string>} seen 已经提醒过（或首轮已视为见过）的消息 id
 * @param {Array<object>} messages journal 消息，最新在前
 * @param {boolean} baselineDone 是否已经建立过基线（首轮为 false）
 * @returns {{seen: Set<string>, fresh: Array<object>, baselineDone: boolean}}
 *   fresh 按消息顺序给出本轮新到终态的消息；首轮恒为空——打开面板不轰炸历史。
 */
export function pendingReplies(seen, messages, baselineDone) {
  const list = Array.isArray(messages) ? messages : [];
  if (!baselineDone) {
    const next = new Set(seen);
    for (const m of list) if (m && TERMINAL.includes(m.state)) next.add(m.id);
    return { seen: next, fresh: [], baselineDone: true };
  }
  const next = new Set(seen);
  const fresh = [];
  for (const m of list) {
    if (!m || !TERMINAL.includes(m.state)) continue;
    if (next.has(m.id)) continue;
    next.add(m.id);
    fresh.push(m);
  }
  return { seen: next, fresh, baselineDone: true };
}
