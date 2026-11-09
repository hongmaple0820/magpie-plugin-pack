# magpie-lobsterai-auth

有道 **LobsterAI**（龙虾）作为 magpie / OpenCode 供应商插件：浏览器登录、SSE-only 的 OpenAI 兼容对话端点、以及带积分奖励的每日签到。

> English: [README.en.md](./README.en.md)

## 安装

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-lobsterai-auth"
```

装上后在「插件 → 已安装」里打开，再登录。

## 登录

```powershell
magpie plugin login lobsterai
```

选「浏览器登录 LobsterAI」：

1. magpie 打开 LobsterAI 登录页，在页面里完成登录。
2. 登录后浏览器会跳到 `127.0.0.1` 上的回调地址。**页面打不开是正常的**，那个端口本来就没有服务在听。
3. 把地址栏里**整条地址**复制下来粘回输入框；只粘 `code=` 后面那一串也可以。

登录成功会同时拿到 access token 与 refresh token。**刷新令牌需要三个客户端身份字段**（`uuid` / `firstKeyfrom` / `latestKeyfrom`），它们由插件在登录时生成并随账号保存，续期时原样回传；丢一个就得重新登录。

> 兜底方式：环境里打不开登录页时，可以选「手动粘贴 Access Token」。这样拿到的令牌没有刷新令牌，**过期后需要重新登录**。

## 模型

18 个，wire id 与显示名分开（部分上游 id 带厂商日期戳）：

| 显示名 | wire id |
| --- | --- |
| DeepSeek V4 Flash / Pro | `deepseek-v4-flash` / `deepseek-v4-pro` |
| Kimi K2.7 Code / Highspeed | `kimi-k2.7-code` / `kimi-k2.7-code-highspeed` |
| Kimi K2.6 / K2.5 | `kimi-k2.6` / `kimi-k2.5` |
| Qwen3.7 Max / Plus | `qwen3.7-max` / `qwen3.7-plus` |
| Qwen3.6 Plus | `qwen3.6-plus` |
| MiniMax M3 / M2.7 | `MiniMax-M3` / `MiniMax-M2.7` |
| Doubao Seed 2.1 Pro / Turbo | `doubao-seed-2-1-pro-260628` / `doubao-seed-2-1-turbo-260628` |
| Doubao Seed 2.0 Code | `doubao-seed-2-0-code-preview-260215` |
| GLM-5.2 / 5.1 / 5V Turbo / 5 | `glm-5.2` / `glm-5.1` / `glm-5v-turbo` / `glm-5` |

上游没有已知的模型目录端点，所以清单是静态的。

## 每日签到

```powershell
magpie accounts checkin lobsterai
```

四步：解析客户端版本 → 查活动槽位 → 读活动上下文 → 领奖。

**幂等由插件负责，不是服务端的业务码**：领奖请求带一次性 `idempotencyKey`，所以每次启动都无脑领一遍正是会被风控注意到的模式。插件会先读上下文的 `claimedToday` **并且**确认 `actions` 里有 `check_in` 才领——只看前者会漏掉「活动存在但今天不可领」这种情况。

## 两条承重头（不要删）

对话请求带两个 `X-LobsterAI-*` 头，它们是**功能开关**不是元数据：

- `X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1`
  - 少了 `kimi-k3-agentic-v1`：网关会静默返回一份**不含 kimi-k3** 的模型清单。
  - 少了 `thinking-level-control-v1`：`reasoning_effort: "off"` 直接 500。
- `X-LobsterAI-Client-Version`：客户端版本号，随上游发版会过时。

另外**刻意不发**腾讯系的 `X-Domain` / `X-Product` / `X-IDE-*` 归因头——LobsterAI 不读它们，发了反而错误归因客户端。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions` |
| 登录页 | `https://lobsterai.youdao.com/portal#/login`（**hash 路由**，query 必须手工拼在 `#` 之后） |
| 换令牌 | `POST /api/auth/exchange`，**不带 Authorization**，请求体 5 字段 |
| 续期 | `POST /api/auth/refresh`，**不带 Authorization**，凭 refreshToken + 三个身份字段 |
| 签到 | `/api/client-activities/slot` → `/{code}/context` → `/{code}/actions/check_in` |
| 信封 | `{code, data}`，**HTTP 200 也可能是失败**（code≠0） |

## 已知限制

- **端点 SSE-only**：`stream: false` 会被上游回 **500**。插件对所有请求都发 `stream: true`，非流式调用方由插件把流聚合成一条 completion。这不是可选优化。
- **仅文本**：上游不支持图片输入。
- **无配额接口**：插件不提供用量卡片，magpie 会显示「无配额报告」。不编造数字。
- 令牌过期后若刷新令牌已失效，账号会标记为需要重新登录，magpie 自动切到下一个账号。

## 与 ChatLink 的关系

本插件的协议事实参考了 [ChatLink](https://github.com/RC16348/ChatLink)（GPL-3.0）的行为：端点、字段名、业务码、承重头。**代码为独立重写，未复制其源码**，以 MIT 发布。

## 许可

MIT
