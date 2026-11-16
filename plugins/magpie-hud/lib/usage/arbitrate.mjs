// 额度窗口仲裁（v7 §4.2）：同一窗口可能有多条来源，界面只能显示一条。
//
// 来源分两类：
//   - 本地直连（cli / statusline / logs）：面板自己去问客户端或读本地状态行，
//     读数时刻就是查询时刻，最新；
//   - 聚合台账（magpie）：magpie 后台采集落的盘，带它自己的 readAt，可能已经过期。
//
// 规则（照 usage-float 的 effectiveClaudeWindows，用鹊楼的形状表达）：
//   1. 同 provider + 同窗口 → 取 observedAt 最大的一条；
//   2. observedAt 相同时，本地直连优先于聚合台账（同一条读数里，直连没经过中转）；
//   3. 所有候选都没有百分比 → quality:"unknown"，percent 留 null，不落 0；
//   4. 来源结构不符 → 整个来源标 schema-drift，不影响其他来源的候选。
//
// 窗口身份靠 windowKey() 归一：认不出来的标签各自独立，不合并——
// 宁可在界面上多一行，也不把两个不同窗口平均成一个错的数。

const PRIORITY = { cli: 3, statusline: 3, logs: 2, magpie: 1 };

/**
 * 窗口身份：把各源对同一窗口的不同叫法归到同一个 key。
 * "Current session" / "5h" → 5h；"Weekly limit · All models" / "7d" → 7d；
 * "Weekly limit · Opus" → 7d:opus。认不出来的原样带上 `label:` 前缀——不合并。
 * @param {string|null|undefined} label
 * @returns {string}
 */
export function windowKey(label) {
  const t = String(label ?? "").trim().toLowerCase().replace(/\s*·\s*/g, " · ").replace(/\s+/g, " ");
  if (!t) return "label:";
  if (/^(current )?session$/.test(t) || /^5 ?h(ours?)?$/.test(t)) return "5h";
  if (t === "weekly limit" || t === "weekly limit · all models" || t === "weekly" || /^7 ?d(ays?)?$/.test(t)) return "7d";
  const family = t.match(/^(?:weekly limit · |7d )?(opus|sonnet|haiku|fable|mythos)$/);
  if (family) return "7d:" + family[1];
  return "label:" + t;
}

// 百分比从哪来：客户端直接给的百分比是 exact，自己用 amount/limit 算出的是 derived。
// 这个区别是给人看的——derived 的比例在两边的取整或刷新时刻不同时会漂。
function candidate({ provider, account = null, label, percent, percentBasis, used = null, limit = null, unit = null, resetsAt = null, source, observedAt }) {
  return {
    provider: String(provider ?? "unknown"),
    account: account == null ? null : String(account),
    key: windowKey(label),
    label: label ?? null,
    percent: typeof percent === "number" && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    percentBasis: percentBasis ?? null,
    used,
    limit,
    unit,
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
    source,
    observedAt: Number.isFinite(observedAt) ? Math.round(observedAt) : null,
  };
}

/**
 * 本地直连来源的候选（engine.listQuotas() 的 clients[]）。
 * observedAt 用本次查询时刻：直连读数的时刻就是拿到它的时刻，行里没有更细的时间。
 * @param {Array} clients listQuotas() 的 clients
 * @param {number} at 本次查询时刻（ms）
 * @returns {{candidates: Array, drift: string|null}}
 */
export function cliCandidates(clients, at) {
  if (!Array.isArray(clients)) return { candidates: [], drift: "clients-not-array" };
  const out = [];
  let drift = null;
  for (const c of clients) {
    // 一个客户端返回的形状不对，只跳过它：同源的其它客户端照常给数（§4.2 规则 4）。
    if (!c || typeof c !== "object") { drift ??= "client-not-object"; continue; }
    const rows = c.quotas;
    if (rows !== undefined && !Array.isArray(rows)) { drift ??= "quotas-not-array"; continue; }
    for (const q of rows ?? []) {
      if (!q || typeof q !== "object") { drift ??= "window-not-object"; continue; }
      out.push(
        candidate({
          provider: c.client ?? "unknown",
          account: c.account?.label ?? null,
          label: q.name ?? q.shortLabel ?? null,
          percent: q.usedPercent,
          percentBasis: typeof q.usedPercent === "number" ? "explicit" : null,
          resetsAt: q.resetAt ?? null,
          source: "cli",
          observedAt: at,
        }),
      );
    }
  }
  return { candidates: out, drift };
}

/**
 * 聚合台账的候选（providerQuotas().providers[]）。
 * 每个 provider 的 observedAt 用它自己的 readAt：台账可能十分钟前采的，
 * 拿「现在」当观测时刻会把过期读数装成最新的。
 * @param {Array} providers providerQuotas() 的 providers
 * @returns {{candidates: Array, drift: string|null}}
 */
export function ledgerCandidates(providers) {
  if (providers == null) return { candidates: [], drift: "providers-missing" };
  if (!Array.isArray(providers)) return { candidates: [], drift: "providers-not-array" };
  const out = [];
  let drift = null;
  for (const p of providers) {
    if (!p || typeof p !== "object") { drift ??= "provider-not-object"; continue; }
    // 台账里某个账号的结构不对（比如 windows 变成了对象），只跳它一个；
    // 其它账号的窗口照给——否则一个厂商改结构会把全部额度打成「读不出来」。
    if (p.drift) { drift ??= "provider:" + p.drift; continue; }
    const at = p.readAt ? Date.parse(p.readAt) : NaN;
    for (const w of Array.isArray(p.windows) ? p.windows : []) {
      out.push(
        candidate({
          provider: p.provider ?? p.id ?? "unknown",
          account: p.user ?? null,
          label: w.display && !w.name ? w.display : w.name,
          percent: w.percent,
          percentBasis: w.amount != null && w.limit != null ? "ratio" : null,
          used: w.amount ?? null,
          limit: w.limit ?? null,
          unit: w.unit ?? null,
          resetsAt: w.resetsAt ?? null,
          source: "magpie",
          observedAt: Number.isFinite(at) ? at : null,
        }),
      );
    }
  }
  return { candidates: out, drift };
}

export function groupKey(provider, account, label) {
  return [provider ?? "unknown", account ?? "", windowKey(label)].join("|");
}

function rank(a, b) {
  // observedAt 大的先；没时间的排最后（未知时刻不能冒充「最新」）。
  const at = a.observedAt ?? -Infinity;
  const bt = b.observedAt ?? -Infinity;
  if (at !== bt) return bt - at;
  const pr = (PRIORITY[a.source] ?? 0) - (PRIORITY[b.source] ?? 0);
  if (pr !== 0) return -pr;
  // 同源同刻：有百分比的先，免得空的把有数的挤掉。
  return (b.percent == null ? 1 : 0) - (a.percent == null ? 1 : 0);
}

function qualityOf(winner) {
  if (winner.percent == null) return "unknown";
  return winner.percentBasis === "explicit" ? "exact" : "derived";
}

/**
 * 仲裁一组候选，输出 §4.2 的窗口契约（不含 sources 诊断，那由 sourceReport 给）。
 * @param {Array} candidates candidate() 形状
 * @returns {{windows: Array, conflicts: number}}
 */
export function arbitrateWindows(candidates) {
  // 先按 provider + 窗口分组，再按账号分成簇：
  // 两个具名账号必须是两个窗口（同一家的两个账号各有自己的 5h 窗）；
  // 没有账号的候选（CLI 读出来的行没有邮箱）向「唯一具名账号」靠——
  // 直连与台账描述的是同一个窗口，不该因为一边缺账号名就出两行。
  const byWindow = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const key = groupKey(c.provider, null, c.label);
    const g = byWindow.get(key);
    if (g) g.push(c);
    else byWindow.set(key, [c]);
  }
  const groups = new Map();
  for (const [key, bucket] of byWindow) {
    const named = new Set(bucket.map((c) => c.account).filter(Boolean));
    for (const c of bucket) {
      const account = c.account ?? (named.size === 1 ? [...named][0] : null);
      const k = [c.provider || "unknown", account ?? "", c.key].join("|");
      const g = groups.get(k);
      if (g) g.push({ ...c, account });
      else groups.set(k, [{ ...c, account }]);
    }
  }
  const windows = [];
  let conflicts = 0;
  for (const [key, group] of groups) {
    group.sort(rank);
    const [winner, ...rest] = group;
    if (rest.length) conflicts++;
    windows.push({
      key,
      provider: winner.provider,
      account: winner.account,
      label: winner.label ?? winner.key,
      percent: winner.percent,
      used: winner.used,
      limit: winner.limit,
      unit: winner.unit,
      resetsAt: winner.resetsAt,
      source: winner.source,
      observedAt: winner.observedAt,
      cross: rest.map((c) => ({ source: c.source, observedAt: c.observedAt, percent: c.percent })),
      // 两个来源给出的比例差 ≥1 个点才算不一致：取整与刷新时刻的差异不该报警。
      crossMismatch: rest.some((c) => c.percent != null && winner.percent != null && Math.abs(c.percent - winner.percent) >= 1),
      quality: qualityOf(winner),
    });
  }
  // 排法：有百分比的先（百分比降序，最紧的在最上面），没有数的垫底。
  windows.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || a.key.localeCompare(b.key));
  return { windows, conflicts };
}

/**
 * 每个来源这次拿到了什么、有没有结构问题——面板和工具都要能回答
 * 「额度去哪了」，而不是安静地变空。
 * @param {Record<string, {candidates: Array, drift: string|null}>} entries 形如 {cli, magpie}
 * @returns {Array<{source: string, windows: number, drift: string|null, observedAt: number|null}>}
 */
export function sourceReport(entries) {
  const out = [];
  for (const [source, value] of Object.entries(entries ?? {})) {
    const candidates = value?.candidates ?? [];
    const times = candidates.map((c) => c.observedAt).filter((t) => Number.isFinite(t));
    out.push({
      source,
      windows: candidates.length,
      drift: value?.drift ?? null,
      observedAt: times.length ? Math.max(...times) : null,
    });
  }
  return out;
}

/**
 * 把仲裁结果挂回 provider 的窗口对象（面板用，省得前端再归一一次窗口名）。
 * 精确匹配「provider + 账号 + 窗口」；账号对不上时，只有当该 provider 的这个窗口
 * 恰好只有一条仲裁结果才挂——多账号时宁可不挂，也不把 A 账号的结论贴到 B 账号上。
 * @param {Array} providers providerQuotas() 的 providers
 * @param {Array} windows arbitrateWindows() 的 windows
 * @returns {Array} 新的 providers（不修改入参）
 */
export function annotateProviders(providers, windows) {
  const exact = new Map((windows ?? []).map((w) => [w.key, w]));
  const loose = new Map();
  for (const w of windows ?? []) {
    const k = [w.provider, windowKey(w.label)].join("|");
    if (!loose.has(k)) loose.set(k, []);
    loose.get(k).push(w);
  }
  return (Array.isArray(providers) ? providers : []).map((p) => ({
    ...p,
    windows: (p.windows ?? []).map((w) => {
      const hit = exact.get(groupKey(p.provider ?? p.id, p.user, w.name)) ?? (() => {
        const list = loose.get([p.provider ?? p.id, windowKey(w.name)].join("|")) ?? [];
        return list.length === 1 ? list[0] : null;
      })();
      if (!hit) return w;
      // 数值也用胜者的：标签说「2 源」时，屏幕上那个数必须是仲裁选中的那条，
      // 否则面板会印着台账的旧值、旁边写着「不一致」，等于没仲裁。
      return {
        ...w,
        percent: hit.percent,
        used: hit.used,
        limit: hit.limit,
        unit: hit.unit ?? w.unit,
        resetsAt: hit.resetsAt ?? w.resetsAt,
        arb: { source: hit.source, quality: hit.quality, cross: hit.cross.length, mismatch: hit.crossMismatch, observedAt: hit.observedAt },
      };
    }),
  }));
}

/**
 * 一次到位：两个来源的原始输出 → 仲裁结果 + 来源诊断。
 * pageservice 用它组装 /api/quotas，避免各处重复拼装顺序。
 * @param {{clients?: Array, providers?: Array, at: number}} input
 */
export function arbitrateQuotas({ clients, providers, at }) {
  const cli = cliCandidates(clients, at);
  const ledger = ledgerCandidates(providers);
  const { windows, conflicts } = arbitrateWindows([...cli.candidates, ...ledger.candidates]);
  return { windows, conflicts, sources: sourceReport({ cli, magpie: ledger }) };
}
