# agent-hud-open 研究笔记

> 生成于 2026-11-11（DSH 会话）
> 上游仓库：https://github.com/jazzenchen/agent-hud-open（本地 F:/maple/agent-hud-open，当日克隆）

## 1. 这是什么项目

Agent HUD：给编程 agent 用的 HUD（抬头显示器）。你的 agent 在 Mac 上跑，Agent HUD 把它们的
进度带到屏幕边缘（Notch / Simple 两种模式）、iPhone、Apple Watch 上：谁在忙、谁在等你、
额度还剩多少、需要你审批/回答的卡片，以及一键跳回会话。

- 本仓库 agent-hud-open 是开源预览版（Rust + Tauri 2 + React），对标闭源 Swift 版
  agent-hud-native-open（行为以 Swift 版 commit 014524c 为基准，docs/parity/ 是逐条对照账本）。
- 支持 27 个客户端：Claude Code、Codex、DeepSeek Harness、Antigravity、Cursor、Grok、OpenCode、
  Kilo/MiMo Code、Kimi、Pi、Qoder、TRAE、ZCode、CodeBuddy、WorkBuddy、Qwen Code、Devin、Cline、
  Roo Code、Goose、Hermes、Factory Droid、Copilot 等（README「Supported agents」矩阵）。
- 内置 MCP 服务：agent 之间互发消息，agent 重排 HUD 布局（改动以预览出现，用户点 Save 才保留）。
- 数据全部本地：读各 agent 自己的日志/DB，写本地 SQLite 账本；不上传。Apache-2.0。
- 构建要求：Node 24+、pnpm、Rust 1.90+、Tauri 2 系统依赖。

## 2. 技术栈与分层

pnpm monorepo + Rust workspace，src/ 下：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| agents | src/crates/agents | 每个客户端一个文件夹：描述符 + transcript 解析 + account 读取 + hooks 格式 |
| core | src/crates/core | 增量读日志、去重、token 分类、会话状态机、SQLite 账本、配额数学 |
| platform | src/crates/platform | OS 适配、路径发现、hooks 通道、每个客户端的原生通道 |
| runtime | src/crates/runtime | 组合 core + platform 的唯一入口 |
| hud | src/crates/hud | HUD 布局规则、Bot 导演、厂商行 |
| host | src/crates/host | Tauri 宿主：窗口、托盘、HUD 窗口、ProductExtension 扩展接口 |
| apps | src/apps/{desktop,mcp,installer} | Tauri 壳 + React、MCP stdio 服务、npx 安装器 |
| packages | src/packages/* | React 窗口、HUD 场景、组件、快照类型、Vite 配置 |

关键规则：core 不依赖 Tauri/React；OS 条件只出现在 platform 和 host；命名某个客户端的代码
必须在其 agents 文件夹内（pnpm run check:clients 强制）。

## 3. 扩展点总览（「插件」在 agent-hud-open 里的真实含义）

1. 客户端适配器（Agent 契约）：让 HUD 认识一个新 agent 客户端。每个客户端 = 一个 Agent 描述符
   （src/crates/agents/src/agent.rs）：id/name/sources(PerOs)/transcript/account/hooks/requests/replies，
   缺哪节 = 没那个能力。已注册清单在 src/crates/agents/src/lib.rs。全仓库 grep magpie 零匹配。
2. observer 插件脚本：写进客户端自己配置目录的小脚本，让客户端上报运行状态。例如
   agents/src/opencode/{observer.js,export.js}、platform/scripts/observers/{opencode.js,pi.ts}。
   OpenCode 1 和 2 加载同一脚本（magpie 兼容 OpenCode v1 插件形态，天然有桥）。
3. Claude Code 插件 / DeepSeek Harness 插件：Settings → Agent plugins 安装，提供审批/提问/回复/消息转发。
   DSH 插件 = crates/platform/src/deepseek_plugin/agent-hud.mjs + 在 $DSH_HOME/cordis.patch.yml 写一行加载。
4. ProductExtension：crates/host/src/extension.rs + @agent-hud/app/extension，产品宿主加页面/设置项，
   是 fork 级定制，不是运行时插件。
5. MCP 工具：内置（src/apps/mcp），hud 布局读写/截图、用量统计、agent 消息。

## 4. 新增一个客户端适配器的具体路径（以 magpie 为例）

1. 新建 src/crates/agents/src/magpie/：mod.rs（Agent 描述符 + PerOs sources）、transcript.rs（会话/token 解析）、
   account.rs（额度/余额，可选）、hooks.rs（可选）。
2. 在 src/crates/agents/src/lib.rs 加 pub mod magpie; 并接入注册表。
3. 按需：platform 侧原生通道 src/crates/platform/src/clients/<id>/；若 magpie 可加载 OpenCode v1 observer，
   可复用/仿写 opencode/observer.js。
4. pnpm run check 校验并生成 agent × OS × 行为支持表；补 fixtures 与测试（agents 是纯 Rust，fixture 测试跨 OS 跑）。

## 5. 与 magpie / magpie-plugin-pack 的关系

- F:/maple/magpie 是 yetone 的开源 Go 网关「Every agent's model. One place」：让 Claude Code 用 Kimi、
  Codex 用 DeepSeek……插件系统在 internal/plugin、internal/pluginrt、internal/agentplug，兼容 OpenCode v1 插件
  （config/auth/provider 三段）。有自己的 internal/sessions、internal/stats。
- F:/maple/magpie-plugin-pack（本目录）是给 magpie 的 OpenCode v1 插件包「鹊巢 magpie-nest」：
  plugins/magpie-nest/index.mjs 只导出 26 个插件函数，每个渠道在 lib/<id>/，test/pack-install.test.mjs 是装载回归。
  新增渠道 = lib 新目录 + 入口一行 export + 测试。
- 若做「magpie 上 HUD」，最可能路线是给 agent-hud-open 新增 magpie 客户端适配器（读 magpie 的
  sessions/stats 数据），并视情况让 magpie 加载 observer 脚本上报实时状态。

## 6. 新插件候选路径

- A. 给 Agent HUD 加 magpie 客户端支持（见第 4 节）。
- B. 给 magpie-nest 加第 26 个渠道插件（OpenCode v1 config/auth/provider；agent-hud-open 的
  ark/minimax/hermes/droid 等 account 读取实现可当协议参考）。
- C. 写一个新的 DeepSeek Harness 插件（参考 deepseek_plugin/agent-hud.mjs + cordis.patch.yml 形态）。
- D. 给 Agent HUD 加另一个新客户端（非 magpie）。

## 7. 待定决策

- 新插件方向（A/B/C/D 或其它）——由用户拍板。
