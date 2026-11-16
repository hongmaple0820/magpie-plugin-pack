# 鹊楼 (magpie-hud)

本机 AI coding agent 的桌面 HUD，一个插件两半：给人看的面板 + 给 agent 用的五个 MCP 工具。数据引擎（会话扫描 / journal / 额度读取）在本插件自己的 lib 里，两半共用；引擎加载失败（通常是 fzstd 依赖损坏）只降级面板（API 返回 requires），工具半照常返回。

## 工具半（给 agent）

五个 MCP 工具经 magpie 的插件工具 MCP 服务器（internal/gateway/tools_mcp.go，/mcp/magpie/tools）对所有能接 MCP 的 agent 可用：list_sessions / send_message / start_session / get_message / list_quotas。共享服务器上带 magpie-hud_ 前缀，插件专属服务器上是裸名。语义照 Agent HUD（F:/maple/agent-hud-open，仅参考不修改）的 messaging crate。

## 面板半（给人看）

界面按参考产品 Agent HUD 的设计语言重做（方案见 `docs/magpie-hud-design.md`）：深色优先、半透明卡片、
12/10/7 圆角、13px 正文、tabular-nums 数字；宿主注入 `--magpie-*` 时跟随 magpie 主题。

- **额度**：每客户端一张卡 = 同心环（最满窗口的百分比在环心）+ 账户与套餐徽标 + 每窗口一条
  （名字 / 百分比 / 重置倒计时 / 进度条，按 70%·90% 分级着色）+ 24h 走势 sparkline + 烧录率与满额倒计时。
  读不到的客户端给一句人话（未登录 / API key 无套餐 / 失败原因），不吞。
- **用量**：24h / 7d / 30d 三档，柱状图（输入 / 输出分色）+ 合计、缓存读、**花费**、各客户端小计、按模型明细（带金额）。
  数据优先级：**magpie 的请求账簿**（`~/.config/magpie/usage.jsonl`，纯 JSONL 秒读、上游回报的真 token、带真实
  provider/model）→ 没有账簿才回落到转录扫描（DSH 驼峰 `inputTokens` / Claude 蛇形 `input_tokens` /
  Codex `token_count`；155 个 DSH 转录 124MB，zstd 单文件解压 1–34 秒，所以只处理窗口内文件、单文件超 2MB
  跳过并报 `skipped`、解析结果按 (mtime,size) 落盘缓存、文件间让出事件循环）。
  花费 = 账簿里每行的 `in/out/cache_read` × `~/.cache/magpie/models.json`（models.dev 目录，8988 个模型）
  的每百万 token 单价；**对不上价的请求单列 `unpriced` 并从金额里排除**，不假装完整。转录来源没有
  provider/model，cost 直接为 `null`——不编造。
- **会话**：客户端色标与字标、标题、项目目录、状态 pill（在跑 / 空闲 / 闲置）、Claude+Codex 行的「发消息」。
- **消息**：`from → to`、状态 pill、相对时间、指纹短码。
- **提醒**：消息到终态时右下角弹卡片（done 带答案摘要），15 秒自动收；首轮只建基线不轰炸历史。

### 两种显示上下文

- **页面**（侧栏「鹊楼」）：frame 填满窗口，`page/index.html` 经桥拿 `magpie.service` 后导航到本地服务。
- **面板**（magpie 的 Agents / Usage 页内嵌）：frame 初始只有 48px，服务页检测到被嵌入后
  经 `ResizeObserver` 主动 `postMessage` 高度撑开（magpie 的 `pluginpages.js` 只校验
  `ev.source === frame.contentWindow`，不校验 origin；上限 `PANEL_MAX = 2400`）。
  两个槽各有自己的入口页（`page/panel-agents.html` / `page/panel-usage.html`），loader 用
  `#focus=agents|usage` 告诉服务页先排哪段：agents 槽按 会话 → 额度 → 用量 → 消息，
  usage 槽按 额度 → 用量 → 会话 → 消息。面板内内容限高 620px 内滚，不长成 3000px。

### 接口

| 接口 | 用途 | 缓存 |
| --- | --- | --- |
| `GET /api/state` | 会话 + journal | 60s TTL + 启动预热 |
| `GET /api/quotas` | 厂商额度 | 60s |
| `GET /api/history` | 时序 + 烧录率 | 读落盘 |
| `POST /api/send` | 面板发消息（human 旗标服务端定死） | — |
| `GET /api/message?id=` | 消息状态与答案 | — |

前端零依赖、零构建：`app.js` 为 ESM，提醒判定抽成纯函数 `webapp/notify.mjs`（有单测）。
分区渲染带内容 key，未变则跳过 DOM 重建，30 秒轮询不闪。

## 桌面 HUD 桥（系统级）

magpie 的插件只有「页面」和「面板」两个呈现位，都**不能常驻桌面**（`internal/gui/panelside.go` 只管快捷面板
往哪边开，`trayusage*` 是 magpie 自己的托盘能力，插件伸不进去）。所以真正的系统级 HUD 是一个独立原生窗口：

- `desktop/` 是 Go + wails v3 的小程序（**Windows 上不需要 cgo**，与 magpie 共用同一套 WebView2；
  本机实测 CGO_ENABLED=0、无 gcc/cl 也能构建），产物 9.2MB 单文件、无运行时依赖。
- 它只做一件事：开一个无边框、置顶、半透明的窗口加载本插件服务页的 `?hud=1`。数据与交互全在插件里，
  桥只提供「常驻桌面」这个宿主给不了的能力。
- **装插件即自动拉起**：插件装载后若 `desktop/magpie-hud-desktop[.exe]` 在，就 spawn 它并指向当前端口；
  `MAGPIE_HUD_DESKTOP=0` 或插件 option `{"desktop": false}` 可关。拉不起来只记一行日志，不拦插件装载。
- **可拖动、可吸附、会记住**：拖它就走，松手后桥在两拍内把位置 POST 回设置，存成 `position: "custom"`；
  在插件页面改吸附位置（顶部居中 / 左上 / 右上 / 贴左 / 贴右），桥 1.5 秒内自动挪过去。
  实测：`top-center` → (780,12)（(1920−360)/2、工作区顶 +12）；`left` → (12,410)（垂直居中）；
  拖到 (640,520) → 设置自动变 `{position:"custom", x:640, y:520}`。
- **刘海屏**：`notch` 开启后窗口贴到屏幕物理顶部（不吃工作区间距），页面同时把卡片顶部改成直角、底部圆角。
- **多显示器**：桥枚举屏幕并把清单 POST 到 `/api/display`（`{screens:[{id,name,width,height,primary}], current}`），
  页面据此渲染选择器（只有一块屏时自动隐藏）；设置里的 `screen` 存显示器 ID（`""` = 主屏），桥按它 `GetByID` 选屏。
- **动效**：HUD 是常驻窗口，所以有「活」的感觉——额度环的呼吸光晕（rAF 驱动 `--glow`）、数字缓动（450ms ease-out）、
  在跑会话的脉冲点、卡片淡入。三条纪律：尊重 `prefers-reduced-motion`；`?anim=0` 一键关（截图与自动化验证用）；
  页面不可见时停 rAF。
- 编译：`cd desktop && go build -tags production -ldflags "-s -w" -o magpie-hud-desktop.exe .`
- HUD 视图：每个客户端最满的额度环 + 今日花费 / token / 请求数 + 「N 个会话 · M 个在跑」；
  头部可拖拽（wails 的 `--wails-draggable: drag`），右上角 ⤢ 切到完整面板。

## 设置（插件页面里改，即时生效）

页面顶部「桌面 HUD 设置」一节，写 `<home>/.magpie-agents/hud-settings.json`（原子整写，坏值一律回默认）：

| 设置 | 取值 | 谁消费 |
| --- | --- | --- |
| 吸附位置 | top-center / top-left / top-right / left / right / custom | 桌面桥定窗口坐标 |
| 透明度 | 40%–100% | 页面 CSS（`--hud-alpha`） |
| 尺寸 | 小 300×180 / 中 360×220 / 大 440×280 | 桌面桥 SetSize |
| 刘海模式 | 开/关 | 桥贴顶 + 页面圆角 |
| 总在最前 | 开/关 | 桥 SetAlwaysOnTop |
| 显示分区 | 额度/用量/会话/消息 | 页面隐藏对应 section |

一份设置两个消费者（桥读窗口几何、页面读外观），避免「窗口在左边、页面以为在顶部」的错位。

## agent 支持面（30 个已知 / 已装自动判定）

- `lib/agents.mjs` 维护 **30 个 agent 的数据目录表**（claude、codex、dsh、gemini、cursor、opencode、
  copilot、cline、kimi、qwen、zed、crush、goose、continue、aider、amp、kiro、trae、qoder、windsurf…）。
- **已安装 = 数据目录存在；活跃 = 目录内有 7 天内文件**。实测本机：已知 30、已装 6、活跃 5。
- 会话列表默认按「已装」过滤——**没装的 agent 不会出现在 HUD/面板里**（用户明确要求）。
- 边界：已装 ≠ 可交互。能列会话与能发消息的仍是 claude / codex / dsh / antigravity 四种转录解析器；
  其余 agent 只做到「知道你装了」与「账簿里有它的用量」。

## 桌面 HUD：原生 GDI 实现（零浏览器依赖）

`desktop-native/` 是**纯 Go + Win32 GDI** 的 HUD，**不依赖 WebView2 / 任何浏览器引擎**：

- 单文件 5.4MB，`CGO_ENABLED=0`，无第三方 Go 依赖（只用标准库 `syscall` 调 user32/gdi32/shell32）
- 分层窗口（`UpdateLayeredWindow`）逐像素 alpha → **真透明 + 圆角**，没有 WebView2 的磨砂白边问题
- `WM_NCHITTEST` 返回 `HTCAPTION` → **顶部 34px 原生拖动**，不需要任何前端运行时
- 右键菜单（打开完整面板 / 隐藏 / 刷新 / 退出）、托盘图标（`Shell_NotifyIcon`）、Esc 隐藏
- 数据只读插件服务的 `/api/state`、`/api/quotas`、`/api/tokens`、`/api/settings`，每 8 秒刷新
- 位置与尺寸跟设置走：顶边 560×160 / 左侧 240×520 / 刘海 560×140 / custom 用存的 x,y

**实测**：插件装载即自动拉起，窗口 `(680,10) 560×160`，`layered=True topmost=True`；
像素直方图确认面板 20579 深色像素、文字 301 亮像素、额度环 319 红 + 44 绿——确实画出来了。

**旧实现**：`desktop/`（Go + wails/WebView2）保留但**不再自动拉起**——它在旧 WebView2 运行时上会
`CreateCoreWebView2Controller` 失败（0x8000FFFF），正是用户要求里不允许的依赖。

## 平台支持矩阵

| 平台 | 桌面 HUD | 页面/工具 | 说明 |
| --- | --- | --- | --- |
| Windows | ✅ 原生 GDI（`desktop-native/`，零浏览器依赖） | ✅ | 全部功能 |
| macOS | ⏳ 待实现（`main_other.go` 以 0 退出，插件自动跳过） | ✅ | 页面与 MCP 工具照常可用 |
| Linux | ⏳ 同上 | ✅ | 同上 |

源码已按**构建标签**隔离：`main_windows.go`（user32/gdi32）与 `main_other.go`（占位）。
实测交叉编译：windows/amd64、darwin/arm64、darwin/amd64、linux/amd64 **全部编译通过**——
Windows 代码没有泄漏到其它平台。

### macOS 要做什么（路线已定）

参照 agent-hud-open（Rust + Tauri，`objc2`/`objc2-app-kit`，并为 macOS 的 nonactivating `NSPanel`
fork 了 `tao`，见其 `docs/tao-panel-patch.md`）。我们的 Go 对等物是一一对应的：

| Windows（已实现） | macOS（待实现） |
| --- | --- |
| `CreateWindowExW` + `WS_EX_LAYERED/TOPMOST/TOOLWINDOW` | `NSWindow`/`NSPanel`，`NSFloatingWindowLevel`、`nonactivating`、`setOpaque(false)`、`setBackgroundColor(clear)` |
| `UpdateLayeredWindow` 逐像素 alpha | `NSView.drawRect` + CoreGraphics（`CGContextSetAlpha`、路径裁剪圆角） |
| `DrawTextW` + `CreateFontW` | `NSAttributedString` + `NSFont` |
| `WM_NCHITTEST → HTCAPTION` 拖动 | `setMovableByWindowBackground:YES` 或 `performWindowDragWithEvent:` |
| `Shell_NotifyIcon` 托盘 | `NSStatusItem` + `NSMenu` |
| 纯 `syscall`（无 cgo） | **必须 cgo**（objc_msgSend），因此只能在 Mac 上构建 |

> 结论：跨平台从来不是一份代码通吃，而是「同一份数据与绘制意图 + 每平台一个原生后端」。
> 这正是 agent-hud-open 的做法（Tauri 提供跨平台窗口 + 每 OS 一段 objc2/Win32 代码）。

## 失败安全（用户安装不允许有依赖问题）

- 桌面桥若因环境起不来（如 WebView2 版本过旧），**第一次失败即落标记 `.desktop-failed`**，之后启动直接跳过、不刷屏；
  删掉该文件（或 `MAGPIE_HUD_DESKTOP_RETRY=1`）可重试。
- 产品的**页面部分完全不依赖 WebView2**：`magpie plugin add` 之后不装桥也能用全部功能。

## 桌面 HUD 的实现：窗口外壳 + 真页面

| 实现 | 目录 | 状态 | 说明 |
| --- | --- | --- | --- |
| **Rust + WebView2**（tao 0.37 + wry 0.57） | `desktop-rust/` | 可用（v2，2026-11-16 重做） | 窗口外壳只负责摆位/拖动/改高；界面是 `webapp/hud.html`，跟面板同一套 token |
| Go（Win32 GDI） | `desktop-native/` | 可用（v1 兜底） | Windows 兜底，手绘；不支持审批、也不跟页面同源 |
| Go + wails/WebView2 | `desktop/` | 停用 | 旧运行时上会 `0x8000FFFF` 崩溃 |

插件按 `desktop-rust → desktop-native` 顺序选二进制；都缺就静默跳过，页面功能不受影响。

**为什么换掉手绘 canvas**：canvas 的 CJK 字形天生发虚，而且审批、展开列表、点会话跳转这些
交互在手绘里要一件件重写。现在 HUD 直接加载插件自己的页面，清晰度由系统文字栈保证，
交互和面板共用 `/api/*`。

### HUD 形态与交互（2026-11-16 实测）

| 能力 | 实现 | 证据 |
| --- | --- | --- |
| 一条 52px 状态栏 | 在跑数 · 客户端简称（DSH 50）· 待批数 · 24h token · 24h 成本 · 最满额度环 · 展开 | 真机 `window 576x62 / client 560x54`，文字锐利（`corpus/hud-webview.png`） |
| 展开面板 | 双击状态栏或点 `⌄`：在跑会话（点一行跳面板定位）、待批审批的「批准/拒绝」、汇总、打开完整面板 | 点击后页面报 180px → 窗口 `576x189`（`corpus/hud-expanded-webview.png`） |
| 窗口高度跟内容 | 页面量自己的高度发 `{cmd:"resize"}`，外壳 clamp 40–900 后改窗；设置里的 `height` 只是初始值 | 展开/收起各一次实测 |
| 拖动 | 按住状态栏（按钮除外）→ 外壳 `drag_window()`；停稳 600ms 后把落点写回 `/api/settings`（`position=custom`） | 拖 −120/+80 → 设置变 `x=280 y=380` |
| 位置设置 | 设置页改位置/显示器/刘海 → 外壳每 2 秒跟 `/api/settings`，变更即重新摆位 | `POST x=400 y=300` → 2 秒内窗口落到 `400,300` |
| 刘海 / 多屏 | 摆位按显示器逻辑矩形 + 工作区算（125%/150% 缩放有单测）；刘海=贴物理顶 | `cargo test` 的 placement 组 |
| 点击穿透 | 托盘菜单「点击穿透（开 / 关）」切 `WS_EX_TRANSPARENT`，再点一次恢复 | `--selftest-clickthrough` → `正常点击=true 穿透=true 恢复=true` |
| 全屏/演示自动收起 | `SHQueryUserNotificationState` 判定，退出后自动回来 | 沿用旧外壳逻辑（未在本轮重测） |
| 托盘 | 显示/隐藏、打开面板、点击穿透、退出 | `tray-icon 0.19` |
| 单实例 | 命名互斥；第二个实例把已有窗口叫到前面后退出 | 沿用旧外壳逻辑 |

**没做/没验的**：HUD 上的芯片拖动排序随 canvas 一起删除了（顺序改回设置页）；
审批按钮因为当场没有待批项，真机上还没点过；125%/150% 与多屏只有单测覆盖，本机是 100% 单屏。

### P1 页面重做（2026-11-13，面板本身）

| 项 | 做法 |
| --- | --- |
| 布局 | ≥1100px **两栏**（左：额度/用量/按 provider；右：会话/消息），窄屏自动单列；实测左右栏 x=18 / x=613 |
| 总览瓦片 | 4 块：最紧额度 / 24h 花费 / 在跑 / 等你；点它滚到对应分区 |
| 字号 | 收成三档 token（13/11/10），此前 4~5 档混用是「乱」的主因 |
| 首屏 | 骨架占位，不再是「一片空白」 |
| 缓存 | 静态文件 `Cache-Control: no-store`：插件更新立刻生效（否则用户看到旧界面，极难自查） |

### 稳健性（2026-11-13 顺带修的真缺陷）

- **单分区失败不再拖垮整页**：每个 render 包 `safe()`，失败只降级那一段并打日志（此前一个字段缺失就整页空白）
- **`tokens.buckets` / `tokens.totals` 加守卫**：引擎在扫描未完成时会缺这些字段，原来会直接抛错
- **深链放 `finally`**：任一接口 500 也不影响「从 HUD 跳过来」
- **2026-11-16 又修两处**：`refresh()` 的 `finally` 引用了 catch 块变量（`ReferenceError`，页面直接停摆）；
  额度环的 `%` 与数字叠字（改成同一 `<text>` 的 `tspan`）

### Rust 版设计取舍

- **透明 + 圆角**：WebView2 支持逐像素 alpha，窗口本身就是半透明磨砂面板（`backdrop-filter`），
  不需要像 GDI 版那样退回方角。
- **文字**：页面用系统 CJK 字体栈（PingFang SC / Microsoft YaHei / Noto Sans SC），不内嵌字体，
  也不再自带字形光栅器。
- **HTTP 手写**（`src/http.rs`，TcpStream + 切 body），只访问本机服务，不引 TLS/异步栈。
- **拖动**用 `window.drag_window()`，跨平台；穿透用 `WS_EX_TRANSPARENT`（tao 0.37 没有
  `set_cursor_hittest`）。
- **页面不能打开任意地址**：`open` 指令只放行 `http://127.0.0.1:<本端口>/`，其它一律退回落完整面板。

### 构建（Windows）

```
cd plugins/magpie-hud/desktop-rust
build.cmd          # 内部已设 RUSTUP_HOME/CARGO_HOME/TMP 与 self-contained PATH
```

前置：rustup + `stable-x86_64-pc-windows-gnu`（**不需要 MSVC**）、WebView2 运行时、
工具链 `self-contained/` 里的 `as.exe`（`dlltool` 要用它，缺了会报 `dlltool could not create import library`）。
细节见 `desktop-rust/BUILD.md`。产物是 `magpie-hud-native.exe` **加** `WebView2Loader.dll`，两个一起放
`desktop-rust/`。crate 源用 rsproxy 镜像。

## 拖拽、形状与过滤

- **拖拽**：按住状态栏任意处（按钮除外）就能拖。外壳在拖动开始后看坐标，停稳 600ms 才写回
  `position: "custom"` —— 冷却与阈值是为了修掉「HUD 自己乱跳」。
- **形状跟着吸附边走**：贴顶 → 560×200 宽扁；贴左右 → 300×520 窄高；刘海 → 560×200 贴物理顶。
  `autoShape` 默认开启（桥按吸附边算尺寸），也可关掉用手填的宽高。内容放不下时卡片内部可滚。
- **无白边**：窗口背景全透明 + 页面 html/body 透明 + 卡片铺满窗口 + **方角**
  （圆角会在拐角露出 wails 磨砂层，Windows 上 wails 又不支持窗口圆角，故取方角保透明）。
- **系统托盘**：右下角托盘图标（代码生成的 32×32 图标），左键显示/隐藏，右键菜单有
  显示/隐藏、打开完整面板、退出；HUD 里按 **Esc** 收进托盘。
- **显示哪些 agent**：设置里按客户端勾选；另有「只看活跃」（在跑 / 等你 / 最近 2 小时有动静）。
- **等你**：识别转录里「有 ask_user_question / exit_plan_mode 的 tool/call 却无对应 tool/result」的会话，
  标成「等你」并排到最前，HUD 芯片显示「N 等你」。
- **能替你答了（需要一次安装）**：审批与提问是 agent 客户端进程内存里的事，magpie 的插件 tool 钩子
  （ctx 只有 agent/abort/directory）碰不到。所以插件里带了一小段 **装进 DSH 的通道插件**
  （`dsh/magpie-hud.mjs`），它在 DSH 进程里把 approval/request 与 user-questions/request 抢过来，
  同时等「DSH 自己的 UI」和「鹊楼面板」两边哪边先答；面板赢了就 abort DSH 那边的等待并把答案交回去。
  设置页「回话通道」一行点「装到 DSH」，重启 DSH 即生效（写 `$DSH_HOME/cordis.patch.yml` 的托管段 +
  拷一个文件，卸载就是删这两样）。协议是纯文件轮询，零依赖，见 `docs/magpie-hud-v5-plan.md`。

## HUD 一眼摘要

HUD 底部一行把「现在该关心什么」说完：`50 个会话 · 5 个在跑 · 额度 6 紧/1 中/10 松 · 91 次未定价`。
额度环按 **provider 去重**（同一家多账号只取最紧的那个）取前 3——看的是「哪几家最吃紧」，不是同一家的三个账号。

## 总览（总量统计）

页面顶部四块瓦片：最紧额度（带 provider 与窗口，≥70% 橙 ≥90% 红）、24h 花费、在跑、等你。
provider 数 / 账号数 / 窗口数在「额度」分区标题右侧一行说完——同一批数字不占两排。

## 按 provider 的用量

账簿里每条请求都带真实 provider，所以能按 provider 分栏：请求数、token、金额与占比条。
**magpie 自己发起的内部调用（压缩、masking 等走自家网关）单独计数并从用户统计里剔除**——
本机实测 24h 内 23 次，混进来会把「你的用量」算高。

## 额度历史走势与掉速

读 magpie 的 `~/.config/magpie/quota-history.json`（形状 `{"<provider>|<user>": {"<窗口名>": [{at,left}]}}`）：

- 每个能算百分比或余额的额度窗口下方画一条迷你走势（剩余量随时间）；
- 算「最近掉的速率」（`dropPerHour`），额度卡上显示 `▼2.36/h`——掉得越快烧得越快；
- 本机实测 39 条曲线，最快 teleagent 的积分礼 14.42/h。

## 会话详情

点任一会话行打开：客户端与项目、状态、**该会话自己的 token 时序**、与它的消息线程（→ 发出 / ← 收到，
带状态与相对时间），并能直接再发一条。键盘可达（Tab 聚焦 + Enter/空格）。

> token 时序复用令牌缓存里「按文件聚合」的结果（一个转录文件就是一个会话），不再解一遍 zstd；
> 会话对象来自 `/api/state` 的 60s 缓存——真实数据上全量扫描要 83 秒，绝不能放在一次点击的路径上
> （实测点击到打开 133ms）。

## 额度区：按 provider 分组

21 个账号平铺太吵，所以**一家一张卡**：卡头是该 provider 最吃紧的那个窗口画的环，
卡内按账号分段（多账号的加一行账号名），每个窗口带进度/余额/重置/走势/掉速。
实测从 21 张卡收敛到 15 张，一眼看的是「哪一家」，需要时再看账号。

## 额度越线告警

任何窗口**跨过 90%** 时右下角弹一张红色边条的告警卡（`provider · 窗口 已到 96%`），20 秒自动收。

- **首次加载只播种不报警**：打开面板时已经超线的窗口不弹卡（既然你正看着，它就不是"提醒"而是骚扰）
- **回落会清账**：额度重置降到阈值以下，下次再烧上去会重新提醒一次
- 判定是纯函数 `webapp/notify.mjs` 的 `quotaAlerts`，6 个单测钉住播种、重复、回落、多窗口、坏输入

## 额度：读 magpie 采集的全量 provider

插件自己去 spawn `claude`/`codex` 只能覆盖两家，而且要求 CLI 在 PATH 里（本机就没有）。所以额度以
**magpie 自己采集的 `~/.config/magpie/quotas.json`** 为主源：本机实测 **15 个 provider / 21 个账号 / 36 个窗口**，
窗口字段 `{name, used, amount, limit, unit, balance, display, resetsAt, runsOut, runsOutAt}` 归一化后：

- `amount/limit` 都在 → 算百分比并画条与环；否则 `balance` 显示余额；再否则用现成的 `display` 文案
- `runsOut/runsOutAt`（magpie 已算好的耗尽时间）原样透传
- 自家 CLI 读取的两家（claude/codex）作为兜底：magpie 的 `quotas.json` 为空时才走它

## 磁盘协议（历史名 magpie-agents）

通道文件夹 `<home>/.magpie-agents/`、消息 ID 前缀 `magpie-agents:`、Claude Code 侧配套插件名 magpie-agents——这些是 2026-11-12 合并前鹊桥插件留下的在线协议名，磁盘上已有数据按它落盘，不改名（改了会孤儿化既有 journal 与签到）。

## 安全形状（照 magpie 自己的 pageservice.go 与 page-chat 先例）

- 只听 `127.0.0.1`；Host 必须是本机本端口（防 DNS rebinding），Origin 只许缺失或 `null`（magpie 的沙箱帧），其余 403。
- 一律 `Access-Control-Allow-Origin: *`（沙箱帧是不透明 origin，没有 CORS 头 fetch 会被浏览器拦掉），不设任何 cookie。
- HTML 自带 `sandbox allow-scripts` 的 CSP 并把源显式命名为 127.0.0.1 与 localhost 两种拼法（WebKit 对不透明 origin 的 `'self'` 匹配不了，magpie 自己的 #4198 先例）；不写 frame-ancestors——桌面窗口的父帧是 wails 源，`'self'` 会挡住，magpie web 的代理会补它自己的。

## 入口约定

入口只导出一个插件函数（host 把每个导出函数都当插件跑，见 test/entry.test.mjs 的守卫）。

## 测试

`npm test`（node --test）：插件形状与 5 工具、端口解析、CSP/CORS/Host/Origin 安全、/api 形状与缓存、发送与预检、时序与烧录率、提醒判定纯函数、引擎不可用的 requires 状态、自带引擎的集成（临时 HOME 里的真实扫描）、Claude/Codex 投递与额度协议。

## 许可

MIT（见 LICENSE）。
