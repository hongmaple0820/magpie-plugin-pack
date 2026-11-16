// 一个会话的详情：元信息、与它的消息线程、它的 token 时序。
//
// token 从令牌缓存的按文件聚合里取——每个转录文件就是一个会话，缓存条目
// 天然是「这个会话每小时用了多少」，不需要再解一遍 zstd。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSessions } from "./sessions.mjs";
import { Journal } from "./journal.mjs";
import { agentsRoot } from "./delivery/claude.mjs";

const HOUR = 3_600_000;

function tokensCachePath() {
  return process.env.MAGPIE_AGENTS_TOKEN_CACHE || join(agentsRoot(), "tokens-cache.json");
}

function readTokensCache() {
  try {
    const raw = JSON.parse(readFileSync(tokensCachePath(), "utf8"));
    return raw && raw.version === 1 && raw.files ? raw.files : {};
  } catch {
    return {};
  }
}

/**
 * 一个会话的全部上下文。
 *
 * sessionHint：调用方已经有的会话对象（页面服务的 /api/state 缓存里就有）。
 * 给了它就不再全量扫描——真实数据上扫一遍要 83 秒（155 个 DSH 转录、124MB
 * zstd），绝不能放在一次点击的路径上。
 *
 * @param {string} id list_sessions 给的 id
 * @param {number} hours token 时序看多久
 * @param {object} [sessionHint] 已缓存的会话对象
 * @returns {{session, messages, tokens}|null} 找不到会话为 null
 */
export async function sessionDetail(id, hours = 24, sessionHint = null) {
  const session = sessionHint ?? ((await listSessions()).sessions ?? []).find((s) => s.id === id);
  if (!session) return null;

  // 消息线程：发出去的 + 收到的，按时间正序
  const journal = new Journal();
  const messages = journal.messages
    .filter((m) => m.to?.sessionId === id || m.from?.sessionId === id)
    .sort((a, b) => a.sentAtMs - b.sentAtMs)
    .map((m) => ({
      id: m.id,
      direction: m.to?.sessionId === id ? "out" : "in",
      state: m.state,
      at: m.sentAtMs,
      peerTitle: m.to?.sessionId === id ? m.from?.title ?? m.from?.client : m.to?.title ?? m.to?.client,
      fingerprint: m.fingerprint ?? null,
    }));

  // token 时序：缓存里这个文件的小时桶，裁到窗口内
  let tokens = null;
  if (session.file) {
    const cache = readTokensCache();
    const entry = cache[session.file];
    if (entry?.hours) {
      const from = Date.now() - hours * HOUR;
      const buckets = Object.entries(entry.hours)
        .map(([k, v]) => ({ at: Number(k), in: v[0] ?? 0, out: v[1] ?? 0, cacheRead: v[2] ?? 0 }))
        .filter((b) => b.at >= from)
        .sort((a, b) => a.at - b.at);
      if (buckets.length) {
        tokens = {
          hours,
          buckets,
          totals: buckets.reduce(
            (acc, b) => ({ in: acc.in + b.in, out: acc.out + b.out, cacheRead: acc.cacheRead + b.cacheRead }),
            { in: 0, out: 0, cacheRead: 0 },
          ),
        };
      }
    }
  }

  return {
    session: { id: session.id, client: session.client, title: session.title, project: session.project, state: session.state, reachable: session.reachable, notice: session.notice ?? null },
    messages,
    tokens,
  };
}
