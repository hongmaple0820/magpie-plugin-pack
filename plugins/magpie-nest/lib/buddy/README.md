# buddy（腾讯双产品/双版本渠道）

腾讯的两条 WorkBuddy/CodeBuddy 产品线：**WorkBuddy AI（国际版）**、**WorkBuddy（中国版）**、**CodeBuddy（中国版）**。三者共用同一套授权 + 推理协议，产品差异全部参数化在 `constants.mjs` 的 `PRODUCTS` 表里，loader 逻辑在 `shared.mjs` 中共享。

## 产品表

| provider id | 产品 | 站点 | API endpoint | platform | 客户端形态 |
| --- | --- | --- | --- | --- | --- |
| `workbuddy-ai` | WorkBuddy AI（国际版） | https://www.workbuddy.ai | https://www.workbuddy.ai | `workbuddy-ai` | `WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0` |
| `workbuddy` | WorkBuddy（中国版） | https://www.workbuddy.cn | https://copilot.tencent.com | `workbuddy` | `WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0` |
| `codebuddy` | CodeBuddy（中国版） | https://copilot.tencent.com | https://copilot.tencent.com | `ide` | `CodeBuddyIDE/1.106.1` |

注意 `workbuddy`（中国版）的**站点与 API 不同域**：keys 页在 www.workbuddy.cn，API 走 copilot.tencent.com（出处：opencode-workbuddy-auth/index.mjs:72、:87、:416-419）。id 拼写以已装插件 `@magpie-community/opencode-workbuddy-auth` 的 README.md:6-9 为准（`workbuddy` / `workbuddy-ai`）。

## 授权协议（三个渠道同一套）

1. `POST /v2/plugin/auth/state?platform=<platform>` 拿 `{state, authUrl}`。**必须带 5 个 `X-No-*` 头**（`X-No-Authorization` / `X-No-User-Id` / `X-No-Enterprise-Id` / `X-No-Department-Info` + `X-Domain`），声明「本请求无身份」，否则控制面按已登录请求直接拒绝（ChatLink src/main/oauth/adapters/codebuddy.ts:23-25）。
2. 打开 authUrl —— 授权完全在腾讯域内完成，没有本地回调服务器、没有 code（同文件 :8-15、:17-19）。
3. 轮询 `GET /v2/plugin/auth/token?state=…`（Bearer 前无需认证）；**11217 = token 未就绪，继续等**（同文件 :14、:110）。
4. 拿到 token 后轮询 `GET /v2/plugin/login/account?state=…`；**12151 = 账户未就绪，继续等**（同文件 :15、:112）。这里 `token.domain` 可能为空串，`X-Domain` 必须回退产品 apiDomain（同文件 :26-28）。
5. WorkBuddy 两版登录 URL 还要追加 `version` + `loginSessionId`；CodeBuddy 不需要（同文件 :279-295）。

一键登录走 `type:"oauth"` + `method:"auto"`：宿主打开 authUrl，插件在 callback 里轮询到令牌为止（5 分钟超时）。粘贴令牌走 `type:"api"`——控制面**没有**「拿 access token 直接验证」的端点，真失效会在首次推理时以 401 暴露（ChatLink src/main/providers/builtin/codebuddy.ts:432-439 的诚实说明）。

**enterpriseId 可选**：一键登录从 login/account 自动带回并随请求发送；粘贴令牌没有 enterpriseId 输入位（magpie 的 api 方法只有 key 一个字段，internal/plugin/providers.go:28-36）。企业席位请用一键登录，个人账号两个头都不发（ChatLink builtin/codebuddy.ts:17-21）。

## 推理协议

`POST /v2/chat/completions` 是标准 OpenAI chat completions + SSE（`delta.content` / `delta.reasoning_content` / `delta.tool_calls`），直接转发即可（ChatLink builtin/codebuddy.ts:6-9）。

### 必需头族

掉头会被网关降级/被拒（同文件 :13-15）：

- 归属头族：`X-Product` / `X-Product-Code` / `X-IDE-Name` / `X-IDE-Type` / `X-IDE-Version` / `X-Agent-Purpose: conversation`（三渠道不同值见 PRODUCTS 表）。
- WorkBuddy 两版附加：`X-Agent-Intent: craft`、`X-Requested-With: XMLHttpRequest`、`X-Agent-Type: main`、`X-Agent-Runtime: local-agent`（opencode-workbuddy-auth/index.mjs:349-407）。
- `X-Domain`：一键登录带 token.domain，粘贴令牌回退产品域。
- `X-Enterprise-Id` 与 `X-Tenant-Id`（同值）：仅当 enterpriseId 非空时发送（opencode-workbuddy-auth/index.mjs:434-443）。

### UA 分档（WorkBuddy AI 国际版）

网关按 UA 判断使用端，**不匹配会被拒绝**（ChatLink builtin/workbuddy.ts:16-18）：

| 模型族 | UA 档 | UA |
| --- | --- | --- |
| `gpt-` / `gemini-` / `claude-`（国际模型线） | intl | `WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0` |
| `glm-` / `hy` / `kimi-` / `minimax-`（国内模型线） | cn | `WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0` |
| 未命中 | **默认 intl（国际版）** | 同 intl 行 |

匹配在 wire id（去前缀后的裸 id）上跑，前缀全是小写（同文件 :69-70）。中国版 `workbuddy` 只有国内客户端形态一档（opencode-workbuddy-auth/README.md:141-143），`codebuddy` 用 `CodeBuddyIDE/1.106.1`——两者 `uaTiers` 都为空，任何模型都落 `uaDefault`。

### 会话身份头（WorkBuddy 两版）

桌面端每会话发三个身份头：`X-Conversation-ID`（会话稳定）、`X-Conversation-Message-ID`、`X-Conversation-Request-ID`（每请求刷新），另带 `X-Request-ID`；`prompt_cache_key` = 会话 id（仅 `workbuddy-ai` 设，命中 prefix cache 积分差约 17 倍，ChatLink builtin/workbuddy.ts:19-24、:80-84）。本插件简化：会话 id 按 `x-magpie-buddy-session` 头缓存，message/request id 每请求随机。

### 坑

- **未知名模型不报错**，网关静默换模型回答 —— 插件在本地 404 拒绝（loader 内）。
- **UA 不以 `WorkBuddy/<version>` 开头**会被答 error 10085（opencode-workbuddy-auth/index.mjs:8-9）。
- 聊天**只接受流式**（opencode-workbuddy-auth/README.md:99-100）。WorkBuddy 的 Claude 模型在中国版走 Anthropic Messages API，本插件未实现该路由（README.md:102-109）。
- WorkBuddy 自己的客户端把模型请求 gzip 后发出（`RequestBodyGzip`）；本插件对 WorkBuddy 两版同样 gzip，CodeBuddy 平发（README.md:313-315）。
- 模型 id 要用裸 wire id（如 `glm-5.3-flash`），显示名 `GLM-5.3-Flash` 不是可用 id（README.md:508-510）。

## 协议出处（file:line）

- `F:/maple/ChatLink/src/main/oauth/adapters/codebuddy.ts` :71-91 产品表、:101-112 端点与未就绪码、:185-220 auth/state、:222-246 token 轮询、:248-277 account 轮询、:279-295 URL 追加参数、:432-466 粘 token 校验的诚实边界
- `F:/maple/ChatLink/src/main/providers/builtin/codebuddy.ts` :23-45 CodeBuddy 头族与 enterpriseId 模板、:49-66 模型映射
- `F:/maple/ChatLink/src/main/providers/builtin/workbuddy.ts` :34-65 国际版头族与会话身份头、:66-79 UA 分档、:80-84 prompt_cache_key
- `C:/Users/Administrator/.config/magpie/plugins/node_modules/@magpie-community/opencode-workbuddy-auth/index.mjs` :68-115 SITES 表、:230-243 token 字段映射、:349-407 sign/chatHeaders 头族、:434-443 enterpriseHeaders、:1740-1751 poll、:1753-1796 browserSignIn
- `同上 README.md` :6-12 产品 id 表、:99-109 chat 端点与 Claude 路由、:138-166 请求头清单、:313-315 gzip

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）与 @magpie-community/opencode-workbuddy-auth（MIT）的行为，代码为独立重写。
