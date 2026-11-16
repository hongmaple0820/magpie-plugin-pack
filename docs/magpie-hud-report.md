# magpie-hud v6 深度版：验收证据报告

- 生成时间：2026-11-16T07:52:40.344Z
- 机器：win32 10.0.19042 · 16 vCPU · 8GB · node v22.20.0
- 结论：**18 项达标 / 0 项不达标 / 1 项未完成**（目标见 docs/magpie-hud-v6-depth-plan.md §6）

## 1. 验收表（每个数字都有可复跑的出处）

| 指标 | 目标 | 实测 | 状态 | 证据文件 |
| --- | --- | --- | --- | --- |
| 等待判定 precision（episode 级，含场景） | ≥ 0.97 | 1（tp 258 / fp 0） | ✓ 达标 | corpus/eval-waiting.json |
| 等待判定 recall（episode 级，含场景） | ≥ 0.95 | 1（tp 258 / fn 0） | ✓ 达标 | corpus/eval-waiting.json |
| 留出集 P / R（哈希划分，未冻结清单） | ≥ 0.97 / ≥ 0.95 | 1 / 1（39 条，构成：15 真实审批 / 0 真实提问 / 12 场景审批 / 12 场景提问） | ✓ 达标 | corpus/eval-waiting.json |
| 时间点采样 precision / recall（分层） | ≈1 | 1 / 1（tp 591 / tn 591） | ✓ 达标 | corpus/eval-waiting.json |
| 截断读取层（窗口只到 asked 帧末仍判等待） | 120/120 | 120/120（fail 0） | ✓ 达标 | corpus/eval-waiting.json |
| tap 投影往返无损（同一批转录事件 → tapProject → 读回 → fold） | 无损 | 100%（226 份，mismatch 0） | ✓ 达标 | corpus/tap-parity.json |
| 真实宿主 live tap（session/event 直写 → 读回 → 与转录重投影逐行对照） | live 一致率 100% | 1 会话 / 18 行，mismatch 0（本机模型鉴权失败，未产生审批/提问类 live 事件） | ✓ 达标 | corpus/live-parity.json |
| 尾部窗口冷读（226 份，实读 14MB / 语料 315MB） | ≤ 20s | 10299ms | ✓ 达标 | corpus/budget.json |
| 单文件冷读 p95 | ≤ 120ms（按实测校准，原 30ms/MB 不可达） | 90.3ms（max 131.1ms） | ✓ 达标 | corpus/budget.json |
| 热更新 p95（追加一帧后重算） | ≤ 30ms | 0.63ms | ✓ 达标 | corpus/budget.json |
| 稳态整轮刷新（文件未变，备忘录命中） | ≤ 50ms ⇒ 10s 刷新下 CPU ≤ 0.5% | 34ms | ✓ 达标 | corpus/budget.json |
| 常驻内存增量（RSS） | ≤ 300MB | 60MB | ✓ 达标 | corpus/budget.json |
| 稳态 CPU（60s 采样 / 5s 刷新，process.cpuUsage） | ≤ 1.5% 单核均值 | 1.2%（p95 2.18%、峰值 2.18%，12 轮） | ✓ 达标 | corpus/cpu.json |
| 变异分数（lib/truth/fold.mjs） | ≥ 0.75 | 1（killed 27 / survived 0 / invalid 0；另有 1 条等价/锚点未命中（不计分，见 corpus/mutation.json）） | ✓ 达标 | corpus/mutation.json |
| 故障注入场景（断言降级到「未知」，不是只断言不崩） | ≥ 10/10 | 11/11 | ✓ 达标 | corpus/fault.json |
| HUD 页面 /api/state：每行有结论（rule 或 unknown.reason）+ evidence（HTTP 契约，非 DOM） | dsh 行 100% 有结论（rule 或 unknown.reason）；有结论的行 100% 带 evidence | 50/50 行有结论（明确 unknown 0 行），50/50 带 evidence，无结论 0（轮询 0s 后） | ✓ 达标 | corpus/page-smoke.json |
| 每条显示带 provenance（规则 + seq + 字节区间/尾部状态） | 100% | 带 evidence 的 50/50 行都含 mode+bytes；另有 test/pending.test.mjs 逐行断言 | ✓ 达标 | corpus/page-smoke.json + test/pending.test.mjs |
| unknown 不得伪装成 idle | 0 例 | /api/state 中 phase=unknown 且 state=idle 的行：0；故障注入 11 例断言 state=unknown 或 truncated | ✓ 达标 | corpus/page-smoke.json + corpus/fault.json |
| 浸泡（追加 + 每次重算，未知数/滞后数）（当前仅冒烟，完整 72h 需常驻跑） | 72h 0 崩溃、0 unknown、0 滞后 | 1.97h：9261900 次迭代，unknown 0、滞后 0、p95 1.81ms、RSS +55.4MB，稳态斜率 heap 0.07/rss 0.14MB/h（预热 600s 已排除，GC 开） | … 未完成 | corpus/soak.json |

## 2. 本次执行的命令与结果

| 步骤 | 命令 | 耗时 | 结果 |
| --- | --- | --- | --- |
| 单元/属性/契约测试 | `node --test test\agents.test.mjs test\arbitrate.test.mjs test\channel-routes.test.mjs test\channel.test.mjs test\clients.test.mjs test\codex-delivery.test.mjs test\desktop.test.mjs test\dsh-channel.test.mjs test\dsh-receipt.test.mjs test\entry.test.mjs test\history.test.mjs test\ledger.test.mjs test\notify.test.mjs test\pageservice.test.mjs test\pending.test.mjs test\pricing.test.mjs test\provider-quotas.test.mjs test\quota-alerts.test.mjs test\quota-history.test.mjs test\quotas.test.mjs test\session-detail-hint.test.mjs test\session-detail.test.mjs test\settings.test.mjs test\tools-contract.test.mjs test\tools.test.mjs test\truth-collect.test.mjs test\truth-fold.test.mjs test\truth-frames.test.mjs test\truth-tap.test.mjs` | 5.6s | 通过 |
| 等待判定评测（真实语料 + 场景 + holdout + 窗口层） | `node tools/eval/waiting.mjs` | 107.3s | 通过 |
| 故障注入（11 个坏输入场景） | `node tools/fault/inject.mjs` | 0.3s | 通过 |
| tap/转录双实现对照 | `node tools/oracle/tap-parity.mjs` | 314.5s | 通过 |
| 真实宿主 live tap 对照 | `node tools/oracle/live-parity.mjs` | 0.2s | 通过 |
| 性能预算 | `node tools/bench/budget.mjs` | 26.2s | 通过 |
| 变异测试（fold.mjs） | `node tools/mutation/run.mjs` | 23.4s | 通过 |
| 页面 HTTP 冒烟（临时端口 + /api/state） | `node tools/oracle/page-smoke.mjs` | 1.4s | 通过 |
| 稳态 CPU 采样（60s，5s 刷新） | `node tools/bench/cpu.mjs` | 74.0s | 通过 |

## 3. 证据链：一条显示能倒推到什么

```
raw zstd 帧字节 ──readWindow(offset,size)──▶ 事件 {seq,type,data}
      ▲                                        │
      │ 帧三验（可解码 / 每行 JSON / seq 严格 +1）  ▼
tap 事件副本（进程内 session/event 直抄；本机已真跑 1 个宿主进程，18 行逐行一致，未覆盖审批/提问）──仲裁──▶ 纯 reducer fold(state,ev) ──▶ phase + waiting + rule + seq
      ▲                                        │
      └──── tap 投影往返无损 226 份（同一批事件自比，非独立 oracle）◀─┘
```

- 每条会话行的 `evidence` 记录：读法（events/tap/both）、字节区间、mtime、触发规则与 seq；末尾还有不可解码字节时记 `tailBytes/tailKind`（`partial-frame` 容忍并标 truncated，`garbage` 直接判 unknown）。
- 等待显示附 `toolName`、`since`（来自事件时间，不是 mtime 推算）与规则名。
- 回答回执：`accepted → delivered(seq) → effective(seq)`，超时 60s 记 `timeout`，绝不把 accepted 渲染成已完成。

## 4. 诚实边界（这些「绿灯」不证明什么）

- **P/R=1 是「与自身规范一致」，不是独立测量**：标注与 reducer 出自同一份事件语义；且 checkpoint 上的 `waiting.seq === askedSeq` 由构造保证（两边取的是同一条 approval/asked 事件），所以不存在「起点误差」。真正被检验的是「这些 seq 上判不判 waiting」。
- **留出集不冻结**：成员按 `sessionId 哈希 % 5` 每次运行现算，没有封存清单；构成见第 1 节该行（真实提问样本数量写在里面，别当成整批真实会话盲测）。
- **live tap 已发生，但样本极窄**：本机用 `dsh --profile headless --patch <overlay>` 真跑了一个宿主进程，插件把 `session/event` 直写进 `~/.magpie-hud/tap`，逐行重投影对照 18/18 一致；但该次模型鉴权失败（INVALID_TOKEN），只覆盖会话头/权限/输入/回合/turn-end 这些事件，**审批与提问类 live 事件仍为 0**。所以「宿主直写 == 转录」只在这 18 行上成立，不代表全事件族。
- **冷读数字只覆盖尾部窗口**：每份转录只读末尾 ≤128KB 去判相位（实读字节数写在行内），不是「198 份 / 288MB 全量解码」；全量解码另测约 126s（corpus/stats.json），那才是「读整份」的成本。
- **页面冒烟只到 HTTP 契约**：`/api/state` 字段齐全 ≠ 界面上真的渲染出「未知」pill；DOM 级验证（截图/无障碍树）未做。
- **变异分数只覆盖 `lib/truth/fold.mjs`**：frames/collect/tap 与 dsh 插件层没有变异分；equivalent/anchor 未命中的突变单列在 corpus/mutation.json，不计入分母。
- 本机没有 Claude Code / Codex 的会话目录（~/.claude/projects、~/.codex/sessions 不存在），这两条客户端路径只有单测覆盖，没有真实语料。
- 72h 浸泡需要常驻机器：仓库提供 `SOAK_SECONDS=259200 node --expose-gc tools/soak/run.mjs`；未跑满前该项永远是 pending，不冒充达标。斜率排除前 10 分钟预热（`SOAK_WARMUP_SEC`），否则启动期长起来的内存会被当成泄漏；不带 `--expose-gc` 时量到的是带未回收垃圾的 RSS，斜率偏大。
- 未做：多显示器下的像素级视觉回归、IME 中文输入、macOS 桌面二进制、真实 magpie 宿主内的 CPU 采样。

## 5. 复跑

```powershell
cd plugins/magpie-hud
node tools/oracle/report.mjs          # 全部证据一次跑完并重写本报告
node tools/corpus/extract.mjs         # 重新抽取真实等待 episode（需要 ~/.dsh/sessions）
node tools/corpus/scenarios.mjs       # 重新生成场景语料
SOAK_SECONDS=259200 node --expose-gc tools/soak/run.mjs   # 完整 72h 浸泡（另开终端常驻）
```
