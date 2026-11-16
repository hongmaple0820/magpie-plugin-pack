# 鹊楼验收报告（2026-11-13）

全部检查项都在本机实跑，命令与输出可复现。分四组：静态/单测、编译矩阵、HUD 运行时、页面端到端。

> **2026-11-16 补记**：桌面 HUD 从 winit + softbuffer 手绘 canvas 换成了 tao + wry 的
> WebView2 页面外壳（内容见下面的 §零）。§三、§四 里点名的 `--selftest-*` 开关随旧外壳一起删除了，
> 那两张表只作为旧外壳的历史记录，不再可复跑。

## 零、桌面 HUD（WebView2 页面外壳，2026-11-16 实测）

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| 构建（Windows / GNU） | `cargo build --release` 成功；补了工具链缺的 `as.exe`（见 `desktop-rust/BUILD.md`） | PASS |
| Rust 单测 | `cargo test --release` → **22/22**（摆位 14 + IPC 解析 8） | PASS |
| 插件单测 | `MAGPIE_HUD_DESKTOP=0 node --test test/*.test.mjs` → **187/187** | PASS |
| 发布包 | `node tools/check/packaging.mjs` → 通过；tarball 105 个文件，含 `WebView2Loader.dll`（160880 字节）与 exe（816128 字节） | PASS |
| 窗口形态（收起） | `window 576x62 / client 560x54`：52px 状态栏 + 1px 边框，页面文字锐利（截图 `plugins/magpie-hud/corpus/hud-webview.png`） | PASS |
| 窗口形态（展开） | 点 `⌄` → 页面报 180px → `window 576x189 / client 560x181`；列出 2 条「工作中」会话 + 汇总行（截图 `corpus/hud-expanded-webview.png`） | PASS |
| 拖动 | 模拟按住状态栏拖 −120 / +80 → 窗口位移 `-120,80`，1.4s 后写回 `/api/settings`：`position=custom x=280 y=380` | PASS |
| 设置跟随 | `POST /api/settings {position:custom, x:400, y:300}` → 2s 内窗口落到 `400,300`；设置里的 `height` 被页面高度覆盖（按设计） | PASS |
| 数据 | `/api/state` 153 个会话 / 2 个在跑；`/api/tokens`（24h）1.535 亿 token、$499.88；`/api/quotas` 最满窗口 100%（qoder credits） | PASS |
| 静态白名单 | `/hud.html`、`/hud.js`、`/hud.css`、`/icon.svg` 200；白名单外 404（单测覆盖） | PASS |
| 审批按钮 | 当时没有待批项，真机上没点过「批准/拒绝」；逻辑走 `POST /api/asks/answer`，与面板同一接口 | **未验** |
| 点击穿透 | `--selftest-clickthrough` → `正常点击=true 穿透=true 恢复=true`；托盘菜单可切 | PASS（调用层） |
| 冒烟基准 | `node tools/bench/hud-smoke.mjs` → 冷启动出窗 2777ms、单实例 exit 0、窗口 `680,8 576×60` 在工作区内（留 8px）、进程判定 gone | 4/4 PASS |

### 这一轮修掉的三个真 bug

1. `webapp/hud.js` 里 `const ipc = …` 与 wry 注入的全局 `ipc` 重名 →
   `SyntaxError: Identifier 'ipc' has already been declared`，整个脚本不执行，窗口里只剩 HTML 占位符的「—」。
   改成 `bridge` 并整段包进 IIFE。
2. 同上文件缺 `$` / `el` 两个辅助函数（压缩时被误删），补回。
3. 拖动落点写不回去：tao 重写时把「页面发 drag → 主循环装观察器」这步丢了，
   `drag` 永远是 `None`。补上后拖动 → 写回设置 → 重启仍在新位置。


## 一、静态与单元测试

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 鹊楼插件 | `node --test plugins/magpie-hud/test/*.test.mjs` | **71/71 PASS**（连跑两次） |
| 鹊巢插件 | 同上（pack 内） | **172/172 PASS** |
| 全 pack | `node scripts/test-all.mjs` | **243/243 PASS**（连跑两次） |
| Rust HUD | `cargo test --release` | **14/14 PASS** |

Rust 单测覆盖：芯片布局（横条 3 行/竖条底部）、命中（滚动后绝对索引、越界不命中）、
滚动夹紧、排序（新增 agent 不丢失）、空数据不 panic、回复（打开/退格/上限 400 字/输入区在窗内）。

## 二、编译矩阵（跨平台）

| 目标 | 结果 |
| --- | --- |
| x86_64-pc-windows-gnu | PASS |
| aarch64-apple-darwin | PASS |
| x86_64-apple-darwin | PASS |
| x86_64-unknown-linux-gnu | PASS |

> 期间工具链被一次中断的 rustup 同步破坏（missing manifest / std 缺失），
> 已用 USTC 镜像重装修复并复跑全部四个目标；产物 788 KB。

## 三、HUD 运行时（旧 canvas 外壳，历史记录）

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| 顶部形态 | `680,10 560x160 topmost=True` | PASS |
| 左侧形态 | `10,280 240x520` | PASS |
| 刘海形态 | `680,0 560x140` | PASS |
| 切回顶部 | `680,10 560x160` | PASS |
| 像素渲染 | 面板深色 83538 · 文字 424 · 芯片底 15022 · 绿点 16 · **红环 1869** · 琥珀 16 | PASS |
| 回复发送链路 | `--selftest-reply` → `to=s1 text=收到，马上处理 sent=true`，mock 收到同 JSON | PASS |
| 排序写回 + 读回 | saved 与 applied 完全一致 | PASS |
| 显示器上报 | `\.\DISPLAY1 1920x1080 primary` | PASS |
| 进程稳定性 | 12 秒驻留无崩溃 | PASS |

## 四、页面端到端（stub 引擎，端口 3479）

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| 两栏布局 | 左 [额度,用量,按 provider,设置] 右 [会话,消息] | PASS |
| 4 块瓦片 | 最紧额度 128% · 24h 花费 $101.41 · 在跑 1 · 等你 0 | PASS |
| 搜索过滤 | 输入「深链」→ 2 行，提示「2 个匹配 · 2 个在跑」 | PASS |
| 分页 | 26 个会话 → 第 1/2 页，每页 20 行 | PASS |
| 深链 | `?session=s0` → 会话详情对话框弹出 | PASS |
| 分区隔离 | 全部成功，无 `分区渲染失败` | PASS |
| 引擎缺失降级 | `/api/state` → `requires=engine`；页面提示「数据引擎未加载」 | PASS |
| 静态缓存 | `Cache-Control: no-store` | PASS |
| CSP 未回退 | `sandbox allow-scripts` + `connect-src` 仍在 | PASS |

## 五、面板与桥

| 检查 | 结果 |
| --- | --- |
| 三个面板页存在 | panel-agents / panel-usage / panel-settings PASS |
| 三个 loader 带 `#focus=` | PASS |
| `magpie.panels` 槽位 | agents, usage, settings PASS |
| 桥缺失时回落 | Rust 产物缺失 → 回落 `desktop-native`（Go GDI），`wanted=true` PASS |
| `enabled:false` 持久关闭 | `desktopWanted` 返回 false PASS |

## 六、无法自动化的部分（如实列出）

1. **IME 中文输入**：`WindowEvent::Ime::Commit` 路径已接通，但输入法需要真人按键，脚本无法模拟。
   发送链路已用 `--selftest-reply` 验证；「打字 → Enter」这一段需要你亲手试。
2. **拖动排序与窗口拖拽**：mousedown/mousemove 的真实手感（阈值 5px 判定点击 vs 拖动）需真人验证。
3. **macOS 产物**：只有 `cargo check` 通过 + CI 工作流；真二进制必须在 macOS runner 上产出。
4. **magpie 插件 host**：本会话多次起不来（环境问题），页面验证走的是自建 stub 服务。

## 七、本轮修复的真实缺陷（都会导致用户可见故障）

1. 单分区渲染抛错 → 整页停摆。改为 `safe()` 逐分区隔离。
2. `tokens.buckets` / `tokens.totals` 未守卫 → 引擎扫描未完成时「用量」整块挂掉。
3. 深链在 `try` 内 → 任一接口 500 就让「从 HUD 跳过来」失效。已挪到 `finally`。
4. 静态文件无 `no-store` → 插件更新后用户仍可能看到旧界面。
5. Linux 上 `tray-icon` 需要 GTK → 会给用户装系统依赖。已把托盘限定 Windows/macOS，
   且无托盘平台「隐藏」退化为「退出」，不会把用户锁在外面。
## 八、补齐三项（点击穿透 / 全屏收起 / 活动时间与轮播）

| 能力 | 实现 | 实测 |
| --- | --- | --- |
| 点击穿透 | 菜单项切 `window.set_cursor_hittest(!on)`（winit 跨平台 API） | `--selftest-clickthrough` → `正常点击=true 穿透=true 恢复=true` |
| 全屏自动收起 | `SHQueryUserNotificationState`（3=独占全屏、4=演示）每 2 秒查一次，进入即隐藏、退出即恢复 | 平时 `全屏检测=false`；判定映射有单测（2=BUSY 不隐藏、3/4 隐藏、5/6/7 不隐藏） |
| 活动时间 | `/api/agents` 的 `lastActiveMs` → 芯片右侧 `刚刚/Nm/Nh/Nd` | 像素差分：芯片年龄标签随时间变化 |
| 最近动作 + 轮播 | 「等你」会话标题 + 最近活动；底部每 4 秒轮播一条 | 像素差分：7 秒内 **1923 个像素**变化，覆盖底部行与芯片区 |

**顺带修的一个自己引入的缺陷**：菜单加到 5 项后高度 162px 超出 160px 窗口，会画到屏幕外。
行高压到 24（5×24+12=132）并对 `rect()` 加窗口内夹紧，同时加了三条单测（三种形态都不出界、
命中映射、每一项都点得到）。

**复查矩阵**：Rust 19 个单测 PASS；四目标 `cargo check` PASS；全 pack 243 PASS。