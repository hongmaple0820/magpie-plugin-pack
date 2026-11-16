# 会话真值模型（HUD v6 规范）

日期：2026-11-15
地位：本文件是 v6 的**验收基准**。任何显示字段，如果在本文件里找不到证据定义，就不许出现在界面上。

---

## 1. 观测对象与原始材料

HUD 观察的是「本机上正在跑的 agent 会话」。真值的唯一来源是 DSH 落盘的 v4 转录：

```
<DSH_HOME>/sessions/<项目目录>/<会话id>/session.v4.jsonl[.zstd]
```

实测（本机，2026-11-15，见 `tools/corpus/extract.mjs` 产出）：

- 197 份转录，压缩后 281.7MB，解压后 1220.6MB 文本；
- 413,411 个事件，**0 坏行、0 seq 缺口**（seq 连续是可信的完整性信号）；
- 134,349 个 zstd 帧，197/197 文件是多帧——帧追加写，可增量解码；
- 事件行形状：`{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`。

转录是事件流的落盘投影；进程内 tap 是同一事件流的更早观察点（见 `dsh/magpie-hud.mjs`）。
**两者冲突时以 tap 为准，但必须记录冲突，不允许静默取一个。**

---

## 2. 事件词汇表（只使用这里列出的语义）

| 事件 | 语义 | 关键字段 |
|---|---|---|
| `session` | 会话头 | `id, cwd, createdAt, delegationDepth, agentPreset, parentSession` |
| `turn/start` / `turn/end` | 一轮对话开始/结束 | `turn`；end 带 `reason.kind` |
| `step/start` / `step/end` | 一步（一次模型调用）开始/结束 | `turn, step` |
| `tool/call` | 工具调用发起 | `turn, step, callId, name, arguments` |
| `tool/result` | 工具结果 | `turn, step, toolCallId, message.isError, sourceEventSeqs` |
| `approval/asked` | 权限升级在等用户拍板 | `id, toolName, callId, reason` |
| `approval/decided` | 已拍板 | `id, outcome` |
| `user/message` | 用户消息（`source.kind==="user"` 为真人；其余为系统注入） | `content, source` |
| `agent/inbox/spliced` | 排队消息被插入下一轮 | `target, inserted[]` |
| `job/registered` / `job/settled` | 后台任务开始/结束 | `jobId, owner, kind, status, cause, finishedAt` |
| `session-log-deepseek/delivery-accepted` | 转录送达确认 | `sessionId, throughSeq, sessionFormatVersion` |
| `compaction/start` / `compaction/summary` / `compaction/end` / `compaction/prune` | 上下文压缩（历史被重写） | `compactionId, turn, summary` |
| `session/title` | 标题 | `title` |

`surfaceOp` 与 `sourceEventSeqs` 表示「这条事件是派生的/替代了哪些事件」。**凡有 `sourceEventSeqs`
的事件都不是新事实，是对既有事实的引用**，折叠时必须按 §4 处理。

---

## 3. 状态定义（可判定的）

对每个会话，fold 出以下正交字段：

```
phase     : starting | working | waiting | paused | unknown     // 见下；ended 在 v4 转录里没有显式事件，暂不产出
activity  : {tool, turn, step} | null         // 最近一个未闭合 tool/call
waiting   : {kind: approval|question, askId, toolName, since, seq} | null
receipts  : Receipt[]                          // 见 §6
asOf      : {source: tap|transcript|none, lastSeq, observedAt, lagMs, stale}
unknown   : {reason, sinceSeq} | null
```

判定规则（全部只看事件，不看 mtime、不看文本正则）：

1. `starting`：见过 `session`，未见其它事件。
2. `working`：满足任一
   - 存在 `turn/start` 无对应 `turn/end`；
   - 存在 `job/registered` 无对应 `job/settled`（同一 `jobId`）；
   - 最后一个 `step/start` 无对应 `step/end`（同一 turn+step）；
   - 上一条事件是人说的话（`user/message` 或 `agent/inbox/spliced` 里的 user 片段）而 `turn/start` 还没出现
     ——「刚说完、正在起跑」不是空闲。
3. `waiting`：满足任一（优先于 `working`，因为等待是用户需要采取行动的阻塞态）
   - 存在 `approval/asked` 且没有同 `id` 的 `approval/decided`，且该审批对应的 tool/result 未出现
     （用户打断 turn 时会出现 `interrupted-tool-result` + `turn/end(reason=interrupted)`，此时审批已不可能被回答，必须关闭）；
   - 提问卡（`tool/call` 名字匹配 `ask_user|exit_plan_mode`）的 `tool/result` 已出现且**结果不是错误**、
     且结果里**没有直接带回 `{"answers":[…]}`**，且之后没有真人消息。
     两种真实形状都要认：`{"answers":[…]}`（落盘即答完，不等）与
     「The card is on screen; the user's answer arrives as their next message.」（从这一刻开始等）。
4. `paused`：无未闭合 turn/step/job，且无等待，且存在至少一个 `turn/end`。
5. `unknown`：证据不足——tap 与转录都不可用、seq 缺口、解码失败、权限拒绝、schema 漂移。
   **unknown 的优先级高于以上所有**：没有任何证据时不许猜。

**硬规则**：每次 `phase` 变化必须携带「触发事件 seq + 规则名」。测试断言：没有触发事件的
变化即失败。这条规则把「猜」从实现里彻底排除。

### 3.1 时间语义

- 所有 `since`/`observedAt` 用事件里的 `time`（毫秒），不用本地墙钟；`lagMs = now - lastEventTime`
  只用于展示陈旧度。
- 显示「已等 3 分 12 秒」用 `now - waiting.since`，其中 `now` 由注入的时钟提供（测试可控）。

---

## 4. compaction / surfaceOp

- `surfaceOp === "append"` 或缺省：正常折叠。
- `surfaceOp === {op:"replace", startSeq, endSeq}`：DSH v4 里 compaction 派生的「替代可见性」事件
  （本机实测只有这两种取值）。事件本身仍承载新语义：记入 `replaced[]` 并继续正常折叠，不降级。
- 带 `sourceEventSeqs` 的派生事件：不产生新状态，只更新被引用事件的可见性。fold 维护两份视图：
  - `history`：所有事件（用于计算 token/统计/等待历史）；
  - `live`：按 surfaceOp 折叠后的当前可见视图（用于显示「现在在干什么」）。
- 未知 `surfaceOp`：该事件标 `unknown`，`phase` 降级为 `unknown`，并记
  `unknown.reason = "surface-op:" + JSON.stringify(值)`，不得猜测；unknown 粘滞到显式重建。

实现约束：`live` 视图只需要尾部窗口（见 §5），`history` 视图的统计走增量累计，不重扫全文件。

---

## 5. 读取策略（帧级，不整份解压）

- 冷启动：`readWindow(file, {maxBytes: 128KB})`——从文件尾回扫 zstd 帧，从末帧往前逐帧解码，
  遇到 `approval/asked` / `"ask_user"` / `"exit_plan_mode"` 的帧再多回看 3 帧；按
  「解码成功 + 每行合法 JSON + seq 严格 +1」三条验证帧边界。
- 热更新：`readAppend(file, offset, {expectedSeq})`，`offset` 是上次读到的文件原始字节长度（EOF 帧边界）；
  解新增帧，校验首事件 `seq === lastSeq+1`。**解出 0 个事件（半帧）时不前进 offset 并清空行残留**：
  半个帧不是一行，重读整帧。
- 帧边界不可信 / seq 对不上：不修补、不猜，返回 `unknown(reason)`，下轮整段重读。
- 整份解码只允许出现在工具与测试里（`readAll`），HUD 热路径禁止。
- 每次结论都带 `evidence: {mode:"events", bytes:{offset,size,truncated}, mtimeMs, rule, seq}`。

预算（本机实测，197 文件 / 281.7MB 压缩 / 1220.6MB 文本）：
- 冷读窗口 128KB：p50 47.4ms、p95 113.1ms、max 155ms/文件；197 文件合计 ~9.3s → 预算 total ≤ 20s；
- 热 append（25 次合成帧）：p50 0.099ms、p95 0.133ms；
- 稳态 CPU ≤ 1.5% 单核；常驻内存 ≤ 250MB。
- 说明：纯 JS fzstd 吞吐 ~1.4–6MB/s，1MB 窗口实测 p95 1012ms —— 「30ms/文件」在 1MB 窗口上不可达，
  所以窗口定为 128KB，并把「等你」的判定锚定在 marker 帧（回看），不依赖整段历史。

---

## 6. 回执状态机（替代 `startedAt` 乐观语义）

一次「从 HUD 发出的回答」的生命周期：

```
queued ──写文件成功──> accepted ──delivery-accepted.throughSeq ≥ 我们的 seq──> delivered
                          │                                                     │
                          │ 30s 内无 delivered                                  │ 出现预期效果事件
                          └──────────────> timeout                              └──> effective
                                                                                ↘ failed（明确拒绝/错误）
```

- `accepted`：DSH 侧插件读到答复文件（现有 `asks.log.jsonl` 只能证明这一步）。
- `delivered`：转录里出现 `session-log-deepseek/delivery-accepted`，且其 `throughSeq` 覆盖答复。
- `effective`：审批 → `approval/decided` 且 `outcome` 与答复一致；提问 → 该提问之后出现新的
  `user/message`。
- 每一跳写一条证据：`{askId, hop, at, evidence:{seq|throughSeq|event}}`。
- **`accepted` 不得渲染为完成态**；`timeout` 必须可见（「已入队，未见生效」）。

**v6 实现修订（2026-11-15）**：`delivered` 的判据改为「tap/转录里出现了文本匹配的
`user/message` 或 `agent/inbox/spliced`」，`effective` 的判据改为「`deliveredSeq` 之后出现
`assistant/message`」——`delivery-accepted.throughSeq` 在真实语料里只能说明会话收到序号，
不能说明我们那句话出现；超时默认 60s（`deliverTimeoutMs` 可配）。字段写在 prompt JSON 的
`state` 上：`accepted` / `delivered` / `effective` / `timeout` / `failed`；旧文件里的
`startedAt` 只翻译成 `accepted`，不升级。

---

## 7. 未知与陈旧

| 条件 | 展示 |
|---|---|
| tap 正常，`lagMs ≤ 3000` | 正常态，来源徽标 `tap` |
| tap 掉线 > 3s，转录可用 | 正常态 + `stale`，来源徽标 `transcript` |
| 转录 `lagMs > 8000` | `stale` 标黄 |
| `lagMs > 30000` 或读取失败/seq 缺口/未知 surfaceOp | `unknown` + 原因，**不得显示 running/idle** |
| 额度字段缺失/漂移 | `unknown` + `schema-drift`，不得用 0 或旧值顶替 |

---

## 8. 真值语料（本次实测）

`tools/corpus/extract.mjs` 从 197 份真实转录抽出：

- 等待 episode 77 条：审批 76（pwsh 58、run_code 13、plugin_manager 3、write 1、ops_bash 1），
  提问 1（`ask_user`，到 EOF 仍开着）；另有 1 条 `exit_plan_mode` 因结果里直接带回
  `{"answers":[…]}`（落盘即答完）不计入等待区间；
- 时长分位：p50 91.8s、p90 26min、p95 94min、p99 17.8h——**现有 10 分钟 `ASK_TTL` 与真实分布不符**；
- 每条 episode 带 `{since, until, askedSeq, closedSeq, closeEvent, file}`，可回原始字节复核。
- 场景语料：`tools/corpus/scenarios.mjs` 确定性生成 40 会话 × 3 episode = 120 条，带明文与
  `frames.json`（每帧字节区间），用于「按帧截断后仍能判 waiting」的读取层测试。

评测结果（`tools/eval/waiting.mjs` → `corpus/eval-waiting.json`，2026-11-15）：

| 层 | precision | recall | tp | fp | fn |
|---|---|---|---|---|---|
| 语义层（episode 检查点） | 1.0 | 1.0 | 258 | 0 | 0 |
| holdout（sessionId %5===0） | 1.0 | 1.0 | 51 | 0 | 0 |
| 时间点层（分层采样） | 1.0 | 1.0 | 591 | 0 | 0 |

- `sinceErrorMs`：p50 0、max 0（258 样本）；
- 读取层：120/120 场景「截断到 asked/result 帧末 + 128KB 窗口」仍判 waiting，fail 0。

**诚实边界**：标签与 reducer 出自同一套事件语义（`extract.mjs` 与 `fold.mjs` 是两套独立实现，
但共享同一份规范），因此这些数字证明的是「实现与规范一致 + 两套实现对同一语料无分歧」，
**不是「语义已被证明正确」**。语义的独立校验需要 P3 的 tap 事件副本、DSH 自身 UI/API 与
`delivery-accepted.throughSeq` 作为第三、第四方证据。

---

## 9. 现有代码的映射（v6 要替换的东西）

| 现状 | 位置 | v6 替换 |
|---|---|---|
| `stateOf(mtime)` 时间近似 | `lib/sessions.mjs:151-153` | fold 的 `phase` |
| `ASK_RE` 文本启发式 | `lib/sessions.mjs:395` | §3 规则 3 |
| 真实日志里 `pendingOf` 取 `data.id`，而事件用的是 `callId` → 恒为 null | `lib/sessions.mjs:407-411` | 事件语义配对 |
| 整份解压 | `lib/sessions.mjs:381-390` | `lib/truth/frames.mjs` |
| `accepted === false` 才算失败 | `dsh/magpie-hud.mjs:374-378` | §6 回执状态机 |
| 额度过期字段漂移无告警 | `lib/usage/provider-quotas.mjs` | `unknown(schema-drift)` |

---

## 10. 不变量（测试必须覆盖）

1. **前缀单调**：对同一事件序列，任意前缀的 phase 只能走向终态，不因后续事件回退成矛盾态
   （除显式 `approval/asked` 重开）。
2. **重放幂等**：`fold(events) === fold(fold(events))`。
3. **截断容忍**：半帧/半行不产生事件，不产生 `unknown` 以外的状态；`carry` 拼接后与完整流一致。
4. **seq 缺口必 unknown**：人为制造缺口，phase 必须为 `unknown`。
5. **证据完整**：每个状态变化都有 `{rule, seq}`。
6. **未知不可伪装**：任何 `unknown` 渲染路径不得输出 `running`/`idle`。
7. **tap/转录一致**：同一事件集经两条路径折叠，状态逐字段相等；若同 seq 结论不同，仲裁必须
   给出 `unknown(tap-mismatch)`，不得二选一地猜（`lib/truth/collect.mjs` 的 `arbitrate`）。
8. **回执不得乐观**：`accepted` 绝不渲染成 delivered；没有「事件里真的出现」的证据就只能停在
   `accepted` 或 `timeout`。

---

## 11. tap（进程内第二证据源）

- 写入：`dsh/magpie-hud.mjs` 订阅 `ctx.on("session/event", (session, event) => …)`，把每个
  committed event 投影成小行（≤1KB，正文截 800 字）追加到 `channel/tap/<sessionId>.jsonl`；
  单文件 8MB 滚动成 `.1`，id 只收 `[A-Za-z0-9_-]{1,128}`。
- 读取：`lib/truth/tap.mjs` 的 `readTapFrom(file, offset)` 只读新增字节；半行不消费、不前进。
- 仲裁（`lib/truth/collect.mjs`）：
  - tap 的 `lastSeq` 更大 → 用 tap 的结论（转录还没 flush 时 tap 才是真相）；
  - 两边同 seq 且 phase/waiting 一致 → `evidence.mode="both"`；
  - 同 seq 不一致 → `unknown(tap-mismatch)`，两个结论都写进 `evidence.cross`；
  - tap 更旧 → 信转录，`cross.stale=true` 标出 tap 落后到哪。
- 意义：这是第一次让「显示」与「另一份独立落盘」互相对质；同时把「插件在不在跑」变成可观测事实。
- 实测（2026-11-15）：用 `dsh --profile headless --patch <overlay>` 真跑了一个宿主进程（overlay 里
  `config.channel` 必须是绝对路径，否则插件静默不启动），插件直写 `~/.magpie-hud/tap/`；
  `tools/oracle/live-parity.mjs` 把 tap 行与「转录重投影」逐行对照：1 会话 / 18 行、mismatch 0。
- 该次模型鉴权失败（INVALID_TOKEN），事件族只到会话头/输入/回合，**没有审批与提问类的 live 事件**；
  live 证据因此偏窄。另注意：比对用的 `tapProject` 与写入用的是同一实现，证明的是「跨进程跨落盘一致」，
  不是「两个独立实现互证」。
