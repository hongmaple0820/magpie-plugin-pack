# 鹊楼 HUD 设计方案（v2，2026-11-12）

> 背景：v1 面板是「能跑」的三段列表，被用户判为拉跨。本方案基于对 `F:\maple\agent-hud-open`（参考产品）
> 与 `F:\maple\magpie`（宿主）的源码研读重做，四视角：产品 / 架构 / 视觉 / 前端。

## 0. 研读结论（事实，非猜测）

### 参考产品 agent-hud-open
- 设计系统：Radix/shadcn 血统 + Tailwind v4 token（`src/packages/ui/src/global.css`）
- 核心 token：深色 `bg #282828`/`fg #f5f5f7`/`card #ffffff0d`/`border #ffffff1f`/`muted #98989d`/`primary #0a84ff`/`mint #32d583`；半径 12/10/7/5；正文 13px
- 组件：`QuotaRingCard`（同心环 + 图例行，指向某行点亮对应弧）、`UsageRing`（SVG 弧 + tween 动画）、`TokenChartSection`（24h/7d/30d 柱状）、`SessionsSection`（会话行 + 每轮用量条）、`HoverPanel`（悬停展开）
- 度量工具：`quota` / `burn` / `tokens` / `consumed` / `cost` 五种指标切换
- 版式常量：`nameWidth 152` / `valueWidth 62` / `detailWidth 96` / `rowSize 13` / `detailSize 12`
- 动画：`useTween` 数值变化平滑过渡；尊重 `prefers-reduced-motion`

### 宿主 magpie（决定我们能做什么）
- 插件页面 CSP：`connect-src 'none'`（`internal/gui/pluginpage.go` 的 `pagePolicy`）→ **页面自身不能 fetch**，必须靠 `magpie.page.service` 的本地服务
- 页面模式：frame 填满视图，桥可用；`page/index.html` 用 `location.replace` 导航到服务（已生效）
- 面板模式：`magpie.panels` 插槽（agents/usage/settings/provider），frame 初始 `height: 48px`；
  **但** `pluginpages.js:172` 处理 `size` 消息时只校验 `ev.source === frame.contentWindow`，**不校验 origin**
  → 服务页导航后自己 `postMessage({magpie:1,method:"size",params:{height}})` 即可撑开，上限 `PANEL_MAX = 2400`
- 主题：桥把宿主主题注入为 `--magpie-* CSS 变量` 并设 `data-theme="dark|light"`

**由此得出 v1 的两个真问题**：
1. 面板在 magpie 自己的 Agents/Usage 页里只有 48px 高（服务页没上报高度）→ 看起来像残废
2. 视觉语言与参考产品差一个量级：无环、无账户语境、无指标切换、无密度控制

## 1. 产品（高级产品经理视角）

**一句话定位**：坐在 magpie 里的「agent 值班台」——不看代码也know谁在干活、谁卡住、钱烧到哪。

**三类用户问题 → 三条主线**
| 问题 | 界面答案 | 优先级 |
| --- | --- | --- |
| 我的 agent 都还活着吗？谁在跑？ | 顶部状态条 + 会话行状态色 | P0 |
| 我这个月还剩多少额度？还能撑多久？ | 额度环 + 每窗口条 + 烧录率倒计时 | P0 |
| 有没有需要我介入的？ | 回复提醒卡片 + 消息终态 | P0 |
| 我现在能给某个会话派活吗？ | 会话行「发消息」→ 弹层 → 轮询答案 | P1 |
| 历史上用量怎么走的？ | 24h sparkline | P2 |

**设计原则**
1. **一眼可判**：颜色即状态（绿 <70% / 琥珀 70-90% / 红 ≥90%）；忙碌会话用脉冲点
2. **渐进披露**：卡片默认只给最关键的一个数字（最满窗口 + 环），细节在下面按行排
3. **不打扰**：只有需要人介入才弹（回复、告警）；其余静默轮询
4. **空态有指引**：没会话/没额度时说清「为什么没有、怎么让它有」
5. **失败要可读**：引擎不可用/端口占用给一句人话 + 下一步动作

## 2. 架构（高级开发架构师视角）

### 数据面（不变，已验证）
```
服务页 (127.0.0.1:3477) ──读── 引擎 lib（sessions / journal / usage / history）
   ↑ 面板与页面都导航到这里
```
| 接口 | 用途 | 缓存 |
| --- | --- | --- |
| `GET /api/state` | 会话 + journal | 60s TTL + 启动预热 |
| `GET /api/quotas` | 厂商额度 | 60s |
| `GET /api/history` | 时序 + 烧录率 | 落盘读 |
| `POST /api/send` | 面板发消息（human 旗标） | — |
| `GET /api/message?id` | 消息状态与答案 | — |

### 呈现面（本次改造）
1. **面板高度自报**：服务页检测 `window.parent !== window` → `ResizeObserver` → `postMessage size`（clamp 到 2400）
2. **主题跟随宿主**：服务页读 `--magpie-*` 变量；缺失时用内置 token 兜底（浏览器直连场景）
3. **降级链**：引擎不可用 → requires 卡片；额度读取失败 → 客户端级错误行（保留原因），不吞
4. **不引入构建**：仍是无依赖 vanilla（CSP sandbox 下最稳），但把设计 token / 组件函数化，等价于「微设计系统」

### 风险
- `PANEL_MAX 2400` 是硬顶：内容超长由内层滚动消化
- 服务页在面板里是不透明 origin：`localStorage` 不可用 → 提醒基线只在内存（已知取舍）

## 3. 视觉（UI 设计视角）

### Token（对齐参考产品，深色优先）
```
--bg        #282828 / #f5f5f7      --fg        #f5f5f7 / #1d1d1f
--card      #ffffff0d / #ffffff    --line      #ffffff1f / #0000000f
--muted     #98989d / #6e6e73      --primary   #0a84ff / #007aff
--ok        #32d583   --warn #ff9f0a   --bad #ff453a
radius      12 / 10 / 7 / 5        字号 13 基准 / 11 辅助
```

### 版式
- 顶栏：品牌 + 忙碌计数 + 刷新时刻（右对齐，tabular-nums）
- 额度区：卡片网格（`minmax(260px,1fr)`），每卡 = 环 + 账户行 + 窗口行 + sparkline + 烧录行
- 会话区：分组行（客户端色点 + 首字母徽标 + 标题 + 项目 + 状态 chip + 发消息）
- 消息区：`from → to`、状态 pill、相对时间、指纹短码
- 提醒：右下角堆叠卡片，左侧色条，15s 自动收

### 环的画法（照 `usage-meter/arcs.ts` 简化）
- 1 个窗口 = 整环；2/3/4 个窗口 = 同心环（外→内，线宽均分）
- 轨道色 `--line`，填充色按等级；`stroke-linecap: round`，值 <0.3% 不画
- 中心显示最满窗口的百分比（tabular-nums，13px/600）

## 4. 前端（前端工程师视角）

- 无框架、无依赖：`el()` 工厂 + 分区渲染函数，状态只有 `last` 快照
- 增量渲染：每个分区先算 key（`sessions`/`quotas`/`journal`/`history` 的 JSON 摘要），未变则跳过 DOM 重建 → 30s 轮询不闪
- 事件委托：会话区一个 click 监听，靠 `data-action`/`data-id` 分发（避免 N 个监听器）
- 无障碍：`aria-live` 提醒、按钮真实 `<button>`、焦点环、`prefers-reduced-motion` 时关动画
- 安全：全部 `textContent` 写入（无 innerHTML 拼接），杜绝注入

## 5. 验收
- Before/After 同场景同视口截图（浏览器直连 + 桌面面板两种上下文）
- 单元测试全绿；新增：面板高度上报、增量渲染 key 稳定性
- 桌面窗口实拍：`magpie app` + 侧栏「鹊楼」页 + Agents/Usage 页内嵌面板

## 6. 落地状态（2026-11-12）

- ✅ 设计 token 与密度体系（`webapp/app.css`），跟随宿主 `--magpie-*` 主题
- ✅ 额度环（1 整环 / 2-4 同心环）、账户与套餐徽标、每窗口条与重置倒计时、sparkline、烧录率
- ✅ 会话行（客户端色标字标、状态 pill、发消息）、消息行（状态 pill、相对时间、指纹）
- ✅ 提醒卡片（判定抽为纯函数 `webapp/notify.mjs`，6 个单测钉住基线/去重/非终态）
- ✅ 面板高度自报（`ResizeObserver` + `postMessage size`）—— 解开 48px 死锁
- ✅ 分区内容 key，未变跳过 DOM 重建
- ✅ 桌面实机验证：GUI 版 magpie（`go build -tags production`）+ 侧栏页 + `/notify.mjs`、`/app.js`、`/app.css` 全部 200

**第二轮补齐（2026-11-12 晚）**
- ✅ 令牌用量：24h / 7d / 30d 三档柱状图，从三家转录解析（字段形状各异，按实测解析）
- ✅ 三层成本策略：mtime 预筛 + 2MB 单文件上限 + (mtime,size) 落盘增量缓存 + 文件间让出事件循环；
  首次调用 0.1s 立即返回，后台扫完转完整
- ✅ 面板槽位分化：两个入口页 + `#focus` 排序（agents 先会话、usage 先额度）
- ✅ 面板内限高 620px 内滚（原先内容 3283px 会撑爆面板）
- ✅ 窄屏响应式（magpie web 被手机打开时单列 + 行换行）
- ✅ 额度环微光（克制版 glow）
- ✅ favicon 204，清掉控制台噪音

**第三轮补齐（2026-11-12 夜）**
- ✅ 花费（cost）：接 magpie 的请求账簿 `~/.config/magpie/usage.jsonl`（9642 行 / 5.5MB，纯 JSONL
  秒读，带真实 provider/model/token）+ `~/.cache/magpie/models.json`（models.dev，8594 个带价模型）
- ✅ 账簿优先、转录回落：`source: "ledger" | "transcripts"` 明示来源；账簿路径 228ms、转录路径
  仍是增量缓存
- ✅ 未定价单列：`cost.unpriced` 与 `unpricedModels`，金额只算对得上价的部分
- ✅ UI：汇总增「花费」，新增按模型明细行（token + 金额），hint 显示「N 次请求 · magpie 账簿 · M 次未定价」

**仍未做（明确记录）**
- 机器人动画与 GPU 环光效（参考产品用 WebGL 着色器；纯 CSS 做不出同等质感，且与 30s 轮询的
  静态刷新模型不合）
- 权限审批卡片（Permission request）：需要 magpie 侧审批钩子，插件边界外
- 手机/手表原生端：magpie 只有 web 模式，已做窄屏适配

## 7. 第四轮：系统级 HUD + 全量额度（2026-11-13）

用户裁决：宿主做不到就用原生桥程序；并指出额度/用量没按 agent 统计、没有总量、支持面太窄。

**研读结论**
- 插件拿不到常驻桌面窗口：`panelside.go` 只决定快捷面板从哪边开；`trayusage*` 是 magpie 自身的托盘绘制。
- Rust 不可行（本机无 cargo/rustc，Windows 上还需要 MSVC/GNU 工具链）。**Go 可行**：magpie 的 GUI 在
  CGO_ENABLED=0、无 gcc/cl 的环境下能构建（wails v3 在 Windows 走 COM），WebView2 运行时已存在。

**交付**
- ✅ `desktop/`：Go + wails v3 原生 HUD 桥，无边框 / 置顶 / 半透明 / 不占任务栏 / 头部可拖拽；
  实测窗口 360×220、`frame=0x-1`（无可见边框）、`topmost=True`
- ✅ 插件装载即自动拉起桥（option/env 可关），拉不起只记日志
- ✅ HUD 视图 `?hud=1`：最满额度环 + 今日花费/token/请求 + 会话与在跑数
- ✅ 额度改读 magpie 采集的 `quotas.json`：15 provider / 21 账号 / 36 窗口（原来是「暂无套餐额度」）
- ✅ 客户端识别表扩到 10 个（claude/codex/dsh/gemini/cursor/opencode/copilot/antigravity…）

**仍未做（下一步）**
- 按 agent / 按 provider 的**汇总卡**（总花费、总 token、总额度余量、最吃紧的 3 个）
- 会话详情页（点会话看它的 token 曲线与消息线程）
- 额度历史走势（`quota-history.json` 已有时间序列，尚未画）
- 更多客户端的转录读取器（cursor/opencode/copilot 等的本地格式）

## 8. 第五轮：可配置的桌面 HUD（2026-11-13）

用户要求：HUD 可拖动、支持刘海屏与常规屏、默认吸附顶部居中或屏幕最左、支持透明度、
设置放在 magpie 插件页面里、UI 与交互要流畅闭环。

**架构：一份设置、两个消费者**
- `lib/settings.mjs` 写 `<home>/.magpie-agents/hud-settings.json`（原子整写 + 白名单校验：
  未知位置回默认、尺寸夹 240–900、透明度夹 0.4–1、坏 JSON 当默认）
- `GET/POST /api/settings`：读与合并写（POST 走与 /api/send 同一套 64KB 上限与 JSON 校验）
- 桌面桥（Go）读它定**窗口几何**；页面读它定**外观**（透明度、刘海圆角、显示哪些分区）
- 桥每 1.5s 轮询设置 → 页面里改了位置/尺寸即时跟随；同时轮询自己的位置 → 被拖动且稳定两拍就
  POST `{position:"custom", x, y}` 记住

**实测数据**
| 动作 | 结果 |
| --- | --- |
| `top-center` | 窗口 (780,12) —— (1920−360)/2，工作区顶 +12 |
| `left` | 窗口 (12,410) —— 贴左 12，垂直居中 (1040−220)/2 |
| MoveWindow 到 (640,520) | 设置自动变 `{position:"custom", x:640, y:520}` |
| 改回 top-center | 4.5s 内窗口回到 (780,12) |

**同时补齐**
- ✅ 总览瓦片：今日花费 / token / 请求数 / provider 数 / 账号数 / 最紧额度
- ✅ 设置界面（吸附位置、透明度、尺寸、刘海模式、总在最前、显示分区）

**仍未做**
- 多显示器选择（当前只用主屏；`ScreenManager.GetAll` 已可用，等 UI 加选择器）
- 逐 provider 的用量分组卡（数据已在 `byModel`/`byClient` 里，UI 未分栏）
- 会话详情页与额度历史走势
- HUD 常驻渲染循环（机器人动画/光效）——桥已常驻，技术上可行，未做

## 9. 第六轮：分组统计 · 额度走势 · 会话详情（2026-11-13）

**按 agent / 按 provider 分组**
- `tokens.mjs` 新增 `byProvider`（请求数 / token / 缓存读 / 金额）与 `internal` 计数
- **过滤 magpie 内部调用**：`agent === "magpie"` 的请求是 magpie 自己走的网关（压缩、masking），
  本机 24h 有 23 次；混进用户统计会把用量算高。只计数、不计入 byClient/byProvider/成本
- UI「按 provider」分区：占比条 + token + 金额 + 请求数（实测 8 个 provider）

**额度历史走势**
- 新模块 `lib/usage/quota-history.mjs` 读 `~/.config/magpie/quota-history.json`
- 每条曲线给 `dropped`（窗口内掉了多少）与 `dropPerHour`（掉速），按掉速降序
- 额度卡每个窗口下加迷你走势 + `▼x/h`；实测 39 条曲线，最快 14.42/h

**会话详情抽屉**
- 新模块 `lib/session-detail.mjs`：元信息 + 消息线程（方向/状态/时间）+ 该会话的 token 时序
- token 复用令牌缓存的按文件聚合（一个转录文件 = 一个会话），不再解 zstd
- **性能修正**：初版在点击路径上全量扫描（真实数据 83 秒，抽屉根本打不开）；
  改为复用 `/api/state` 的 60s 会话缓存后 **133ms**
- 会话行可点、键盘可达（Tab + Enter/空格），行内「发消息」仍走独立弹层

**过程中修的 bug**
- `engine.quotaHistory` 命名冲突：新模块覆盖了面板 24h 走势用的 `QuotaHistory` 实例方法，
  导致 `/api/history` 500。改名 `providerQuotaHistory` 后两个接口都 200
- 分区顺序错乱：`body[data-focus]` 只该在面板里生效，且未列出的分区拿到 `order:0` 抢到最前。
  改为仅嵌入时设置 + 给 overview/settings/providers 显式 order

**剩余**
- 多显示器选择、HUD 常驻渲染循环（动画/光效）

## 10. 第七轮：多显示器 + 常驻动效（2026-11-13）

**多显示器**
- 桥枚举屏幕（`ScreenManager.GetAll/GetPrimary/GetByID`）→ POST `/api/display`（运行时内存，不落盘）
- 设置新增 `screen`（显示器 ID，`""` = 主屏，超长截断到 128 字符）
- `place()` 用 `pickScreen(app, s.Screen)` 选屏；设置里改屏幕 → 1.5s 内重新贴
- 页面只有当 `screens.length > 1` 时才渲染选择器（单屏机器不显示无意义的控件）
- 实测上报：`[{"id":"65537","name":"\\\\.\\DISPLAY1","width":1920,"height":1080,"primary":true}]`

**常驻动效**
- 桥是常驻窗口，所以 HUD 可以有「活」感：呼吸光晕（rAF 推 `--glow`，2.8s 一个来回）、
  数字缓动（450ms ease-out，从旧值滑到新值）、在跑会话的脉冲点、卡片淡入
- 三条纪律：`prefers-reduced-motion` 全关；`?anim=0` 一键关（**截图与自动化验证必须用它**，
  连续动画会让截图等不到稳定帧）；`visibilitychange` 时停 rAF

**HUD 一眼摘要**
- 底部一行：会话数 · 在跑数 · **额度 N 紧/M 中/K 松** · 未定价次数
- 额度环按 provider 去重取前 3（同一家多账号只算最紧的）——实测三个环都到 100% 是**真实数据**
  （codearts 6375783/5000000 = 127.5% 超限、workbuddy-ai 380/380、teleagent 499.56/500），
  所以补了「6 紧/1 中/10 松」这句，才有一眼的价值

**数据校验（顺带确认的）**
- `used` 字段**确实是百分比**（tabbit used=39.1 对应 39.1/100；teleagent used=99.912 对应 499.56/500），
  所以「无 amount/limit 时用 used 当进度」的兜底是对的，不是猜
- `amount/limit` 仍优先（唯一能处理超限的：codearts 算出 127.5%，展示夹到 100%）

**剩余**
- 无（最初列出的 5 项已全部完成；HUD 的机器人动画/GPU 着色器光效属于「参考产品的像素级复刻」，
  已用 CSS+rAF 做到呼吸光晕这一档，再往上需要 WebGL 着色器，判定为超出插件合理范围）

## 11. 第八轮：分组收敛 · 越线告警 · HUD 闭环（2026-11-13）

**先做了一次数据可行性核查**
- 想补更多 agent 的转录读取器（用户提过「支持的 agent 不多」），核实本机：
  `~/.gemini` 只有 6 个 `projects.json.*.tmp`，**没有任何会话数据**；`~/.claude` 不存在；
  `~/.codex/sessions` 不存在。→ **新增读取器无法验证，因此不写**（不交付未验证的代码）。

**额度区按 provider 分组**
- 一家一张卡（原 21 账号 → 15 provider），卡头环画该 provider 最紧的窗口，
  卡内按账号分段，多账号加账号名行
- 实测：15 张卡、12 个账号标签

**额度越线告警**
- 纯函数 `quotaAlerts(prev, windows, threshold, {seed})`：只报「刚跨过 90%」的窗口
- **首次播种**：打开面板时已超线的不弹（否则 6 个 100% 窗口会同时弹 6 张卡，是骚扰不是提醒）
- 回落记新值，再越线重新报；红色左边条与消息提醒视觉区分
- 6 个单测：播种、重复不报、回落重报、多窗口、自定义阈值、坏输入

**HUD 闭环**
- 额度环可点（+ Enter/空格）→ 跳完整面板；`⤢` 按钮同效

**当前测试规模**：鹊楼 64 + 鹊巢 172 = **236**

## 12. 第九轮：修三个真实缺陷（2026-11-13）

用户报了三件事：HUD 拖不动且影响其他操作 / 显示了没在工作的 agent 且缺审批等互动 / **HUD 自己跳来跳去**。

### ① HUD 自动乱跳 —— 是我写的反馈循环

**根因**：`SetPosition` 在 Windows 上是异步的，我在调用后**立刻** `Position()` 读回，读到的是旧值。
下一轮轮询把这个旧值当成「用户拖动」存成 `position: "custom"`，再应用，再读旧值……自激。
实测证据：设置里莫名其妙出现 `custom (780,410)`，而那正是桥自己摆的位置。

**修法**（`desktop/main.go`）
- 跟踪 **目标坐标** `targetX/targetY`（我们要求的位置），不再拿读回值当基准
- 应用后 4 秒**冷却期**内不做拖动判定
- 位移阈值 10px，且要连续 3 拍稳定才落盘

**验证**：重置为 `top-center` 后，位置恒为 `(800,10) 320×420`（(1920−320)/2、工作区顶 +10），
设置保持 `top-center (0,0)` 不再被改写。

### ② 拖不动 —— 两个条件缺一不可

用探针（页面自报 `window._wails` 状态）逐步排除，最终定位两个叠加原因：

1. **`Windows.WebView2CompositionHosting` 未开**。wails 的无边框拖拽（CSS `--wails-draggable: drag`）
   被 `window._wails.flags.nonClientRegionTracking` 门控，而这个 flag 只在该选项为 true 时为 true。
2. **外部 URL 拿不到运行时**。wails 在 `navigationCompleted` 注入 `runtime.Core`，但页面若由
   外部 HTTP 服务提供，实测注入不生效（探针：`hasWebview=true / hasWails=false`）。

**修法**：HUD 页面改由 **wails 自己的资源服务器**提供（`Assets.Handler` 指向插件的 `webapp/` 目录），
页面以 `http://wails.localhost` 为源、用 `?base=http://127.0.0.1:<port>` 跨源访问插件服务；
服务端显式放行 `http://wails.localhost`（该主机名只解析到本机 wails 应用）。

**验证**：真实 HUD 窗口自报 `drag-ready` / `hasWails=true` / `os=windows`，
并成功渲染 `50 会话 / 15 额度卡 / $100.17`。

> 附带教训：探针最初报 `no-runtime` 是**取样太早**（app.js 在解析时上报，运行时在导航完成后注入）。
> 改成 `load + 1.5s` 再探才准。断言时机错了，结论就错了。

### ③ 形状与过滤

- 默认改为 **320×420 窄高面板**（原来 360×220 又宽又扁）；外形预设：窄面板 / 紧凑 / 刘海条 560×120
- HUD 卡片内部可滚动
- **显示哪些 agent**：设置里按客户端勾选（空 = 全部）
- **只看活跃**：在跑 / 等你 / 最近 2 小时有动静（默认关，一键解决「没在工作也显示」）
- 整块 HUD 可拖（`--wails-draggable: drag` 由父继承），按钮/环/输入框单独排除

### ④ 状态提醒：识别「等你」

**能做的**：转录尾部若有 `ask_user_question` / `exit_plan_mode` / `request_approval` 的
`tool/call` 而**没有同 id 的 `tool/result`**，说明该 agent 正卡着等你。已实现：
- `sessions.mjs` 的 `pendingOf()`（只扫尾部 400 行；DSH 转录本来就要整份解压，零额外成本）
- 会话行显示「等你 ask user question」徽标并**排到最前**
- HUD 芯片显示「N 等你」并可点开完整面板
- 单测：有 call 无 result → 等待；有 result → 不等待；无等待类调用 → null

**做不到的（诚实边界）**：在面板/HUD 里**直接批准或回答**。magpie 给插件的 tool 钩子 ctx 只有
`{agent, abort, directory}`，没有审批/提问应答接口；那是各 agent 客户端自己的 UI（如 DSH 的审批框）。
所以鹊楼做的是「告诉你在等你、把你带过去」，不是替你回答。

## 13. 第十轮：形状跟吸附边 · 去白边 · 系统托盘（2026-11-13）

用户纠正了我上一轮的理解：**高度过高**，要宽度长一点；侧边栏形态才是高一些窄一些。
并要求去掉白边、支持最小化到右下角托盘。

### ① 形状跟吸附边走（`effectiveSize`）

| 吸附 | 尺寸 | 实测 |
| --- | --- | --- |
| 顶边（top-center/left/right） | 560×200 宽扁 | (680,10) —— (1920−560)/2、工作区顶 +10 |
| 侧边（left/right） | 300×520 窄高 | (10,260) —— 贴左 10、垂直居中 (1040−520)/2 |
| 刘海（notch） | 560×200 贴物理顶 | (680,0) |

`autoShape`（默认开）由桥按吸附边决定尺寸；关掉则用设置里显式给的宽高。
页面按 `left/right` 加 `data-orient="portrait"`（额度环竖排、统计竖排），顶部是 `landscape`（横排）。

### ② 白边：三层排查，最后一层才是真因

1. 窗口 `BackgroundColour` 未设 → 补 `NewRGBA(0,0,0,0)` + 页面 `html/body transparent !important`
2. body 有 4px padding → 卡片外露出磨砂层；改成 0，卡片铺满窗口
3. 仍剩**四个圆角**——卡片 14px 圆角切掉的四块露出 wails 的磨砂背景（白桌面下就是亮边）

**最终做法**：HUD 里把卡片改成**方角**。Windows 上 wails 没有窗口圆角选项（源码里没有
`RoundedCorners/CornerPreference`），所以「圆角 + 磨砂亮边」与「方角 + 真透明」只能二选一，
选后者（保住透明度设置）。

**像素验证**（显隐对比同一屏幕像素）：六个采样点（四角、上边、中心）全部为卡片色
`rgb(53,53,53)`，桌面色 `rgb(249,250,251)` 只出现在窗口之外。

### ③ 系统托盘（右下角）

- `app.SystemTray.New()` + 图标（**代码里生成** 32×32 圆角方块+青绿点，不依赖外部资源）
- 左键点击：显示/隐藏 HUD；右键菜单：显示/隐藏、打开完整面板、退出
- `HideOnEscape: true`：HUD 里按 Esc 直接收进托盘
- `AttachWindow(w)` + `WindowOffset(8)`：托盘图标与窗口联动
