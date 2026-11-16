# 鹊楼 v4 方案：把每一条需求落到可验收的格子里

> 2026-11-13。依据：本轮之前全部对话需求 + 对 magpie / agent-hud-open 的源码研读 + 实测。
> 每一条都带**状态**与**证据**；状态只有四种：已实现 / 部分 / 未做 / 边界（宿主不支持）。

## 0. 先说结论：三个真正卡住闭环的问题

1. **数据源不够宽** —— 会话列表只有 4 个转录解析器（claude/codex/dsh/antigravity），
   而 magpie 支持 63 个 agent。宿主 `/api/sessions/*` 在 app 模式只存在于 wails 内部源，插件拿不到。
   → 结论：广度只能靠「已装检测（30 个位置）+ 账簿（覆盖全部 agent 的用量）」，
     会话明细只能逐个补解析器。这是**能力上限**，不是偷懒。
2. **审批不可为** —— magpie 给插件的 tool 钩子 ctx 只有 `{agent, abort, directory}`，没有审批应答接口。
   → 鹊楼能做「检测到在等你 + 把你带过去」，不能替你点允许。参考项目能做，是因为它自带 agent 宿主。
3. **呈现层一直在返工** —— 先是 WebView2（旧运行时崩溃），再换 GDI（只 Windows）。
   → 已定：**Windows GDI 为主，macOS/Linux 优雅降级；呈现逻辑与数据契约分离**，换后端不改业务。

## 1. 需求台账（逐条对账）

### A. MCP 工具能力

| # | 需求 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| A1 | `list_sessions` 跨 agent 列会话 | ✅ 已实现 | 4 个客户端解析器；带 `pending`（等你）识别 |
| A2 | `send_message` 投递 | ✅ 已实现 | 含 `replyTo` 线程映射 |
| A3 | `start_session` 起会话 | ✅ 已实现 | claude/codex 走自家 CLI |
| A4 | `get_message` 取回答 | ✅ 已实现 | 轮询兄弟会话输出 |
| A5 | `list_quotas` 厂商额度 | ✅ 已实现 | 15 provider / 21 账号 / 36 窗口 |

### B. magpie 页面（完整面板）

| # | 需求 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| B1 | 主题跟随 magpie | ✅ 已实现 | `/api/settings` 返回 `hostTheme`，读 `settings.json.theme` |
| B2 | 也能单独设置主题 | ✅ 已实现 | `theme: auto\|dark\|light`，设置页有分段控件 |
| B3 | 单独的设置页 | ✅ 已实现 | `magpie.panels` 的 `settings` 槽；`#focus=settings` 只显示设置 |
| B4 | 会话分页 | ✅ 已实现 | 20/页，实测「50 个 · 第 1/3 页」 |
| B5 | 会话搜索 | ✅ 已实现 | 150ms 防抖，匹配标题/项目/客户端 |
| B6 | 会话互动操作 | ✅ 已实现 | 行可点开详情抽屉，发消息/回复在抽屉里 |
| B7 | 布局不挤、自适应、不浪费空间 | ⚠️ 部分 | 有分区与分页，但仍是单列流；宽屏没用上两栏 |
| B8 | UI 美观 / 布局合理 / 交互友好 | ❌ 未做 | 需要一次系统性的视觉与交互重做（见 §4） |
| B9 | 产品闭环 | ⚠️ 部分 | 有「等你」提醒与跳转；缺「提醒 → 处置 → 回执」的完整回路 |

### C. 桌面 HUD

| # | 需求 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| C1 | 桌面可拖动 | ✅ 已实现 | GDI 版 `WM_NCHITTEST → HTCAPTION`，Windows 自己拖 |
| C2 | 不影响其它操作 | ⚠️ 部分 | 置顶常驻；缺点击穿透模式与自动收起 |
| C3 | 刘海屏 + 常规屏 | ✅ 已实现 | `notch` 贴物理顶 |
| C4 | 顶部形态更矮（80%） | ✅ 已实现 | 560×160（可再压到 120） |
| C5 | 左侧形态更窄（80%） | ✅ 已实现 | 240×520 |
| C6 | 显示不全可下拉/滚动 | ❌ 未做 | GDI 版没有滚动容器 |
| C7 | agent 过多可滑动/拖动/排序 | ❌ 未做 | 需要 HUD 内芯片 + Pointer 拖动 + 顺序落盘 |
| C8 | 只显示已安装/在跑的 agent | ✅ 已实现 | `lib/agents.mjs` 30 个位置检测，实测已装 6 |
| C9 | 状态提醒（等你） | ✅ 已实现 | 转录尾部 call 无 result → 「等你」徽标 + 排最前 |
| C10 | agent 状态监控 | ⚠️ 部分 | 在跑/等你/装了未活动；缺「历史活动与最近一次动作」 |
| C11 | 互动 / 回复（HUD 内） | ❌ 未做 | HUD 只读；回复仍要开面板 |
| C12 | 审批 | 🚫 边界 | 宿主无插件审批接口（见 §0.2） |
| C13 | 不自动乱跳 | ✅ 已实现 | 目标制位置跟踪 + 冷却 + 阈值 |
| C14 | 无白边 | ✅ 已实现 | GDI 逐像素 alpha；实测四角与中心同色 |
| C15 | 托盘 / 最小化到右下角 | ⚠️ 部分 | GDI 版有 `Shell_NotifyIcon`，菜单项未一一验证 |

### D. 平台与依赖

| # | 需求 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| D1 | magpie 支持的 agent 都要支持 | ⚠️ 部分 | 已装判定 30 个位置；账簿覆盖全部（用量/花费）；会话明细 4 个 |
| D2 | 用户安装不允许有依赖问题 | ✅ 已实现 | GDI 零浏览器依赖；失败落标记静默跳过；`enabled:false` 持久关闭 |
| D3 | macOS 支持 | ❌ 未做 | 源码已按 build tag 隔离，mac 上 `os.Exit(0)` 优雅降级；需 AppKit 后端（cgo，Mac 上构建） |

## 2. 架构（为什么这样切）

```
┌─ 数据层（平台无关，纯 Node）────────────────────────────┐
│ 宿主账簿 usage.jsonl / quotas.json / settings.json        │  ← 覆盖全部 63 个 agent 的用量
│ 本机转录 4 个解析器（claude/codex/dsh/antigravity）        │  ← 会话明细
│ 已装检测 lib/agents.mjs（30 个位置）                       │  ← 广度与「是否装了」
└──────────────────────┬──────────────────────────────────┘
                       │ 统一契约：/api/{state,tokens,quotas,sessions,settings,agents,…}
┌──────────────────────┴──────────────────────────────────┐
│ 呈现层 A：magpie 页面（HTML/CSS/JS，跨平台）              │  ← 全部重交互
│ 呈现层 B：桌面 HUD                                          │
│   Windows → GDI 原生（零依赖）                              │
│   macOS/Linux → 待实现；暂降级为「无 HUD」                   │
└─────────────────────────────────────────────────────────┘
```

**三条硬规则（写进代码，不靠自觉）**
1. 呈现层不许直接读文件——只认 `/api/*`。这样换后端（GDI/AppKit/WebView）不改业务。
2. 任何后端起不来都必须**静默降级**，页面永远可用（已由 `.failed` 标记 + `enabled` 开关实现）。
3. 「已装/在用」这类事实一律走**磁盘探测**，不猜、不从 provider 名单推断。

## 3. 分阶段计划（每阶段都能独立验收）

### P0 · 冻结与收口（0.5 天）
- 关闭 HUD 的持久开关已验证（`enabled:false`，重启不复活）
- 需求台账进仓库，此后每个 PR 必须更新状态列
- **验收**：`node scripts\test-all.mjs` 全绿；台账状态与代码一致

### P1 · 页面重做（3 天，最高优先）
目标：解决「挤、浪费空间、不美观、交互不友好」。
- **信息架构**：顶栏（4 个瓦片：最紧额度 / 今日花费 / 在跑 / 等你）→ 主区**左右两栏**
  （左：额度按 provider 折叠 + 掉速；右：会话搜索+分页+列表）→ 右下滑出详情抽屉
- **响应式**：≥1100px 两栏；700–1100px 单栏但瓦片横排；<700px 全单列
- **密度**：正文 13px / 辅助 11px / 列表行 32px / 卡片间距 10px（现状行高与间距混用导致「挤」）
- **状态闭环**：会话行三态（在跑 / 等你 / 空闲）+ 「等你」置顶 + 点击直达 + 处置回执（toast）
- **空态/加载态/错误态**三态齐全，不再出现「一片空白」
- **验收**：三个断点截图 + 与 magpie 同主题的一致性检查；列表 50 条时首屏无滚动抖动

### P2 · HUD 内交互（2 天）
- **滚动**：内容超出时 HUD 内部纵向滚动（GDI 用滚动偏移 + 滚轮消息）
- **agent 芯片拖动排序**：芯片横排，按住拖动改变顺序，debounce 300ms 落盘 `hudAgents[]`
- **溢出**：芯片超过宽度时横向滚动（不用换行，保持条状）
- **点击语义**：单击芯片 = 过滤到该 agent；双击 = 打开完整面板
- **验收**：顺序重启后保持；10 个芯片时仍不挤；拖动不误触点击

### P3 · 状态监控补全（2 天）
- 每个 agent：`状态 / 最近活动时间 / 最近一次动作摘要 / 是否在等我`
- 「最近活动」来自文件 mtime（已装检测已有）+ 会话 mtime（已有）
- HUD 顶部一行轮播「最需要你关注的那一条」，点击跳到面板
- **验收**：30 个 agent 中已装的 6 个都有准确活动时间；未安装的完全不出现

### P4 · HUD 互动与回复（3 天）
- HUD 内可**发消息**：点「等你」条目 → 输入框（原生 GDI 文本框）→ 走 `/api/send`
- 回复到达 → HUD 右下角气泡 + 托盘提示
- 审批：**只做到「检测 + 带你过去」**，并在 UI 明确写「需要在该 agent 客户端里批准」
- **验收**：从 HUD 发一条消息，对方会话收到回执；审批场景能准确跳到对应会话

### P5 · 托盘与轻量常驻（1 天）
- 托盘菜单：显示/隐藏、打开面板、**点击穿透模式**、退出
- 点击穿透：`WS_EX_TRANSPARENT` 切换，解决「HUD 挡住其它操作」
- 自动收起：全屏应用前台时自动隐藏，退出全屏恢复
- **验收**：穿透模式下点击直达桌面/应用；全屏视频时 HUD 自动隐藏

### P6 · macOS 后端（5 天，需 Mac 构建机）
- `main_darwin.go`：`NSWindow`/`NSPanel`（`nonactivating` + `NSFloatingWindowLevel`）、
  `NSView.drawRect` + CoreGraphics 绘制、`NSAttributedString` 文字、`NSStatusItem` 托盘
- 需要 cgo，只能在 Mac 上构建 → **预编译产物分发**（`bin/darwin-arm64/magpie-hud-native`）
- **降级**：没有该产物时 macOS 用户只少一个 HUD，页面与工具不受影响（现状已如此）
- **验收**：M 系列 Mac 上 HUD 不抢焦点、可拖动、托盘可用

### P7 · 会话解析器扩展（按需，每个 0.5 天）
优先级按本机实际安装：opencode → gemini → kimi → qwen → cursor → copilot → crush → cline …
每加一个：解析器 + 固定样例单测 + 台账更新。**没有样例数据不写解析器**（不猜格式）。

## 4. UI 重做的具体决定（美术/前端视角）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 网格 | 12 列 / 间距 10px / 安全边 16px | 现在元素贴边导致「挤」 |
| 层级 | 只有三级：瓦片 > 卡片 > 行 | 现状四层嵌套，视觉噪音 |
| 颜色 | 沿用 magpie 的 `--magpie-*`，缺省 `#282828 / #F5F5F7 / #98989D` | 与宿主一致 |
| 强调色 | 单一强调色（青绿 `#32D583`）+ 语义色（警告 `#FF9F0A` / 危险 `#FF453A`） | 现在颜色太多 |
| 字号 | 13 / 11 / 10 三档 | 现状 4–5 档混乱 |
| 圆角 | 卡片 10px、芯片 999px | 与 magpie 卡片一致 |
| 动效 | 只做「状态变化」与「抽屉」，≤180ms，`prefers-reduced-motion` 全关 | 之前无限动画导致截图超时 |

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| GDI 手写界面迭代慢、易错 | 先把「布局参数化」（尺寸/间距/字号集中在一处），再谈视觉 |
| 会话解析器扩展无穷无尽 | 只做本机装了的；每加一个有样例与单测 |
| HUD 与面板两套 UI 重复 | HUD 只做「一眼 + 一击」，重交互一律回面板 |
| 用户机器环境差异（磁盘/权限） | 所有写盘失败都静默降级；`.failed` 标记 + `enabled` 开关 |
| macOS 无法在本机验证 | 交付预编译产物 + 明确标注「未在真机验证」 |

## 6. 边界（写清楚，不假装）
- **审批**：不可为，只能检测与跳转。
- **63 个 agent 全量会话明细**：不可为（宿主未开放 API），只能逐个补解析器 + 账簿覆盖用量。
- **macOS**：未在真机验证前，一律标注「实验」。
## 7. Rust 可行性验证（2026-11-13，实测已通）

用户问「能不能用 Rust 做」。结论：**能，且已在本机端到端验证**。

### 实测通过的东西

| 项 | 结果 |
| --- | --- |
| 工具链 | `rustc 1.99.1` / `1.85.0` / `1.83.0`，目标 `x86_64-pc-windows-gnu`，**不需 MSVC**（自带 mingw 链接器） |
| 安装位置 | `RUSTUP_HOME=F:\rust\rustup`、`CARGO_HOME=F:\rust\cargo`（**不占 C 盘**） |
| crate 源 | rsproxy 稀疏索引（国内直连 rust-lang 会卡在 54MB/5min） |
| GUI 构建 | `winit 0.29` + `windows-sys 0.48` 编译通过，产物 **423 KB** |
| 运行 | 打出 `window created`，无边框/透明/置顶窗口创建成功 |

### 踩到的坑（重要，写进构建说明）

1. **rust-lang 直连太慢**：`RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static` 后从 5 分钟卡 54MB 变成秒级。
2. **`windows-sys 0.61` 在这套 binutils 上编不过**：rustc 走 raw-dylib 生成 `kernel32.dll_imports.lib`，
   调用 `dlltool --temp-prefix kernel32.dll:`（带冒号）失败，报 `CreateProcess`。
   → 已验证 1.83/1.85/1.99 三个版本都复现；**换成 `winit 0.29`（依赖 `windows-sys 0.48`）即通过**。
3. **`dlltool.exe` 在工具链内部**：`.../lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained`，需加入 PATH。
4. `winit 0.29` 与 `0.30` API 不同：`0.29` 用 `EventLoop::run(|event, elwt|)`，
   无 `ApplicationHandler`/`ActiveEventLoop`；置顶用 `.with_window_level(WindowLevel::AlwaysOnTop)`；
   改尺寸用 `request_inner_size`（不是 `set_inner_size`）。

### Rust 能带来什么 / 不能带来什么

**能**：
- 一套代码覆盖 Windows / macOS / Linux（winit 窗口 + softbuffer/tiny-skia 软渲染，无浏览器引擎）
- 拖动用 `window.drag_window()`，**跨平台**，不用 WM_NCHITTEST 技巧
- 托盘用 `tray-icon` crate；macOS 的 nonactivating 面板可直接用 `objc2`（参考项目已证明可行）
- 单文件几百 KB，比 Go GDI 版（5.4MB）还小

**不能**：
- **macOS 二进制仍然需要 Mac 或 CI 构建**（Rust 不解决交叉链接 macOS SDK 的问题）。
  参考项目也是靠 CI 出各平台产物——这才是标准答案。
- **magpie 插件本体只能是 JS**（宿主是 Bun）：MCP 工具与页面无法用 Rust 替换。
  Rust 只替换「桌面 HUD」这一个可执行文件。

### 因此建议

| 层 | 语言 | 理由 |
| --- | --- | --- |
| 插件本体（MCP 工具 / 页面 / 数据层） | **JS（现状）** | 宿主是 Bun，无选择 |
| 桌面 HUD | **Rust（新）** | 一套代码三平台；Go GDI 作为 Windows 兜底保留到 Rust 版对齐 |

迁移方式：`desktop-native/`（Go）保持可用不动；新增 `desktop-rust/`，插件按
「Rust 产物存在 → 用 Rust；否则回落到 Go」的顺序选择。这样任何一步失败都不会影响用户。
## 8. Rust HUD 第一版落地（2026-11-13）

`plugins/magpie-hud/desktop-rust/`（winit 0.29 + softbuffer 0.4.4 + fontdue 0.9 + serde_json）

**已完成并实测**：
- 窗口：560×160、无边框、置顶、跳过任务栏；实测位置 `(680,10)`、`topmost=True`
- 绘制：手写 2D（`src/draw.rs`）——圆角矩形、环（轨道 + 进度弧）、文本 alpha 混合
- 像素验证：面板 `dark=22146`、文字 `light=24`；环为 0 是因为服务未起、无额度数据
- 拖动：`window.drag_window()`（跨平台 API，无需 WM_NCHITTEST）
- 数据：`src/data.rs` 取 `/api/state`、`/api/quotas`、`/api/tokens?period=24h`，8 秒刷新
- 二进制 **610 KB**（Go GDI 版 5.4 MB）
- 插件已改为 `desktop-rust → desktop-native` 优先级；70 个单测全绿

**踩坑（都写进 build.cmd 了）**：
1. `softbuffer 0.4.7+` 拉 `windows-sys 0.61` → raw-dylib → `dlltool --temp-prefix kernel32.dll:` 失败。
   钉到 `softbuffer 0.4.4`（`windows-sys 0.52`）通过。
2. `surface.resize()` 必须在 `buffer_mut()` 之前，否则 panic。
3. `Context/Surface` 要拿 `Rc<Window>` 的克隆，否则与事件闭包互相借用锁死。
4. winit 0.29 与 0.30 API 差异大：`EventLoop::run(|event, elwt|)`、`KeyEvent` + `NamedKey`、
   `request_inner_size`、`WindowLevel::AlwaysOnTop`。

**未完成（下一批）**：
- 托盘（`tray-icon` crate）与右键菜单
- 位置/尺寸跟 `hud-settings.json`（现在硬编码 560×160 + 固定位置）
- 与真实数据的端到端截图验证（本次 magpie 插件 host 未加载完，`/api` 不可用）
- 多显示器选择、agent 芯片滚动/拖动排序
## 9. Rust HUD 第二批（2026-11-13）

在 v1（能出窗口）基础上补齐：

| 项 | 实现 | 验收 |
| --- | --- | --- |
| 设置驱动几何 | `src/settings.rs`：每 2 秒拉 `/api/settings`，变了就 `set_outer_position` + `request_inner_size` | 顶部 `(680,10) 560×160`；贴左 `(10,280) 240×520`；刘海 `(680,0) 560×140` 全部实测 |
| 右键菜单 | `src/menu.rs` 自绘（4 项），命中判定与绘制共用同一 `rect()` | 菜单区像素精确 `rgb(58,58,60)` |
| 打开面板 | `src/open_url.rs`：`cmd /c start` / `open` / `xdg-open` | 无额外依赖 |
| 托盘 | `src/tray.rs`：`tray-icon 0.19`，图标代码生成（32×32 深色圆角+青绿点） | 依赖可编译（windows-sys 0.59），进程 12 秒稳定 |

**为什么自绘菜单而不是 muda**：muda 也会拉一套 windows-sys；自绘零风险且外观同源。
托盘必须用 crate（`Shell_NotifyIcon` 需要独立消息窗），已验证 0.19 可用。

**验收方式**：用本地 mock 服务（`node mock.mjs`，端口 3478）喂固定数据——含 3 个 ≥90% 的
provider，从而能在像素层面确认「红环真的画出来了」。这比只截一张图更硬。

**仍未做**：多显示器选择、agent 芯片滚动/拖动排序、HUD 内发消息、macOS 构建产物。
## 10. Rust HUD 第三批：agent 芯片 / 滚动 / 拖动排序（2026-11-13）

用户要求「agent 过多可滑动、可拖动、可排序」，本批落实：

| 能力 | 实现 | 验收 |
| --- | --- | --- |
| 芯片列表 | `src/chips.rs`：只列 `/api/agents` 里 `installed:true` 的 | 8 个已装 → 3 行可见（78px 区） |
| 状态点语义 | 用 `/api/state` 的会话状态推导：等你 > 在跑 > 装了有活动 > 装了没动 | 像素：绿 16 / **琥珀 12** / 灰 38 |
| 滚动 | 滚轮 + `clamp`，溢出时上下画细线提示 | 单测：8 个芯片最大滚动 5，越界夹紧 |
| 拖动排序 | 左键按住芯片 → 上下拖 → 松手改序 | `--selftest-reorder`：8 个反序 → `saved=true` |
| 顺序持久化 | 写回 `hudAgents`（插件设置新增字段，去重/限长 24） | `--print-chips`：`saved` 与 `applied` 完全一致 |

**踩到的坑**：
1. 芯片区一开始只有 64px → 只显示 2 行，第三个芯片（常是「等你」那个）看不见。加高到 78px = 3 行。
2. 状态点最初全灰：只按 `active` 映射。改为**由会话状态推导**才有绿/琥珀。
3. Rust 写 `hudAgents` 但插件设置模式没这个字段 → 会被静默丢弃。已补（含去重/限长/非法值过滤）。

**测试**：Rust 单测 10 个（布局/命中/滚动/排序/空数据不 panic）+ 插件 71 个，全绿。

**仍未做**：多显示器选择、HUD 内发消息、macOS 构建产物。
## 11. Rust HUD 第四批：多显示器 + 芯片直达（2026-11-13）

| 能力 | 实现 | 验收 |
| --- | --- | --- |
| 多显示器上报 | 启动时把 `available_monitors()` POST 到 `/api/display` | mock 收到 `[{"id":"\\\\.\\DISPLAY1","primary":true,"width":1920,"height":1080}]` |
| 按设置选屏 | `settings.screen` 命中就用那块屏，否则当前屏→主屏 | 代码路径 + 单测覆盖几何计算 |
| 芯片点击直达会话 | 位移 ≤5px 算点击（否则算拖动）；带着该 agent「等你」的会话 id 打开 `?session=` | 浏览器实测：`?session=s1` → 弹出「深链验证会话」 |
| 深链健壮性 | 深链处理挪到 `finally`：任一接口失败也不影响 | 实测：`/api/history` 仍 500 时深链**照样生效** |

**顺带发现并修掉的产品缺陷**：原来深链写在 `refresh()` 的 try 里，任何一个接口 500 就会让
「从 HUD 跳过来」整条链路失效。挪到 `finally` 后与刷新结果解耦。

**验证基建**：写了 `serve-page.mjs`（stub 引擎独立拉起页服务，端口 3479），
这样即使 magpie 插件 host 起不来，页面侧仍能做端到端验证。
## 12. P1 页面重做 + macOS 通道 + HUD 内回复（2026-11-13，本轮全部落地）

### P1 页面重做
- 两栏布局（≥1100px），窄屏单列；实测左栏 x=18、右栏 x=613
- 4 块总览瓦片：最紧额度 128% / 24h 花费 $101.41 / 在跑 1 / 等你 0（stub 数据实测）
- 字号三档 token、首屏骨架、静态 `no-store`

### 顺带修掉三个真缺陷（都是「页面会整块挂」级别）
1. 单个分区渲染抛错 → 整页停摆。改为逐分区 `safe()` 隔离。
2. `tokens.buckets` / `tokens.totals` 未守卫：引擎扫描未完成时缺字段就抛错。
3. 静态文件无 `no-store`：插件更新后用户可能仍看到旧界面。

### macOS / Linux 通道
- `cargo check` 三目标全通过：`x86_64-pc-windows-gnu`、`aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-unknown-linux-gnu`
- **托盘限定 Windows/macOS**：Linux 上 tray-icon 需要 GTK 开发包（会成为用户系统依赖），
  所以 Linux 无托盘；对应地「隐藏」在无托盘平台退化为「退出」，不会把用户锁在外面
- `.github/workflows/hud-native.yml`：推 `hud-v*` tag 出四平台产物（macOS 必须在 macOS runner 上链接）
- `desktop-rust/BUILD.md`：完整构建说明与版本钉子（winit 0.29 / softbuffer=0.4.4）

### HUD 内回复
- `src/reply.rs`：自绘输入框 + `WindowEvent::Ime::Commit`（中文走系统输入法）+ `KeyEvent.text`（英文）
- 点「等你」芯片 → 就地输入 → Enter 发送（`POST /api/send`），Esc 取消
- **验证**：`--selftest-reply` → `to=s1 text=收到，马上处理 sent=true`，mock 收到完全一致的 JSON
- IME 本身无法程序化模拟，需真人按键验证（已在文档标注）

### 测试
Rust 14 个单测 + 插件 71 个测试，全绿。产物 788 KB。