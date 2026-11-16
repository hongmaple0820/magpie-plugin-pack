> 2026-11-12：鹊桥（magpie-agents）已并入鹊楼（magpie-hud）成为其工具半与数据引擎，独立插件已删除。本文档是历史规划记录，落地形态见 plugins/magpie-hud。

# 新 magpie 插件方案 v2.1：magpie-agents（鹊桥）——跨 agent 会话编排 + 厂商侧额度

> 日期：2026-11-11。状态：用户已认可（v2 + 追加额度/用量）；M1–M5 与 M-U2 已落地；M6 面板按用户裁决（2026-11-12）拆出为独立插件 magpie-hud（鹊楼）。
> v1（minimax-web 渠道）已被否决并删除。v2.1 = v2（跨 agent 会话消息）+ 额度/用量模块（用户追加）。

## 1. agent-hud-open 是什么（这次读全了）

它不是额度面板，而是**本机所有 AI coding agent 的控制面**，四层：

1. **agents crate**（src/crates/agents）：每客户端一目录——transcript.rs（转录解析→共享模型 Log/LiveLog/Usage）、hooks.rs（权限规则/问题/计划/完成载荷）、account.rs（账号与厂商额度读取）、replies.rs（话怎么进会话）、channel.rs（原生通道，如 Codex desktop IPC）；Request API（parse_request→Request，决策 allow/deny/always/answer/approve_plan/keep_planning/leave）。
2. **messaging crate**（src/crates/messaging）：4 个 MCP 工具——list_sessions / send_message / start_session / get_message。agent 会话经它的 MCP 服务器把话送进本机另一个 Claude Code/Codex/Antigravity/DSH/Cursor/TRAE/WorkBuddy/ZCode/Qoder/Kimi Code 会话，或启动一个，之后读答复。journal 记录谁发给谁；答复从对方转录里读；10 个来回无用户介入就拒绝（防 agent 自循环）。
3. **platform/delivery**：每客户端一条投递路径——Claude=共享文件夹+Claude Code 插件钩子（文件队列，会话空闲时提交，拒绝 slash 命令）；Codex=desktop IPC/命令行队列；antigravity/deepseek 各自；process/stdio 兜底；starts/=启动会话。
4. **host crate**：HUD 窗口、coordinator、capture。

## 2. magpie 插件体系能挂什么（研究结论）

- 钩子：auth / provider / config / **tool** / search / chat.headers。
- package.json 声明：magpie.page（自有页面+127.0.0.1 本地服务）/ magpie.panels / magpie.actions / magpie.agent（agentplug：给 magpie 添加一个 agent）/ magpie.permissions（usage:summary、providers:list）。
- **tool 钩子 → internal/gateway/tools_mcp.go → /mcp/magpie/tools MCP 服务器**：源码原话「every agent that takes an MCP server can call them, not only OpenCode」——与 agent-hud 的 MCP 工具组完全同构。这是本插件的落点。
- 工具契约（internal/plugin/tools.go + host.js）：{tool: {name: {description, args, execute(args, ctx)}}}，args 收 zod 或完整 JSON Schema（本插件用后者，工具自查）；execute 返回字符串（原样）或对象（JSON 序列化）；单次调用 55s 上限。
- 入口约定（magpie-nest 同款）：入口导出的每个函数都被当作一个插件运行，所以入口只导出一个插件函数。
- 运行时：Bun/moejs，node:fs + node:child_process 可用（pack 的 weblogin/inkstone 先例）。

## 3. 插件定位

plugins/magpie-agents/（鹊桥）：把 agent-hud 的两层能力移植进 magpie——

**A. 跨 agent 会话消息**：所有走 magpie 网关的 agent 通过 magpie 的插件工具 MCP 服务器看见本机其他 agent 会话、发消息（排队不打断）、启动新会话、读答复。

**B. 厂商侧额度/用量（v2.1 追加）**：读各客户端订阅套餐的厂商侧额度——Claude Pro 的 5h/周窗、Codex 套餐用量等。magpie 本体的统计只覆盖走它网关的流量，厂商套餐额度是缺口；agent-hud 的 account.rs 读法（本机客户端凭证 + 厂商端点）正好补上。以 list_quotas 只读工具呈现（面板在独立插件 magpie-hud）；不走 auth.usage（那是 provider 插件的账号钩子，本插件读的是客户端自己的磁盘凭证，无 magpie 账号）。

## 4. 交付物与文件布局（全部在 magpie-plugin-pack 内）

plugins/magpie-agents/
  package.json     magpie 清单（照 magpie-nest 形状）
  index.mjs        只导出一个插件函数（nest 约定：入口导出的每个函数都会被当作插件）
  lib/
    tools.mjs        5 工具定义与 execute（list_sessions / send_message / start_session / get_message / list_quotas）
    sessions.mjs     会话发现（Claude ~/.claude/projects、Codex ~/.codex/sessions、DSH ~/.dsh/sessions、Antigravity ~/.gemini/antigravity*/brain）
    transcripts.mjs  各客户端转录行解析（Claude/Codex/DSH/Antigravity，照 agent-hud 各 transcript.rs）
    delivery/       claude.mjs（文件队列+钩子）/ codex.mjs / process.mjs（stdio 兜底）
    claude-plugin/  自带的 Claude Code 插件（hooks：队列取走、空闲提交）
    journal.mjs     消息日志（谁发给谁、指纹、答复位置、来回计数）
    usage/           厂商侧额度读取（claude.mjs / codex.mjs / dsh.mjs；凭证路径与端点以 agent-hud agents/src/<client>/account.rs 为准，M-U1 先读再移植）
  test/            node --test 单测
  README.md

面板（原 M6）不在本插件里：按产品方向拆出为独立插件 plugins/magpie-hud（鹊楼）——
给人看的面板与给 agent 用的连接/编排工具是两个产品；鹊楼不解析任何客户端协议，
数据引擎来自本插件 lib（兄弟目录相对导入 ../magpie-agents/lib/…，pack 文件夹安装
与 npm/bun 安装两种形态下都成立；鹊桥不在时面板明说需要它）。

## 5. 工具设计（照 agent-hud messaging/tools.rs 的语义 + v2.1 的额度工具）

- **list_sessions**（只读）：列本机 agent 会话——id、client、title、project、state（idle/running/waitingForApproval）、reachable（true/false/null+原因）、self、startFolders。M1 已实现 Claude Code + Codex 扫描（state 用转录 mtime 近似）。
- **send_message**：向 id 发 text；排队不打断；返回 message id + queued；reply_to 答复回送；收件人看到首行署名+末行回复指引；10 来回无用户介入则拒绝。
- **start_session**：client（claude/codex/antigravity）+ folder + text；folder 默认调用者项目；返回 message id。
- **get_message**（只读）：读消息状态——queued/taken/started/done(带答复)/replied/refused/expired/uncertain；答复从对方转录读，不唤醒对方。
- **list_quotas**（只读，v2.1 新增）：读本机已装客户端的厂商侧套餐额度与用量——各客户端自己的磁盘凭证 + 厂商端点（Claude 的 5h/周窗、Codex 套餐用量等；凭证路径与端点字段以 agent-hud agents/src/<client>/account.rs 为准，M-U1 先读再移植，不猜）。只读不写、凭证不移动；可选 client 过滤。

## 6. 实施步骤（PDCA，每步可验证）

- **M1 骨架与可见性 ✅（2026-11-11）**：package.json + index.mjs + 5 工具注册；list_sessions 已做 Claude+Codex 最小真实扫描；其余工具返回明确里程碑提示；node --test 绿。验证「装载 → 工具注册 → MCP」管线。
- **M2 会话发现补全**：DSH / Antigravity 转录路径（读 agent-hud 对应 transcript.rs 定路径与格式）；state 精确化；startFolders。✅ 已落地（state 仍用 mtime 近似，reachable 由 messaging 层标）。
- **M3 Claude 投递闭环**：claude-plugin 钩子 + 文件队列 + journal → send_message/get_message 真实往返。
- **M4 start_session**：spawn CLI + stdio 首消息。✅ 已落地（Claude --bg + job state.json 轮询；Codex thread/start + queue/add + wake）。
- **M5 Codex/DSH 投递**。✅ Codex 已落地（app-server thread/queue/add + codex://threads/wake）；DSH 仍待后续。
- **M-U 额度读取**：M-U1 读 agents/src/{claude,codex,dsh}/account.rs 定凭证路径与端点 → M-U2 claude+codex 读卡（list_quotas 真实数据）→ M-U3 dsh 等。
- **M6 magpie.page 面板**：✅ 已落地后按用户裁决拆出为独立插件 magpie-hud（鹊楼）——面板是给人看的产品方向，与鹊桥（给 agent 用的连接/编排工具）分开；数据引擎仍是鹊桥的 lib。

## 7. 验收标准

1. test-all / 新插件单测绿。
2. magpie 里插件装载无错，/mcp/magpie/tools 列出 5 工具。
3. 走 magpie 的 Claude Code 会话里，agent 能调 list_sessions 看到本机其他会话（含 DSH）。
4. send_message → 目标 Claude Code 会话空闲后收到消息并作为新回合处理 → get_message 读到 done+答复。
5. start_session 启动新 claude 会话并拿到首答。
6. 来回上限生效（第 11 次无用户介入被拒绝）。
7. list_quotas 返回本机已登录客户端的厂商侧额度窗口（真实数据，字段以 account.rs 为准）。
8. 面板页显示会话、消息日志、额度（在独立插件 magpie-hud 里验收）。

## 8. 风险与边界

- 最大工作量在 Claude 投递：agent-hud 靠它自己的 Claude Code 插件（hooks）收队列；我们必须自带同等钩子插件并让用户装进 Claude Code（或自动安装）。M3 前先验证钩子装载路径。
- 转录格式漂移：先做 Claude+Codex+DSH 三家最稳的，其余客户端按 agent-hud 的解析器逐个移植。
- moejs/Bun 与 Node 差异：fs/child_process 有先例；M1 用纯 node:fs 实现并通过 node --test，Bun 侧装载待真实 magpie 验证一次。
- 额度读取的凭证边界：只读客户端自己的凭证文件，绝不写、绝不外传；端点与字段以 account.rs 为准，不猜。
- 不做：审批/提问应答（Request API）——后续可选方向，本方案不含。
