# 变更记录 · 鹊楼 (magpie-hud)

## 未发布 — 桌面 HUD 换成页面外壳（2026-11-16）

「桌面上没看到页面」「太丑太模糊」的直接修法：不再用 canvas 手绘，改成 tao + wry 开一个
无边框透明窗口，里面加载插件自己的 `webapp/hud.html`。

### 新

- `webapp/hud.{html,css,js}`：52px 状态栏（在跑数 / 客户端 / 待批 / 24h token / 24h 成本 / 最满额度环 / 展开）
  + 展开面板（在跑会话可点进面板、待批审批就地批准/拒绝、汇总、打开完整面板）；`?expand=1` 直接展开。
- 窗口高度由页面内容决定：页面发 `{cmd:"resize", h}`，外壳 clamp 40–900 后改窗；设置里的 `height` 只当初始值。
- 托盘新增「点击穿透（开 / 关）」。
- 页面服务白名单加 `hud.html` / `hud.js` / `hud.css` / `icon.svg`（白名单外仍 404）。
- `tools/dev/hud.mjs --port N`：本机起服务并拉 HUD 的预览入口（`--no-hud` 只起服务）。
- `package.json` 的 `files` 加 `desktop-rust/WebView2Loader.dll`——漏了它装完 HUD 起不来；
  `tools/check/packaging.mjs` 为这条单列一项检查。

### 修

- **拖动落点写不回去**：tao 重写时丢了「页面发 drag → 主循环装观察器」这一步，`drag` 永远是 `None`，
  拖完不会落盘。补上后停稳 600ms 写回 `/api/settings`（`position=custom`）。
- **页面整段不执行**：`hud.js` 里的 `const ipc` 与 wry 注入的全局 `ipc` 重名 →
  `SyntaxError: Identifier 'ipc' has already been declared`，窗口里只剩「—」。改名 `bridge` 并整段包 IIFE。
- 补回被误删的 `$` / `el` 两个辅助函数（`ReferenceError` 同样会让整页停在占位符）。
- `platform.rs` 的 `set_click_through` 读扩展样式时运算符链写错（`prev != -1 && … == on`），改为读回 EXSTYLE 核对目标位。
- 状态栏上的口径标签写实：`tok / 24h`、`24h`（`/api/tokens` 默认是滚动 24 小时，不是自然日）。
- WebView2 用户数据目录指到 `%LOCALAPPDATA%\magpie-hud\webview`，不再往插件目录写几百个缓存文件。

### 验收

`cargo test --release` 22/22、插件 187/187、`npm run check`、`packaging` 全过；
真机：`576x62` 收起 / `576x189` 展开、拖 −120/+80 后设置变 `x=280 y=380`、`POST x=400 y=300` 两秒内跟随。
详见 `docs/magpie-hud-verification.md` §零。

## 0.2.0 — 2026-11-16

v7 方案 P0–P6 一轮落地。每一处都对应一个「面板上看起来没事、其实在骗人」的具体毛病。

### 诚实性

- 只有写入时间的会话不再假装知道在跑没在跑：`source.kind === "mtime"` 的行 `phase` 一律 `unknown`，并给闭集原因（`no-truth-source` 等）；界面按证据等级分三档（证据 / 在线 / 近似）。
- 新增 `tools/check/honesty.mjs`：扫这台机器上真实会话，违例项退出码 1（无来源、mtime 声称状态、unknown 没原因、原因写成散文）。

### 额度

- 新增 `lib/usage/arbitrate.mjs`：同一窗口多源按 `observedAt` 取最新，同秒本地直连优先；结构不符只降级那一条源；读不出百分比 → `unknown`，不落 0。
- `/api/quotas` 增加 `windows` 与 `arbitration{sources,conflicts}`；面板标「N 源」「不一致」「读不出百分比」。

### 计价

- 新增 `lib/usage/pricing.mjs`：价格快照按事件时刻生效，历史成本换价后不变；同 `effectiveFrom` 不覆盖。
- 成本行带 `cost.quality{exact,backfilled,approximate,unknown}` 与 `costSnapshot`；查不到价格记 `usd: null`，不写 0。

### 桌面 HUD

- 单实例：命名互斥（`Local\magpie-hud-<port>`），第二个实例把已有窗口前置后退出；崩溃时内核释放，不留死文件。
- 摆位：按显示器**工作区**（`GetMonitorInfoW` 的 `rcWork`）clamp，留 8px；物理 → 逻辑像素折算修好高 DPI 偏移；`custom` 也 clamp。
- 拖动松手把 `(screen, x, y, w, h)` 写回设置。
- 修：建窗那一刻 `set_outer_position` 在 Windows 上被忽略（窗口还没 map），服务连不上时窗口停在占位坐标；第一轮事件循环补一次摆位。
- `started: true` 的含义收紧为「子进程已创建、拿到 pid」；面板设置页显示「桌面 HUD」真实状态（运行中 / 已关闭 / 启动失败 + 退出码 / 没有可执行文件）并可一键重试（重试会先删 `.failed` 标记）。
- 新增 `tools/bench/hud-smoke.mjs`：冷启动出窗 ≤3s、重复启动只剩一实例、窗口在工作区内留 8px、`started` 的进程状态可判定。

### 工具面

- 五个工具（`list_sessions` / `send_message` / `start_session` / `get_message` / `list_quotas`）各有三条契约断言（能用 / 拒绝 / 不可用），共 15 条，全部走 `AGENTS_TOOLS`。
- `start_session` 描述补全状态集：`started` / `refused` / `uncertain`（CLI 起不来或没报 job id —— 是的，确实不知道起没起）。

### 打包与 CI

- `package.json` 的 `files` 覆盖 `desktop-rust/` 与 `desktop-native/`，wails 时代的 `desktop/` 不再发布。
- 新增 `tools/check/packaging.mjs`：`files` 白名单、tarball 里 exe 存在且大小一致、解开的包能脱离仓库独立 `import`。
- 新增脚本：`npm run check`（诚实性 + 发布包）、`npm run smoke:hud`（桌面冒烟）。
- PR 上跑 `npm test` 与 `npm run check`；推 `hud-v*` 标签产出三平台二进制并把 tarball 附到 Release。

### 浸泡

- 采样改固定容量环形（20,000），不再无界增长；每 10s 写心跳；`status.mjs` 用 pid + 心跳 mtime 双判。
