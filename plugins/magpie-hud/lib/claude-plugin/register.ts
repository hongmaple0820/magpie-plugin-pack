import type { Register } from 'claude-code'

// magpie-agents (鹊桥) 的 Claude Code 插件。lib/delivery/claude.mjs 的
// preparePlugin 会把 JSON 转义的绝对通道路径替换进 __MAGPIE_AGENTS_CHANNEL_JSON__。
// 协议照 Agent HUD 的 claude_plugin/register.ts（仅参考不修改）：
// 这是一个 hooks 模块：不用 Node 导入、不开新 Claude 进程、不走 CLI -p。
const CHANNEL = __MAGPIE_AGENTS_CHANNEL_JSON__
const POLL_MS = 1000
const CHECK_IN_EVERY = 5

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const { version } = await $.session.version()
    let checking = false
    let ticks = 0
    let last = ''
    $.clock.every(POLL_MS, () => {
      if (checking) return
      checking = true
      void (async () => {
        try {
          // /clear 和 resume 会在没有新 session.start 的情况下换身份。
          const id = await $.session.id()
          if (ticks++ % CHECK_IN_EVERY === 0 || id !== last) {
            last = id
            await $.fs.write(`${CHANNEL}/sessions/${id}.json`, JSON.stringify({ at: await $.clock.now(), version, channelVersion: 2 }))
          }
          const folder = `${CHANNEL}/prompts/${id}`
          if (!(await $.fs.exists(folder))) return
          const entries = (await $.fs.list(folder)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
          const pending: { path: string, cancel: string, prompt: Record<string, unknown> }[] = []
          for (const entry of entries) {
            const path = `${folder}/${entry.name}`
            const prompt = JSON.parse(await $.fs.read(path))
            if (typeof prompt.text !== 'string' || prompt.takenAt !== undefined || prompt.cancelledAt !== undefined || prompt.expiredAt !== undefined) continue
            pending.push({ path, cancel: path.slice(0, -5) + '.cancel', prompt })
          }
          pending.sort((a, b) => Number(a.prompt.at) - Number(b.prompt.at) || String(a.prompt.id).localeCompare(String(b.prompt.id)))
          for (const { path, cancel, prompt } of pending) {
            const now = await $.clock.now()
            if (await $.fs.exists(cancel)) {
              await $.fs.write(path, JSON.stringify({ cancelledAt: now }))
              continue
            }
            if (typeof prompt.expiresAt === 'number' && prompt.expiresAt <= now) {
              await $.fs.write(path, JSON.stringify({ expiredAt: now }))
              continue
            }
            const takenAt = now
            // 先认领再提交，重载也不会提交两次。taken 故意不算 started：
            // submit 要等会话空闲。
            await $.fs.write(path, JSON.stringify({ takenAt }))
            const became = async (what: Record<string, unknown>) => {
              try { await $.fs.write(path, JSON.stringify({ takenAt, ...what })) } catch {}
            }
            // 认领与撤回交叉时：提交还没开始就确认撤回；已经开始就如实拒绝承诺撤回。
            if (await $.fs.exists(cancel)) { await became({ cancelledAt: await $.clock.now() }); continue }
            const submitted = prompt.asUser === true
              ? $.prompt.submit({ text: String(prompt.text), asUser: true })
              : $.prompt.submit({ text: String(prompt.text) })
            // 绝不 await 等空闲的 prompt：签到必须保持存活。
            void submitted.then(async result => {
              const dropped = (result as { drop?: unknown }).drop
              await became(dropped === undefined ? { startedAt: await $.clock.now() } : { refused: String(dropped) })
            }, error => became({ refused: String(error) }))
          }
        } catch {
          // 一次失败等下一个时钟重试；签到过期会隐藏可达性。
        } finally { checking = false }
      })()
    })
    return started
  })
  on('session.end', async ($, e, next) => {
    try { await $.fs.write(`${CHANNEL}/sessions/${e.sessionId}.json`, JSON.stringify({ ended: await $.clock.now() })) } catch {}
    return next(e)
  })
}
