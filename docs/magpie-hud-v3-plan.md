# 鹊楼 v3 方案：从「能用的面板」到「闭环的 HUD 产品」

> 2026-11-13。基于对 magpie（宿主，63 个 agent）与 agent-hud-open（参考产品）源码的研读。
> 四角色视角：产品 / 架构 / UI·美术 / 前端·全栈。每条结论都有实测或源码出处。

## 0. 研读结论（决定方案形态的事实）

| 事实 | 出处 | 对方案的影响 |
| --- | --- | --- |
| magpie 支持 **63 个 agent** | internal/agent/*.go 的 ID: 定义 | 「支持全部 agent」不可能靠 63 个转录解析器，必须复用宿主数据 |
| magpie 自带会话 API /api/sessions/{stats,overview,progress,one,transcript,markdown,manage} | internal/gui/sessions.go | 会话列表与转录的正确来源；需带网关 Bearer |
| magpie 有 internal/sessions 包，已为全部 agent 发现会话 | 同上 import | 这是「支持 63 个 agent」的唯一现实路径 |
| 请求账簿 usage.jsonl 带 agent/provider/model/in/out | 实测 9642 行 | 用量与花费已覆盖全部 agent，不依赖转录 |
| 额度 quotas.json（15 provider / 21 账号）+ quota-history.json（39 曲线） | 实测 | 额度与走势已覆盖全部 provider |
| 主题：settings.json 的 theme: system|light|dark 与 textSize | internal/settings/settings.go:49 | 可读文件同步主题，也可单独设置 |
| 插件可挂 magpie.panels 槽位 agents/usage/settings/provider | internal/plugin/page.go:104 | **设置页**直接用 settings 槽位，无需自造入口 |
| wails 无窗口圆角选项；production 下拖拽需 WebView2CompositionHosting | wails v3 源码 | HUD 取方角保真透明；拖拽已通 |
| 页面由 wails 服务才注入 runtime（外部 URL 不注入） | 探针实测 hasWebview=true/hasWails=false | HUD 页必须由桥的 Assets 提供 |

## 1. 产品（高级产品经理）

**定位**：坐在桌面上的「agent 值班台」。三件事，按频次排序：
1. **谁在等我**（等你回答 / 等你审批 / 回复到了）→ 一眼看到并一跳到位
2. **还能烧多久**（额度余量、掉速、花费）→ 一眼看到最紧的
3. **谁还活着**（在跑 / 空闲 / 已装未运行 / 未安装）→ 只显示有意义的

**与参考产品对齐但不复刻**：Agent HUD 是「展示 + 就地审批」；鹊楼的审批只能「带到门口」
（宿主没有插件审批接口，见 §3）。产品上把这点说清楚，比假装支持更有价值。

| 优先级 | 功能 | 现状 |
| --- | --- | --- |
| P0 | 只显示「已安装 + 有活动」的 agent | 待做 |
| P0 | agent 状态：在跑/空闲/等你/未运行 | 等你已做 |
| P0 | 会话搜索 + 分页 | 待做 |
| P0 | 主题跟随 magpie + 可单独设置 | 待做 |
| P0 | 独立设置页（settings 槽位） | 待做 |
| P1 | HUD 高度按 80% 缩放、可滚动、agent 可拖动排序 | 待做 |
| P1 | 回复提醒卡片 → 点它回到该会话 | 待做 |

## 2. 架构（高级技术架构师）

### 2.1 数据分层（关键决策：不重写解析器）

    第一层 宿主 API（首选）   magpie /api/sessions/*    63 个 agent 的会话（Bearer）
    第二层 宿主落盘文件       usage.jsonl / quotas.json / quota-history.json / settings.json
    第三层 本机转录（兜底）   claude / codex / dsh / antigravity 四种解析器（已有）

原则：能用第一层就不用第三层；第三层只作离线兜底，并在 UI 上标注来源。

### 2.2 鉴权与降级
读 ~/.config/magpie/gateway.json 的网关 token，带 Authorization: Bearer 访问 127.0.0.1:3425。
读不到 token 时自动回落到第三层，不报错、不空屏。

### 2.3 HUD 与页面的分工
- HUD（wails 原生窗）：只放「一眼」信息 + 极短交互（点开面板、Esc 收托盘、拖动排序）
- 完整面板（magpie 页面）：搜索、分页、详情、设置、一切重交互
- 两者共用同一份 /api/* 与同一份 hud-settings.json

### 2.4 尺寸策略（用户要求：顶部高度再降 80%，左侧宽度再降 80%）

| 吸附 | 原 | 新 |
| --- | --- | --- |
| 顶边 | 560×200 | **560×160** |
| 左侧/右侧 | 300×520 | **240×520** |
| 刘海 | 560×200 | **560×140** |

内容超出时 HUD 内部可滚动；agent 芯片支持拖动排序，顺序存 settings。

## 3. 边界（必须让用户知道）
- **审批**：magpie 给插件的 tool 钩子 ctx 只有 {agent, abort, directory}，没有审批应答接口。
  鹊楼能「检测到某会话在等审批/等回答并把你带过去」，不能替你点允许。
- **已装判定**：ledger/quotas 出现的 provider 不等于已装 agent。判定用「agent 定义命中 + 该 agent 在 ledger 有记录 +
  有会话或配置目录存在」三者组合，并在 UI 标注来源，不假装精确。

## 4. UI·美术（高级 UI/设计师）

- **主题同步**：读 settings.json.theme（system/light/dark）；system 时跟随系统 prefers-color-scheme；
  另给 theme: auto|dark|light 让用户单独覆盖。色板沿用 --magpie-* 命名，缺省用同色系兜底。
- **密度**：13px 正文 / 11px 辅助；卡片间距 10px；列表行 32px；解决「全部挤在一起」
- **布局**：顶部总览瓦片 → 左栏额度（按 provider 折叠）→ 右栏会话（搜索+分页）→ 底部消息；宽屏两栏、窄屏单列
- **HUD**：横条时左环右数；竖条时上下堆叠；agent 芯片横向可拖、溢出横向滚

## 5. 前端·全栈（高级前端/全栈）
- 零依赖 ESM（CSP 与 wails 双环境都能跑）；分区渲染带内容 key；分页与搜索走本地状态 + URL hash
- 拖动排序用 Pointer Events（不用 HTML5 DnD，wails 里更稳），落盘 debounce 300ms
- 分页默认 20/页；搜索对 title/project/client 做大小写无关子串匹配，150ms 防抖
- 无障碍：焦点环、aria-selected、Enter/Space 可达

## 6. 里程碑与验收

| # | 交付 | 验收（可测） |
| --- | --- | --- |
| M1 | 宿主会话 API 接入 + 来源标注 + 降级 | 有 token 时列出 63 agent 的会话；无 token 回落转录；两条路径都有单测 |
| M2 | 只显示已装/有活动的 agent + 状态细分 | 未安装/长期不动默认不出现；开关可放开 |
| M3 | 会话搜索 + 分页 | 搜索 150ms 防抖、20/页、键盘可用 |
| M4 | HUD 尺寸 80% + 滚动 + agent 拖动排序 | 实测 560×160 / 240×520；顺序落盘并重启保持 |
| M5 | 主题同步 + 独立设置页 | 改 magpie 主题页面跟随；设置页独立可进 |
| M6 | 文档与回归 | 全 pack 测试绿；README 与方案同步 |

## 7. 风险
- 宿主 API 形状随版本变 → 加形状校验与降级，不硬依赖
- 63 个 agent 的「已装」没有权威来源 → 组合判定 + 明确标注
- HUD 常驻渲染与截图验证冲突 → 保留 ?anim=0
## 8. 执行记录（2026-11-13 第三批）

### WebView2 更新：失败（无管理员权限）
- 下载官方 Evergreen 引导安装器（1.8MB）成功，`/silent /install` 返回 **-1**：需要提权。
- 本会话无法提权 → 运行时仍为 **119.0.2151.58（2023）**，`CreateCoreWebView2Controller` 报 0x8000FFFF。
- 已试无效：关 composition hosting、HWND 回退、`--disable-gpu`、`--no-sandbox`、删用户数据目录、清进程。

### 「用户安装不允许有依赖问题」→ 已做的一半 + 下一半
- **已做**：桥失败不再刷屏。第一次异常退出即落标记 `.desktop-failed`，后续启动直接跳过并静默；
  删除该文件或设 `MAGPIE_HUD_DESKTOP_RETRY=1` 可重试。产品的页面部分完全不依赖 WebView2。
- **下一半（M-HUD-2）**：用 **纯 Go + GDI 原生绘制**替代 WebView2 窗口——不依赖任何浏览器引擎，
  HUD 只需要画环、数字、几行文字，GDI 足够，且在任何 Windows 上都能跑。这是彻底消除依赖的方案。

### M1「接宿主会话 API」：不可行（结论修正）
- 实测：`app` 模式下的 magpie **只监听 3425（网关 /v1/*）**，`/api/sessions/*` 只存在于 wails 内部源。
- 用 `/api/sessions/*` 需要网关 Bearer，而本机 `caller-keys.json` 不存在（用户从未创建 key）；
  即便创建，那也是「要求用户手动配置」的依赖，与用户要求相悖。
- **所以「支持 63 个 agent 的会话列表」只能靠各自的转录解析器**，这条路不现实。

### 替代方案（已落地）：agent 注册表 + 已装判定
- `lib/agents.mjs`：30 个已知 agent 的数据目录表（宁缺不猜，只收位置确定的）。
- 判定：目录存在 = 已安装；目录内有 7 天内文件 = 活跃。
- `GET /api/agents` 实测：**已知 30 个，已装 6 个**（antigravity/codex/dsh/gemini/magpie/opencode，5 个活跃）。
- 会话列表默认**按此过滤**：没装的 agent 不再出现（用户核心抱怨）。
- 边界写明：已装 ≠ 可交互；能列会话/能发消息仍只有 claude/codex/dsh/antigravity 四种解析器。

### 本轮测试
鹊楼 70 + 鹊巢 172 = 242，全绿（新增 agents 4 个单测）。
## 9. 原生 GDI HUD 落地（2026-11-13 第四批）

**决定**：不再等 WebView2 修复，直接换成**纯 Go + Win32 GDI** 的 HUD。

**为什么这条路对**：HUD 要画的只有几个环、几行字；GDI 足够。而它把整类依赖都消掉了——
没有 WebView2、没有浏览器引擎、没有 GPU/composition、没有前端运行时。

**实现要点（每一条都是踩坑换的）**：
- 分层窗口 + `UpdateLayeredWindow`：逐像素 alpha，透明与圆角一次搞定，天然没有白边
- 先在 32bpp DIB 上用**洋红哨兵色**绘制，再统一扫一遍把哨兵改成 alpha=0、其余按 opacity 设 alpha，
  并按 14px 圆角做遮罩 —— GDI 不写 alpha，这一步是分层窗口显示的前提
- `WM_NCHITTEST` → 顶部 34px 返回 `HTCAPTION`：**Windows 自己负责拖动**，不需要 `--wails-draggable`
- DLL 归属踩坑：`GetDC`、`DrawTextW` 在 **user32**，不是 gdi32（第一次运行就 panic 在这里）
- 常量负数不能直接转 `uintptr`（`-15` 字体高度），要先落到变量

**实测**：窗口 `(680,10) 560×160`、`layered=True topmost=True toolwin=True`；
像素直方图：dark=20579 / light(文字)=301 / red=319 / green=44 —— 面板、文字、环都在。

**仍待补**：托盘菜单项与主菜单共用逻辑、多显示器选择、HUD 内 agent 拖动排序。
## 10. 平台支持：现状与 macOS 路线（2026-11-13）

**现状**：原生 HUD 只有 Windows 后端（user32/gdi32）。已按构建标签拆分：
- `main_windows.go`：GDI 实现
- `main_other.go`：占位，`os.Exit(0)` + 一行原因；插件端据此静默跳过，页面照常

**交叉编译实测**：windows/amd64 ✓、darwin/arm64 ✓、darwin/amd64 ✓、linux/amd64 ✓。

**agent-hud-open 的做法（源码证据）**：
- Rust + Tauri 2；`Cargo.toml` 有 `objc2` / `objc2-app-kit` / `objc2-foundation`
- macOS 的 HUD 必须是 nonactivating `NSPanel`，上游 `tao` 做不到 → **fork tao** 加一个提交
  （`with_nonactivating_panel`），见 `docs/tao-panel-patch.md`
- 结论：跨平台 = 跨平台窗口层（Tauri）+ 每 OS 的原生代码（objc2 / Win32），不是一份代码通吃

**macOS 后端的映射表**见 README「平台支持矩阵」。关键约束：objc_msgSend 需要 **cgo**，
而 cgo 不能交叉编译——macOS 版必须在 Mac 上构建并作为预编译产物分发（或用户在 Mac 上构建）。