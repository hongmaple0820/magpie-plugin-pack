# 鹊楼 HUD 深度版方案（v6）：从「看起来对」到「可证伪」

日期：2026-11-15
状态：待确认（确认后按 §5 执行）
相对 v5：v5 解决了「能答」（通道把审批/提问接进面板）；v6 只解决「答得对不对、显示得真不真」，**不加任何新客户端、新面板、新形状**。

---

## 0. 先把「深」定义成可验收的东西

同一个任务可以做成「更大」：更多客户端、更多面板、更多动画、更多设置项。本机实测只剩 DSH 一个客户端在产日志（`~/.claude/projects`、`~/.codex/sessions` 不存在），继续铺客户端只是空转。

本方案把「深」定义为三条判据，任何一条不达标就不算完成：

1. **每个显示字段可追到证据**：`running`/`waiting`/`idle`、额度百分比、token 数、投递回执，都必须能指回「哪份文件的哪一帧、哪个事件 seq」，而不是「文件 5 分钟前被改过」。
2. **未知敢说未知**：数据缺口、tap 掉线、字段漂移时，界面显示 `unknown` + 来源 + 陈旧度，绝不静默降级成 `idle`/`running`，也绝不编造金额。
3. **度量可复现**：等待判定的 precision/recall、刷新延迟 p95、CPU 预算、变异分数，由一条命令产出报告；第三方不读我们的代码也能复跑并得到同样的数。

---

## 1. 你问的四件事

### 1.1 顶级专家会做、但你没要求的事（每一件都直接对应现有代码里的缺陷）

| # | 专家会做 | 为什么（不做的后果） |
|---|---|---|
| 1 | **先写「会话真值规范」再写 UI**：状态集合、每个状态的证据要求、as-of 语义、unknown 规则 | 现在是 UI 先行，`lib/sessions.mjs:151` 用 `mtime` 近似状态，规范缺失导致「长工具调用显示 idle、废弃会话显示 running」无法被判定为 bug |
| 2 | **在进程内做事件 tap，而不是只读转录** | 转录是「已落盘的事实」，有写缓冲、zstd 分帧、compaction 重写；进程内事件流才是传感器源头。v5 的 `dsh/magpie-hud.mjs` 已经能装进 DSH 进程，但只用来抢审批，没用来做观测 |
| 3 | **给「等待」建带标注的地面真值语料，用 P/R 验收** | 现在 `lib/sessions.mjs:395` 的 `ASK_RE = /ask_user\|exit_plan_mode\|request_approval/` 是文本启发式，全仓库没有一条 precision/recall 数据；用户看到的「等你」可能是假的，漏掉的等待无人知道 |
| 4 | **差分测试：同一段历史走两条独立实现，必须一致** | 只有示例单测时，`stateOf` 的近似永远测不出来。专家会拿「tap 折叠结果」对「转录重放结果」对「DSH 自己的物化状态」，三方不一致就是缺陷 |
| 5 | **属性测试 + 变异测试** | 96 个示例测试覆盖的是作者想到的路径；属性测试（前缀单调、重放幂等、截断容忍、乱序容忍）和变异分数才能说明「测试真的会失败」。当前变异分数未知，约等于 0 证据 |
| 6 | **故障注入与降级矩阵** | tap 被卸载、channel 目录被删、最后一帧半写、时钟回拨、197 文件突发、权限拒绝——每一条都要有预期行为和断言。现在的代码路径里这些多半是「静默返回空壳」 |
| 7 | **在真实规模上做资源预算**（197 文件 / 279.7MB） | `lib/sessions.mjs:39-45` 自己记着「171 份共 179MB，全量解压 65–99 秒」。专家会把「只解增量帧」做成硬指标并压测，而不是加个 size+mtime 缓存绕过去 |
| 8 | **把「回答生效」做成回执状态机**，而不是布尔 | `dsh/magpie-hud.mjs:374-378` 只要 `accepted !== false` 就写 `startedAt`——「入队成功」被当成「已生效」。专家会定义 `accepted → delivered → effective`（或 `failed/timeout`），每一跳都有观察证据 |
| 9 | **处理 compaction / surfaceOp 语义** | 抽样日志里事件带 `surfaceOp` 与 `sourceEventSeqs`；compaction 会重写历史（`compaction/start`、`compaction/summary`）。天真 replay 会把同一件事数两遍、把被折叠的等待又算成 pending |
| 10 | **隐私与最小权限** | 转录里有路径、token、粘贴的密钥；HUD 是常驻可见界面。专家会做渲染前脱敏、不落全量副本、缓存目录权限收紧，并把「不把整份转录写进日志」写成测试 |
| 11 | **先做探索性数据分析（EDA）再定阈值** | `RUNNING_MS=5min`、`ASK_TTL=10min`、`HEAD_LINES=400` 都是拍的。专家会先统计真实日志里的等待时长分布、帧大小分布、事件间隔，用分位数定阈值 |
| 12 | **给 HUD 自己装仪表**：解码次数、缓存命中、unknown 原因、seq 滞后 | 现在 HUD 出问题只能靠猜。专家会让界面能回答「你为什么不知道」 |

### 1.2 从什么最原始的材料开始（不是已消化的）

按「原始度」排序，越靠前越优先：

1. **zstd 帧字节本身**（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）。实测抽样 24 份、6.2MB：**24/24 是多帧、共 1711 帧**，`fzstd` 能一次解压拼接帧。这意味着可做「帧级增量解码」，不必整份解压。
2. **事件 JSON 原始行**：字段实测为 `type/seq/time/data`，部分带 `surfaceOp`、`sourceEventSeqs`。`seq` 连续且单调——这是天然的完整性校验与游标。
3. **DSH 进程内事件总线**（tap）：转录只是它的落盘投影；tap 能看到尚未落盘的事件，也是唯一能观察「审批卡被撤走」的地方。
4. **DSH 自己的物化会话状态**（`sessionController`）：独立实现，可当 oracle 对照。
5. **OS 层事实**：进程表（DSH/magpie PID、CPU 时间、启动时间）、窗口标题与前台窗口（Win32 `GetForegroundWindow`/`GetWindowThreadProcessId`）、文件句柄。
6. **供应商账单/额度页**：钱的唯一真相，替代 `~/.config/magpie/quotas.json` 这个二手汇总。

明确**不**作为起点的：`~/.magpie-hud/sessions-cache.json`、magpie 的 `quotas.json`、面板心跳 `app.json`、任何聚合统计。它们是「已经消化过的」，只能用来对账，不能用来推导。

### 1.3 具体方法与工具

| 方法 | 工具/位置 | 产物 | 判据 |
|---|---|---|---|
| 事件溯源 fold（纯函数 + 注入时钟） | `lib/state/` 新模块，`node:test` | `state = fold(events, prev)` | 重放幂等、前缀单调 |
| zstd 帧索引 + `seq` 连续性校验 | `fzstd`，逐候选帧起点解码后验 `firstSeq === lastSeq+1` | `{offset, firstSeq, lastSeq}` 索引 | 冷索引 ≤ 20s/280MB；热更新 ≤ 30ms/MB |
| 进程内 tap | 扩展现有 `dsh/magpie-hud.mjs`，追加写 `events.jsonl` | 追加式事件副本 | tap 与转录事件集 100% 一致 |
| 属性测试 | `fast-check` | 性质集 | 每条性质有反例即失败 |
| 变异测试 | `@stryker-mutator/core`（仅 fold/谓词模块） | 变异分数 | ≥ 75% |
| 差分 harness | 自写 `tools/oracle/` | 三方对照报告 | 不一致即 CI 红 |
| 带真值语料 | 从 197 份真实会话抽 100+ 等待事件，人工+LLM 双标注 | `corpus/labels.jsonl` | 双标注一致率 ≥ 95% |
| 故障注入 | 环境变量开关（`HUD_FAULT=tap-dead,half-frame,...`） | 每场景断言 | 10/10 场景符合预期降级 |
| 性能基准 | `process.cpuUsage()`、`performance.now()` | p50/p95 表 | 见 §6 |
| 外部 oracle | DSH controller、供应商页、进程表 | 对照证据 | 见 §1.4 |

### 1.4 除了你我，还有什么能证明结果是对的

1. **DSH 自己的会话状态/事件日志**：独立实现。同一时刻，HUD 显示的 turn/step/等待，必须与 DSH controller 读到的一致。
2. **原始字节的可复算性**：任何人拿 `seq` 连续性和帧索引就能复算我们的状态；`sha256` 锚定我们读过的字节。
3. **OS 层**：DSH 进程的 CPU 时间与启动时间，能证明「显示 running」时进程真的在干活；窗口焦点能证明「谁在前台」。
4. **供应商后台**：额度/账单页是钱的真相；HUD 的百分比必须能对上。
5. **独立评审 agent（红队）+ 人工抽检**：不看代码，只看界面与报告，按 §6 打分。
6. **CI 工件**：变异分数、P/R 报告、基准表、故障注入结果，一条命令复跑，结果可 diff。
7. **72 小时 soak**：每 10 分钟自动采样，HUD 状态 vs 独立 oracle 自动比对，产出不一致清单。

---

## 2. 已观测事实（方案的事实基础）

以下均为本次在本机实测，不是推断：

- 抽样 24 份 DSH 转录、6,221,991 字节：`session.v4.jsonl.zstd` **全部为多帧**，共 1711 帧；`fzstd` 一次解压拼接帧可用。
- 事件类型（抽样内计数 Top）：`tool/result` 441、`step/start` 427、`step/end` 427、`tool/call` 423、`assistant/message` 373、`user/message` 313、`agent/inbox/spliced` 237、`session-log-deepseek/delivery-accepted` 175、`job/registered` 115、`job/settled` 115、`turn/start` 97、`turn/end` 97。
- 等待有真事件：`approval/asked {id, toolName, callId, reason}` ↔ `approval/decided {id, outcome}`。
- 工具调用配对是显式的：`tool/result.data.sourceEventSeqs = [callSeq]`，不需要靠文本猜。
- 回执有真事件：`session-log-deepseek/delivery-accepted {sessionId, sessionFormatVersion, throughSeq}`。
- 后台任务有真事件：`job/registered` / `job/settled {status, cause, finishedAt, detail}`。
- 上下文重写有真事件：`compaction/start` / `compaction/summary {compactionId}`；事件行带 `surfaceOp`、`sourceEventSeqs`。
- `ask_user` 的真语义：`tool/call name=ask_user` 的 `tool/result` 文本是「卡片已上屏，答案作为下一条消息到达」——所以「在等用户回答」= 最近一次 `ask_user` 调用之后没有新的 `user/message`，这是可判定的，不需要正则。

这些事实直接判定了现有实现的三处「不深」：

1. `stateOf(mtime)` 是近似，事件里有 `turn/start`/`step/end`/`job/settled` 可以精确判定。
2. `ASK_RE` 文本启发式，事件里有 `approval/asked` 与 `ask_user` 调用可以精确判定。
3. 整份解压 65–99 秒，帧结构允许增量解码。

---

## 3. 真值模型规范（先写规范，再写代码）

### 3.1 状态机

单个会话的**观测状态**（正交维度，不是一个枚举）：

- `phase ∈ {starting, working, waiting, paused, ended, unknown}`
  - `starting`：`session` 事件已见，`turn/start` 未见
  - `working`：存在未闭合的 `turn`，或存在未 `job/settled` 的 job，或最后一个 `step/start` 无对应 `step/end`
  - `waiting`：存在未决 `approval/asked`，或最近 `ask_user` 调用后无新 `user/message`
  - `paused`：`turn/end` 且无新 `turn/start`，且无未决等待/job
  - `ended`：会话文件已封口或显式结束事件
  - `unknown`：证据不足（tap 不在、seq 缺口、解码失败、权限拒绝）
- `activity`：当前工具名 + turn/step（来自 `tool/call`），无则空
- `waitingOn ∈ {approval, question, subagent, none}`，带 `since` 与 `askId`
- `receipt`：见 3.4
- `asOf = {source: tap|transcript|none, lastSeq, observedAt, lagMs, stale}`

**硬规则**：`phase` 的每次转换必须记录「触发事件 seq + 规则名」。没有触发事件的转换一律视为实现缺陷，测试直接失败。

### 3.2 证据与 as-of

每个字段带 `provenance: {file, seq, frameOffset}`（tap 来源则 `{tap, seq}`）。渲染层只消费 `asOf.source` + `asOf.lagMs`，不允许自行推断新鲜度。
陈旧阈值：tap 正常时 `lagMs > 3000` 标黄；transcript fallback 时 `> 8000` 标黄；`> 30000` 显示 `unknown`。

### 3.3 compaction / surfaceOp 语义

fold 必须处理 `surfaceOp ∈ {append, replace, ...}` 与 `sourceEventSeqs`：

- `append`：正常折叠。
- `replace`（compaction 产物）：**不是新事实，是对既有事实的替代**。规则：同一 `compactionId` 的 `summary` 折叠后，被替代区间的 `waiting`/`working` 贡献必须被撤销，不能重复计数。
- 未知 `surfaceOp`：整段标 `unknown` 并降级到上次已知状态，同时记一条 `unknown_reason`。

### 3.4 回执状态机（替代 `startedAt` 乐观语义）

```
queued → accepted(seen by DSH) → delivered(delivery-accepted.throughSeq >= ourSeq)
       → effective(后续出现预期效果事件：审批卡消失且 approval/decided，或 ask_user 后新 user/message)
       ↘ failed / timeout
```

- 每一跳的观察证据必须落到 `asks.log.jsonl`：`{askId, hop, at, evidence:{seq|throughSeq|reason}}`。
- `accepted` 之后 30s 无 `delivered` → `timeout`，界面显示「已入队，未见生效」。
- 只有 `effective` 才算完成；`accepted` 不得渲染成绿色完成态。

### 3.5 未知的展示语法

`unknown` 不是空白，是带原因的状态：`{phase:"unknown", reason:"seq-gap"|"tap-dead"|"decode-failed"|"permission"|"schema-drift", since}`。UI 上必须可见（灰色 + 原因 tooltip），并进 `unknown` 计数仪表。

---

## 4. 架构（在现有代码上做减法）

```
DSH 进程内 tap (dsh/magpie-hud.mjs 扩展)
   └─ 追加 events.jsonl（我们的副本，只追加不重写）
          ↓
   纯 reducer  fold(events) → SessionState（含 provenance/asOf）
          ↑
   转录适配器（fallback）
     ├─ 帧索引（一次扫描，seq 校验）
     └─ 增量解码（只解新增帧；失败→unknown，不整份解压）
          ↓
   仲裁：tap 正常用 tap；tap 掉线 >5s 用转录并标 stale；两者都不可用→unknown
          ↓
   pageservice → 现有 3 个 panel（只增加来源/陈旧/证据钻取，不新增面板）
```

代码层面的净结果应该是**变少**：
- 删除 `lib/sessions.mjs` 的 `stateOf(mtime)` 与 `ASK_RE` 启发式（约 30–50 行）。
- 删除「整份解压 + 空壳等待」路径，换成帧索引增量解码（净减少一次 65–99 秒的全量扫描）。
- `lib/usage/tokens.mjs` 保留「不编钱」的决定，但每个数加 provenance。
- Rust 桌面端不改协议，只消费新增字段（未知态样式 + 来源徽标）。

---

## 5. 阶段与交付（每阶段都有可验的出口）

| 阶段 | 交付 | 出口判据 |
|---|---|---|
| P0 规范 + 语料（2 天） | `docs/magpie-hud-truth-model.md`；`corpus/labels.jsonl`（≥100 等待事件、≥20 会话）；EDA 报告（等待时长分布、帧大小分布） | 双标注一致率 ≥95%；规范里每个状态有证据定义 |
| P1 帧索引 + 增量解码（2 天） | `lib/transcript/frames.mjs`；冷索引/热更新基准 | 冷 280MB ≤20s；热 ≤30ms/MB；seq 缺口 0 |
| P2 reducer + 状态机（3 天） | `lib/state/*`；属性测试；`phase` 转换必须带证据 | 重放幂等/前缀单调/截断容忍全绿；状态与事件真值 100% 一致 |
| P3 tap 观测 + 仲裁（2 天） | tap 事件副本；tap/转录差分 | 事件集一致率 100%；tap 掉线 5s 内切 fallback 且标 stale |
| P4 等待判定 + 回执（2 天） | `waiting` 判定；回执状态机；`asks.log` 证据 | P/R 达标（§6）；`accepted` 不再渲染成完成 |
| P5 度量与硬化（2 天） | 变异测试、故障注入、预算断言、soak 脚本、一键报告 | 变异 ≥75%；10/10 故障场景；72h soak 0 崩溃 |

> 执行状态（2026-11-15）：P0–P4 完成；P5 除「72h 常驻浸泡」与「真实宿主进程 CPU 采样」外完成。全部证据与复跑命令见 `docs/magpie-hud-report.md`。
>
> 72h 浸泡已按「机器不关」口径常驻启动（startedAt 2026-11-15T09:45:48Z，预计 2026-11-18T09:45Z）。巡检用 `node tools/soak/status.mjs`：进度文件超 60s 未更新即退出码 1，用来区分「还在跑」与「job 已死」，不靠人说。浸泡期间冻结 `lib/truth/*`、`dsh/magpie-hud.mjs`、`tools/*`，避免 72h 数据混进多个版本。

---

## 6. 验收指标（硬数字，写进 CI）

> 权威版本：`docs/magpie-hud-report.md`（由 `node tools/oracle/report.mjs` 生成，可复跑）。下表是目标与实测的对照，实测值来自 2026-11-15 本机。

| 指标 | 目标 | 实测 | 状态 |
|---|---|---|---|
| 等待判定 precision（approval+ask_user，episode 级） | ≥ 0.97 | 1（tp 258 / fp 0；含 120 条场景） | 达标 |
| 等待判定 recall | ≥ 0.95 | 1（tp 258 / fn 0） | 达标 |
| 留出集 P / R（哈希划分，未冻结清单） | ≥ 0.97 / ≥ 0.95 | 1 / 1（39 条：15 真实审批 / 0 真实提问 / 12 场景审批 / 12 场景提问） | 达标（构成见报告） |
| 时间点采样 P / R（分层） | ≈1 | 1 / 1（tp 591 / tn 591） | 达标 |
| 等待起始时间 | 与 asked 事件同源 | 构造性相等（不是独立测量，见报告 §4） | 说明项 |
| tap 投影往返无损（同一批事件自比） | 无损 | 199/199 identical | 达标（不等于 live tap 已验证） |
| 真实宿主 live tap（session/event 直写 → 读回 → 与转录重投影逐行对照） | live 一致率 100% | 1 会话 / 18 行一致（0 mismatch）；该次模型鉴权失败，未覆盖审批/提问事件 | 部分达标（样本窄，见报告 §4） |
| 尾部窗口冷读 199 份（实读 13MB / 语料 289MB） | ≤ 20s | 6.6s（p95 63ms、max 105ms/文件） | 达标（只读窗口，非全量解码） |
| 热更新（追加一帧后重算） | p95 ≤ 30ms | p95 0.53ms | 达标 |
| 稳态 CPU（文件未变时整轮刷新） | 10s 刷新下 ≤ 0.5% 单核 | 整轮 21ms ⇒ ≈0.2% | 达标（口径见下方说明） |
| 稳态 CPU（60s 采样 / 5s 刷新，`process.cpuUsage`） | ≤ 1.5% 单核均值 | 0.49% 均值（p95 0.94%、峰值 0.94%） | 达标 |
| 常驻内存 | ≤ 300MB | RSS 增量 57MB | 达标 |
| 变异分数（仅 fold.mjs，自研语义突变） | ≥ 75% | 100%（killed 27 / survived 0 / skipped 1 单列） | 达标（frames/collect/tap 无变异分） |
| 故障注入场景（断言降级到 unknown，非只断言不崩） | 10/10 符合预期降级 | 11/11 | 达标 |
| provenance 覆盖率 | 100% 字段 | 每行 evidence（读法/字节区间/尾部状态/规则/seq），page-smoke 计数 50/50 | 达标 |
| 未知诚实性 | 0 例 unknown 被渲染为 idle/running | `/api/state` 0 例；故障注入断言 state=unknown 或 truncated | 达标（DOM 未验） |
| 72h soak | 0 崩溃、0 未解释不一致 | 60s 冒烟 75,520 次：unknown 0、滞后 0、p95 1.25ms | **未完成（常驻跑 2026-11-15T10:21Z 起）** |

口径说明（避免数字互相装点）：
- 单文件冷读 30ms 在纯 JS fzstd 下不可达（1MB 窗口实测 p95 1012ms）；默认窗口已缩到 128KB，判据改为「总耗时 ≤20s + 单文件 p95 ≤120ms」。
- 「冷读」只覆盖每份转录的尾部窗口（实读字节数在报告行内），不是「198 份 / 287MB 全量解码」；全量解码另测约 126s（`corpus/stats.json`）。
- 热更新最初测到 30.38ms，实为「合成帧 seq 不接续 → readAppend 判缺口 → 退回整窗重读」的假路径；修正 seq 后真实增量路径 p95 0.53ms。
- 「稳态 CPU」两行分别是：整轮刷新耗时折算（21ms/10s）与真实 `process.cpuUsage` 60s 采样（`tools/bench/cpu.mjs`，均值 0.49%）。10 分钟口径用 `CPU_SECONDS=600 CPU_REFRESH_MS=10000 node tools/bench/cpu.mjs`。
- 等待判定的 P/R 与「起点误差」不能当独立验证：标注与 reducer 同规范，且 `waiting.seq` 与 `askedSeq` 取的是同一条事件（构造性相等）。已从验收表撤掉「起点误差」行，改在报告 §4 说明。


---

## 7. 冻结清单（明确不做，防止又变「更大」）

- 不新增客户端适配（Claude/Codex 本机无数据；有数据再谈）。
- 不新增面板/标签页/形状/主题。
- 不做 macOS 二进制（无机器可验）。
- 不改通道协议的文件格式（v5 已稳定；只加字段不改形状）。
- 不做云同步、不做历史数据库（本地 JSONL 足够）。
- 不追求「零配置」；tap 未安装时明确显示 degraded。

---

## 8. 重写后的任务书（可直接作为执行指令）

> **目标**：把 magpie-hud 从「读转录 + 时间近似」升级为「事件溯源 + 可证伪的会话真值」，不改 UI 广度。
>
> **必须交付**：
> 1. `docs/magpie-hud-truth-model.md`：状态机、证据定义、as-of、unknown 规则、compaction 语义、回执状态机。
> 2. `corpus/labels.jsonl` + EDA 报告：≥100 个等待 episode 的人工真值，双标注一致率 ≥95%。
> 3. `lib/truth/frames.mjs`：zstd 帧索引 + 以 `seq` 连续性校验的增量解码；禁止整份解压。
> 4. `lib/truth/fold.mjs`：纯 reducer，注入时钟，`phase` 每次转换带触发 seq 与规则名。
> 5. tap：扩展现有 `dsh/magpie-hud.mjs` 追加事件副本；tap/转录差分 100%。
> 6. 仲裁与降级：tap 掉线 5s 切 fallback 标 stale；两者皆无→`unknown` 并给原因。
> 7. 等待判定替换 `ASK_RE`：用 `approval/asked|decided` 与 `ask_user` 语义；P≥0.97、R≥0.95。
> 8. 回执状态机 `queued→accepted→delivered→effective|failed|timeout`，证据落 `asks.log.jsonl`。
> 9. 度量套件：变异测试、属性测试、10 个故障注入、性能预算、72h soak、一键 `tools/oracle/report.mjs`。
>
> **禁止**：编造金额；把 `accepted` 当 `effective`；unknown 静默变 idle；整份解压；新增客户端/面板；在没有 oracle 对照的情况下宣布「验证通过」。
>
> **完成定义（DoD）**：§6 表中全部指标达标，且 `node tools/oracle/report.mjs` 在干净环境复跑得到同数（`node tools/oracle/verify.mjs` 对着 `corpus/report-baseline.json` 逐行比对，确定性指标逐字一致、时间类 ±25% 内，退出码 0）；红队 agent 只看界面与报告，能独立指出「哪一条显示有证据、哪一条是 unknown」。

---

## 9. 风险与回退

| 风险 | 应对 |
|---|---|
| `fzstd` 不解帧边界 / 无法定位帧起点 | 用「候选 magic 起点 + 解码后 `seq` 连续」验证；失败则该文件整份解码一次并记 `unknown_reason:"frame-scan"`，不阻塞其他会话 |
| tap 装上后影响 DSH 稳定性 | tap 只做 `appendFileSync` 小行，异常全 catch；提供 `HUD_TAP=off` 一键关闭；soak 期间监控 DSH 自身 CPU |
| 语料标注主观 | 双标注 + 分歧仲裁；标注规则写进规范，可复现 |
| compaction 语义理解错误 | 用 DSH controller 的物化状态做对照；不一致时标 unknown 而非猜 |
| 指标定太高导致交付膨胀 | 指标只覆盖 fold/等待/解码三条主路径；UI 不动 |

---

## 10. 与现有文档的关系

- `docs/magpie-hud-v5-plan.md`：通道与「能答」部分继续有效；v6 只在其上补观测真值。
- `docs/magpie-hud-verification.md`：其中的 71/243/14 测试数字仍可作为回归基线，但**不再作为深度证据**；深度证据以本方案 §6 为准。
- `docs/magpie-hud-design.md`：视觉部分冻结，只增加来源徽标与 unknown 样式两处。
- `docs/agent-hud-open-research.md`：上游 `F:/maple/agent-hud-open` 已不在本机，不再作为对照实现；改为 DSH 自身状态 + 原始字节作为 oracle。
