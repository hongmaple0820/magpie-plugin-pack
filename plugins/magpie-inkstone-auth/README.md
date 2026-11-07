# magpie-inkstone-auth

把「书生·端砚」（Discovery）接成 **一个 magpie 供应商 `inkstone`**：登录一次，Orbit Agent 通道与 TokenPlan API 通道的模型合成一张清单，所有 agent 都能用；多账号、故障切换、墨点用量由 magpie 负责。

同时也符合 OpenCode v1 插件形式（`config` / `auth` / `provider`），给 OpenCode 写的东西在这里不用改。

## 它替你做什么

| | 说明 |
| --- | --- |
| 登录 | **两种**：① 本机端砚客户端导入（`type:"api"`，Windows 专用，**不打开任何网页**，直接读 `%APPDATA%\inkstone-desktop` 的 DPAPI 凭据，推荐）；② 网页登录（`type:"oauth"`/`code`，magpie 打开 SSO 页 → 粘回跳地址）。两种都会自动签发并托管 TokenPlan API Key（删旧建新，永远能拿回完整值） |
| 模型 | `Orbit /local-agent/models` ∪ `TokenPlan /models`（只要 `openai_chat`）；**重名 id 走 TokenPlan API 通道**（标准 Chat Completions，少一次 `/chat/new`），Orbit 独有的走协议桥 |
| 请求 | magpie 把 agent 的 API 转成 Chat Completions 交给 `loader.fetch`；本插件按模型路由：标准请求直发 `discovery-api.intern-ai.org.cn/v1/chat/completions`（Bearer Key），Orbit 请求经 `lib/bridge.mjs` 翻译并把 SSE 还原成 Chat Completions 流 |
| 用量 | 墨点余额 + 5h/7d 窗口（已用量按 `limit - remaining` 换算，magpie 据此排序/停用账号）；`magpie quota` 与网关 `/v1/magpie/quotas` 都能看到 |
| 故障切换 | 401 / `AUTH_EXPIRED` → 返回带 `X-Magpie-Sign-In: expired` 的 401，账号被标记并停止承接请求；墨点耗尽 / 限流 → 429，服务端错误 → 502，交给 magpie 换下一个账号或模型 |
| 续期 | 这个 SSO **没有 refresh token**。`auth.refresh` 在 JWT 到期前主动校验，失效就标 `signIn:"expired"` 提示重新登录；API Key 缺失时顺手补签 |

## 安装与登录

```bash
magpie plugin add ./magpie-inkstone      # 文件夹就地加载，不安装任何东西
magpie plugin login inkstone             # 选一种登录方式
magpie plugin --json                     # 插件列出的方法、账号、模型
magpie provider test inkstone            # 每种 API 发一个很小的请求
magpie quota                             # usage 钩子
magpie plugin logout inkstone
```

两种登录方式，`magpie plugin login inkstone` 或应用里「书生·端砚」那行点登录时选一个：

**① 从本机端砚客户端导入（推荐，Windows）** —— `type:"api"`

- 不打开浏览器、不扫码、不粘贴：插件直接读 `%APPDATA%\inkstone-desktop\credentials\credential_*.bin` + `Local State`，用系统自带 `powershell.exe`(5.1) 的 `-EncodedCommand` 内联脚本做 DPAPI 解包，`node:crypto` 做 AES-256-GCM 解密，拿到 uaa JWT 与 ssoUid。
- **同账号重复登录只会替换、不会新增**：成功结果同时带 `accountId` / `uid` / `email`（顶层 + metadata 各一份），magpie 按这些字段去重。
- 不需要 `pwsh`(PowerShell 7) / `AesGcm` / .ps1 文件，不受执行策略限制；不联网校验 JWT。签发 API Key 那一步会联网，失败不影响 Orbit 通道。
- 要求：Windows、端砚桌面客户端已登录。凭据过期就在客户端里重新登录，再来 magpie 里重登一次。

**② 网页登录（跨平台兜底）** —— `type:"oauth"` / `method:"code"`

1. magpie 打开 OpenXLab SSO 登录页，用微信扫码或账号密码登录。
2. 登录成功跳回 `https://discovery.intern-ai.org.cn/` 时，**立刻复制整条地址栏**（形如 `…/?code=uaa::code::…`）粘贴到输入框；也可以只粘 `uaa::code::` 开头的那一串。`lib/sso.mjs` 会从完整地址、裸 code、带说明文字的一整段、甚至百分号编码过的地址里把 code 抠出来。
3. 插件用 code 调 `/users/auth` 换 JWT，再自动签发 TokenPlan API Key。

> 端砚 SSO 没有设备码 / 轮询端点，code 只在回跳 URL 里出现一次，magpie 也没有 OAuth 回调通道，所以「复制一次地址」是必须的。若登录页把地址栏里的 code 清掉了，按浏览器「后退」一次，或从历史记录里找回带 code 的那条地址再复制。

一个供应商可以登录多个**不同**账号（各账号名取 `accountId`，多账号共享 `inkstone` 供应商、墨点耗尽时 magpie 会换号）；同一账号重复登录会替换旧条目，不会在列表里堆出重复项。

在沙箱里试，别碰你真正在用的 magpie：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./magpie-inkstone </dev/null
m plugin --json
m plugin login inkstone
m provider test inkstone
m quota
```

应用里改了代码后，到「插件」把 `inkstone` 关掉再打开（终端每条命令本来就按文件夹当前内容加载）。

## 模型与协议细节

- 供应商 id 是 `inkstone`，agent 用 `inkstone/<model-id>` 指代。`config` 里有一份来自使用说明的静态清单，登录后由 `provider.models` 每账号刷新成线上并集；拉不到就保留原清单。
- 所有模型都声明 `@ai-sdk/openai-compatible`（Chat Completions）。Orbit 模型只是 `api.url` 指向 Orbit 基址，`loader.fetch` 按模型 id 与 URL 双重判断该走哪条通道。
- Orbit 协议桥（`lib/bridge.mjs`）：
  - 每次请求先 `POST /chat/new` 拿 `chat_id`，再 `POST /local-agent/messages`（`protocol_version: "2.0"`、`inference_kind: "detached"`、`system` 字符串数组、`tool_use` / `tool_result` 块、`thinking.enabled`、`metadata.client_version`）。
  - `tool_result.content` 必须是字符串且带布尔 `is_error`；同一条 user 消息里不能同时出现 `text` 和 `tool_result`；工具最多 64 个（超限时优先留已用过名字和 `web_search`）；端砚 `supports_attachments=false`，图片块会丢弃；连续同 role 合并。
  - 响应把 `thinking_delta` → `delta.reasoning_content`、`content_delta` → `delta.content`、`tool_use_start` / `tool_input_delta` → `delta.tool_calls`、`usage` → 末尾 `usage`、`message_end.stop_reason` → `finish_reason`，最后 `data: [DONE]`。改写了流式正文，所以不会带 `content-length` / `content-encoding`。
  - `stream:false` 时返回完整的 `chat.completion` JSON。开头就报错的流会返回真正的非 2xx，让故障切换生效；中途报错只能发一个错误 chunk。
- 支持思考的模型带 `variants: {off, high}`，模型选择器会出现推理档位；`free: true` 只按厂商标价 0 判定，不从倍率推断。
- 401 / `AUTH_EXPIRED` 会带 `X-Magpie-Sign-In: expired`（magpie 转发前会去掉这个头）；账号被标记后需要重新登录。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 唯一导出的插件函数：`config` / `auth`（2 种登录、loader 双通道路由、usage、refresh）/ `provider.models` |
| `lib/sso.mjs` | SSO URL、从粘贴内容提取回跳 code、换票、读用户、JWT 解码 |
| `lib/desktop.mjs` | 本机端砚客户端凭据：DPAPI + AES-256-GCM 解密 |
| `lib/tokenplan.mjs` | 墨点余额/套餐/Key 签发/API 模型清单 |
| `lib/orbit.mjs` | Orbit 的模型清单、`/chat/new`、SSE 消息流 |
| `lib/bridge.mjs` | Chat Completions ↔ Orbit 2.0 双向翻译、错误响应 |
| `lib/catalog.mjs` | 每账号的模型并集、缓存、OpenCode Model 映射 |
| `lib/usage.mjs` | 余额快照 → magpie usage 窗口 |
| `lib/http.mjs` / `lib/constants.mjs` | 信封/错误/鉴权头、各端点常量 |

## 测试

本机没有装 Bun/magpie，所以随包提供一套 **Node 22 可直接跑**的 mock 网络测试（Bun 下同样能跑）：

```bash
cd magpie-inkstone
npm test
# 等价于 4 个脚本：bridge / integration / desktop / install，均可用 bun <file> 直接跑
```

覆盖：SSO URL 与从任意粘贴文本（含百分号编码）提取 code、JWT 解码、本机客户端凭据的假 v10 记录解密、信封/401 处理、墨点快照、模型映射、协议桥双向翻译（文本/思考/工具调用/用量/错误/空流）、双通道路由、用量窗口、两种登录与 refresh、以及文件夹 / node_modules 两种本地安装形态。测试全部用 mock fetch 与临时目录，不会访问厂商、不读真实凭据。

真机验证仍需在有 Bun 与登录态的机器上按上面的沙箱命令跑 `magpie provider test inkstone` 与 `magpie quota`；`plugin: …` 开头的日志里有钩子的错误与插件打印。

## 发布

- `package.json` 已带 `keywords: ["opencode","opencode-plugin",…]`，npm 搜索 `<关键词> opencode` 能找到；`magpie.name` 让「已安装」里显示中文名，`magpie.maxConcurrency: 4` 限制每账号并发。
- 从 npm 加：`magpie plugin add magpie-inkstone-auth`；固定版本 `…@0.1.0`；从 git：`github:owner/repo[#ref]`。
- 想进推荐列表，给 `magpie-community/plugins` 的 `registry.json` 提 PR：
  ```json
  { "package": "magpie-inkstone-auth", "name": "书生·端砚", "providers": ["inkstone"],
    "summary": { "en": "Shusheng Inkstone coding plan.", "zh": "使用你的书生·端砚套餐。" } }
  ```

## 已知边界

- 本机客户端导入只支持 Windows（DPAPI + 系统自带 `powershell.exe`）；非 Windows、或没装 / 没登录端砚桌面客户端时请用网页登录。凭据里的 JWT 到期后需在客户端重新登录，再在 magpie 里重登一次。
- JWT 到期只能重新登录（厂商没有 refresh 端点）；`refreshLead` 设为 2 分钟，避免到期前反复调用。
- 网页登录后必须复制一次回跳地址：SSO 的 code 只在地址栏出现，登录页还可能用 `history.replaceState` 把它清掉。这是厂商 SSO 与 magpie 的登录契约共同决定的，插件端无法自动截获（要零粘贴只能重新引入本机浏览器 DevTools 方案）。
- TokenPlan 每账号最多 10 个 API Key，且**完整值只在创建响应里出现一次**（幂等重放只回 masked_key）。所以重新登录时插件会先删掉自己名下的旧 key 再建新的，保证每次都拿到完整 key，不会出现「API Key cannot be viewed again」导致 API 通道全 403。没有 API Key 时，API 通道模型不列出来，Orbit 通道模型照常可用。
- Orbit 每次请求都要新建会话（`detached`），多一轮 `/chat/new` 往返；API 通道没有这个开销。
- 插件能看到它转发的所有请求内容（对话、工具及结果），本插件只把它们发到 `*.intern-ai.org.cn`，不记日志、不落盘。
