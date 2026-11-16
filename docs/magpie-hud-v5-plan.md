# 鹊楼 v5：把「只能看」补成「能答」

问题不是界面不好看，是**环路断了**：面板能看见「某个会话在等你批准」，却没有任何办法把答案送回去。
v5 只做一件事——把这条回程修通，并让它在真实的 DSH 里可验证。

## 1. 为什么之前的结论是「做不了」

magpie 插件的 tool 钩子拿到的是 `ctx = { agent, abort, directory }`，没有审批/提问应答接口
（`internal/plugin/*` 的钩子签名就这么多）。审批是**客户端进程内存里的一个 Promise**，
面板在另一个进程（magpie）里，跨进程没有句柄可用。

死路验证过的两条：

| 想法 | 为什么不行 |
| --- | --- |
| 面板直接调 DSH 的 HTTP 接口 | DSH 不暴露审批接口；`/api/sessions/*` 只在 wails 内部源，网关 3425 还需 Bearer（本机无 caller-keys.json） |
| 读转录后「假装已批准」写文件 | 转录是结果不是入口；写进去只会让下一次扫描读出脏数据 |

## 2. 做法：在 DSH 进程里放一段自己的代码

`dsh/magpie-hud.mjs` 由用户在设置页点一次「装到 DSH」后，被写进 `$DSH_HOME`，
由 DSH 自己加载（`cordis.patch.yml` 的托管段）。它跑在 DSH 进程里，所以能拿到
`approval/request` 与 `user-questions/request` 的抢占点。

协议是**纯文件 + 轮询**，零依赖，两个进程各读各写：

| 路径（`<channel>/`） | 谁写 | 谁读 | 含义 |
| --- | --- | --- | --- |
| `plugin.json` | 通道插件 | 面板 | 15s 心跳（at/host/pid），面板据此判断「通道在线」 |
| `app.json` | 面板 | 通道插件 | 10s 内算「有人在看」，用于决定要不要等面板 |
| `sessions/<id>.json` | 通道插件 | 面板 | 打开着的会话每 5s 签到；关闭写 `{ended}` |
| `asks/<id>.json` | 通道插件 | 面板 | 一张等答的卡（审批 / 提问） |
| `asks/<id>.answer` | 面板 | 通道插件 | 答案，**先到者胜**；写完即删卡 |
| `asks.log.jsonl` | 面板 | 面板 | 谁在什么时候答的（活动流） |
| `prompts/<session>/<n>.json` | 面板 | 通道插件 | 往会话里说一句 |
| `prompts/<session>/<n>.state` | 通道插件 | 面板 | queued / sending / delivered / refused / failed / expired / cancelled |

答案形状（两边各有一份校验，形状不对就当没答、继续等）：

- 审批：裸字符串 `"allowed-once"` 或 `"rejected"`。
- 提问：`{ answers: [{ id, selected: string[], custom? }] }`，**条数与题号必须和题一一对上**。

关键实现细节：

- `request.signal = AbortSignal.any([原 signal, ours.signal])`，`Promise.race([客户端自己的 UI, 面板])`。
  面板赢 → abort 客户端那边并返回面板答案；客户端赢且报 `NO_PROVIDER` 且有人在看 → 继续等（上限 10 分钟）。
- 只认根会话：`NAME.test(agent.id) && !agent.parent && !agent.parentId`，子 agent 的审批不抢。
- 回复下发靠 `controller.prompt({ requestId, sessionId, mode: "queue", content: [{type:"text",text}] })`；
  拿不到 sessionController 就写 `refused`，不假装成功。
- 所有写都是「临时文件 + rename」；所有定时器 `safe()` 包裹；`ctx.effect` 卸载时停干净。

## 3. 面板侧

- **待你处理**分区（页面右栏第一块）：审批卡给「允许一次 / 拒绝」+ 折叠的参数；提问卡按题型渲染单选/多选 +
  自由输入，逐题校验后才放开「提交答案」。答完卡片就地变成「已允许，等它接手…」，不跳走。
- **设置页「回话通道」**一行：在线 / 已装等重启 / 已装没连上 / 未安装，带「装到 DSH」「卸载」。
- **会话抽屉**底部「说一句」：8 字以上也能发，600ms×20 轮问状态，最后诚实显示「已送达」或「已发出，还没确认」。
- 服务端四条新路由：`GET /api/channel`、`POST /api/asks/answer`、`POST|GET /api/prompt`、
  `POST /api/channel/install`。

## 4. 桌面 HUD（Rust）

`/api/channel` 的卡也进轮播，排序是「压着的卡 > 会话在等你 > 最近有活动」：

```
chips=1 attention=4
carousel[0] 审批 · 14m · 等你批准 Bash
carousel[1] 提问 · 12m · 等你回答一个问题
carousel[2] 审批 · 3m · 等你批准 Bash
carousel[3] Claude Code · - · 在等你：会话 2
```

统计行在有卡时追加「· N 张卡在等你」。

**顺手修掉的真 bug**：`desktop-rust/src/http.rs` 原来只按 `\r\n\r\n` 切头，不拆 chunked；
而插件服务（`lib/pageservice.mjs` 的 `send()` 不写 Content-Length）一律回 `Transfer-Encoding: chunked`
→ serde_json 全部解析失败 → 桌面 HUD 对真实服务永远是全零。之前所有 Rust 数据验证都跑在自写的
mock（显式给了长度）上，这条路径从未被验过。现在 `get()` 走 `decode()/dechunk()`（按字节切，
块边界可能落在多字节字符中间），3 个单测兜住。

## 5. 验证证据

- `node --test test/*.test.mjs`（插件）：96 通过；`node scripts/test-all.mjs`（全 pack）：全绿。
- `cargo test --release`：22 通过（含 chunked 3 条）。
- 页面端到端（stub 服务 3479 + 夹具 `F:/rust/chan-test`）：
  点「允许一次」→ 写出 `{value:"allowed-once",at,by:"panel"}`；
  两题选出 `q1:["b"] / q2:["unit","e2e"]` → 写出的形状与 `acceptAnswer` 要求一致；
  点会话行 → 抽屉里可见「说一句」，发送后写出 `prompts/s2/<id>.json` 并显示「排队中…」→（模拟插件取走）「已送达」。
- 修复后截图对比：额度环从「—%」（永远空）变成真实 128/100/42——只认 `w.usedPercent` 而引擎给的是
  `w.percent`，这类字段名不一致是「看着像好的、其实一直空着」的典型；同样修掉 `undefined 个账号`、
  `undefined 次`、`Invalid Date`。

## 6. 已知边界（不假装完整）

- 通道插件只对 **DSH** 有效：Claude Code / Codex / Antigravity 的审批在它们自己的进程里，
  没有可挂载的钩子，面板对它们只能「看见 + 带你去」。
- 提问的 `timed` 卡过期后答案无意义，面板标「可能已过期」，但仍允许提交（由插件侧 TTL 兜底）。
- Windows 上窗口方角是已知取舍（圆角会露出 wails 磨砂层）。
- 真实 `$DSH_HOME` 的安装/重启验证留给用户点按钮（不替用户改他的 DSH 配置）。

## 7. 用户要做的一步

设置页 →「回话通道」→ 点「装到 DSH」→ 重启 DSH。之后审批与提问会同时出现在 DSH 和鹊楼，
哪边先答哪边算。
