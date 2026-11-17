# MiniMax Code（中国版）渠道

鹊巢 magpie-nest 的 MiniMax Code 插件。单版本（id=`minimax`）。

## 协议概览

| 项目 | 值 |
|------|-----|
| provider id | `minimax` |
| npm（入站 SDK 形态） | `@ai-sdk/openai-compatible` |
| OAuth host (authBase) | `https://account.minimax.cn` |
| API host (api) | `https://agent.minimax.cn` |
| client_id | `mcode-public` |
| audience | `agent-backend` |
| scope | `agent.default` |
| 推理端点 | `POST /mavis/api/v1/llm/v1/messages` (Anthropic Messages, SSE) |
| 模型目录 | `GET /mavis/api/v1/models?region=cn&buildEnv=prod` |
| 设备码申请 | `POST /oauth2/device/code` |
| 令牌轮询/续期 | `POST /oauth2/token` (标准 OAuth2 token endpoint，被哈工大 secret-scrubber 遮蔽) |
| 撤销 | `POST /oauth2/revoke` |

## 登录

仅设备码 OAuth（自动化流程）：

1. 生成 PKCE verifier/challenge (S256)
2. 打开授权页：`{authBase}/oauth2/device/code` (form-urlencoded，含 `client_id`、`scope`、`audience`、`code_challenge`、`code_challenge_method=S256`)
3. 用户在浏览器完成授权
4. 每 2 秒轮询 `POST {authBase}/oauth2/token`，body: `grant_type=urn:ietf:params:oauth:grant-type:device_code` + `device_code` + `client_id` + `code_verifier`
5. ⚠️ **关键坑**：MiniMax 用 **HTTP 200 + `status=pending`** 表示「还在等」（非标准 400+error），两种形态都必须认；`slow_down` 时间隔 +5s；`denied/access_denied` 取消；`expired/expired_token` 过期
6. 拿到 `{access_token, refresh_token, expires_in, token_type, scope}`，access_token 非 JWT（前缀 `mmoat_`，60 字符），必须由 `expires_in` 自算 `expires_at`

续期用 `grant_type=refresh_token`，同一 token endpoint，需带 `client_id`、`scope`、`audience`。

## 推理协议

上游：**Anthropic Messages**（不是 OpenAI 兼容）。

- 请求：`POST {api}/mavis/api/v1/llm/v1/messages`，`stream:true`
- 头：`Authorization: Bearer <token>`、`Content-Type: application/json`、`Accept: text/event-stream`
- **不加** `anthropic-version` 头（实测不需要）

插件负责把 magpie 给的 OpenAI Chat Completions 请求翻译成 Anthropic Messages，再把上游 SSE 翻译回 OpenAI SSE chunks。

### 思考档位（实测）

| 模型 | `thinking_config.mode` | DSH 档位（`variants` 的键） | 下发形态 |
|------|------------------------|----------------------------|----------|
| `MiniMax-M3.1-Flash-Preview` | `forced_on` | `low,medium,high,xhigh,max`（远端另有 `default`，但不是 magpie 梯队词，不能当键） | **必须** `thinking:{type:'adaptive'}` + 根级 `output_config:{effort}`；传 `disabled` ⇒ 400 `requires adaptive thinking (2013)` |
| `MiniMax-M3` | `switchable` | `high`（= 开启思考）、`none`（关闭思考）；不设默认档 | `high`/`on`/其他值 ⇒ `thinking:{type:'adaptive'}`（**不带** `output_config`，M3 无远端档位）；`none` ⇒ `thinking:{type:'disabled'}`；**不发 thinking 即不思考**（服务端默认） |
| `MiniMax-M2.7` / `M2.7-highspeed` | `forced_on` | 无（不声明 `reasoning`） | **不发 thinking 字段**（服务端默认思考）；传 `disabled` 被静默忽略 |

> ⚠️ `variants` 的键必须是 magpie 梯队词：`none/minimal/low/medium/high/xhigh/max`（+别名 `light`/`extra_high`）。
> magpie 只取 `Object.keys(variants)`（`internal/plugin/host.js:2357`），值整块丢弃；不在梯队里的键
> 一个都匹配不上，**只剩 `none` 一档时 `dshModelLevels` 直接返回 nil**（`internal/agent/dsh.go:1935`），
> DSH 里就一个档位都不显示。所以 OFM 的 `on`/`default` 都不能直接当键：M3 的「开启思考」用 `high`
> 表达，M3.1 的 `default` 丢弃——远端真实档位另存在模型行的 `vendorEfforts` 里，由 `chat.mjs`
> 判断「有真档位」还是「只有开关」。
> ⚠️ `output_config` 是 **payload 根级**字段，和 `thinking` 并列——塞进 `thinking` 里面服务端不认。
> ⚠️ `forced_on` 的模型**绝不**追加 `none` 档：M3.1 会硬 400，M2.7 会被静默忽略（用户以为关了、实际没关）。
> ⚠️ M3 远端没有 `default_effort`，所以**不设** `defaultEffort`——擅自设成 `on` 会改变用户既有行为。

### 图片输入

仅 `M3.1` / `M3` 支持。Anthropic 格式：`{type:'image', source:{type:'base64', media_type, data:<裸 base64>}}` —— **不是** OpenAI `image_url`（会被 400 拒绝）。

### 工具调用

- assistant tool_call → `tool_use {id,name,input}`
- tool 结果 → user 消息内的 `tool_result {tool_use_id, content, is_error?}`
- **必须成对提交**：assistant 与它的 tool_result 在同一轮 user 消息里一起下发（Anthropic 硬性要求，否则 400 `tool call result does not follow tool call (2013)`）

## 远端模型目录（动态）

`GET {api}/mavis/api/v1/models?region=cn&buildEnv=prod`，头只有 `Authorization: Bearer` + `Accept`。

- 响应形状：`{providers:[{providerId:'minimax', config:{models:{<长id>:{name,limit,context_window_options,modalities,effort_options,default_effort,thinking_config}}, model_order:[...]}}]}`
- 缓存 **5 分钟**，按 token 分桶（多账号互不串号）
- 拿不到 / 非 2xx / 解析出 0 条 → 一律回退**兜底表**并留日志（目录是展示信息，不该让整个 provider 报错）
- 归一规则：窗口取 `context_window_options` 最大档（为空才用 `limit.context`，未知填 0）；`maxTokens` 只接受正整数；`defaultEffort` 必须落在档位表内；`name` 用条目自带的短名，`id` 用对象 key 的长名

## 兜底模型表（4 条，顺序照远端 model_order）

| id | name | ctx | maxTokens | image | thinkingMode | effortOptions（远端原样） |
|----|------|-----|-----------|-------|--------------|---------------------------|
| MiniMax-M3.1-Flash-Preview | M3.1-Flash-Preview | 1M | 128K | ✅ | forced_on | default,low,medium,high,xhigh,max（DSH 档位去掉 `default`） |
| MiniMax-M3 | M3 | 1M | 128K | ✅ | switchable | —（DSH 给 `high`/`none` 两态） |
| MiniMax-M2.7-highspeed | M2.7-highspeed | 200K | 128K | ❌ | forced_on | — |
| MiniMax-M2.7 | M2.7 | 200K | 128K | ❌ | forced_on | — |

> ⚠️ **口径**：contextWindow 填档位表最大档（M3.1 的 `limit.context` 是 512K 但 `context_window_options=[512K,1M]`，填 1M 避免过早压缩）。

## 坑（实测，不要顺手改）

1. **token endpoint 就是标准 `/oauth2/token`**：假 device_code 探测返回 `400 {"error":"expired_token",...}`，路由确实存在，不需要额外注入。端点也不要改成 `api.minimaxi.com`——那是开放平台 API-key 产品，只认 `X-Api-Key`。
2. **pending 双形态**：HTTP 200 + `status=pending` **与** 400 + `error=authorization_pending` 都要认。
3. **access_token 非 JWT**：前缀 `mmoat_`，60 字符，0 个点；过期时间**必须**由 `expires_in` 自算写入 `expires_at`。
4. **不要要求 uid**：设备码令牌响应里没有用户信息，`login.mjs` 的回调 uid 恒为 `undefined`；加 uid 校验等于登录成功后每个请求都本地 401。OFM 的请求头也只有 `Authorization`+`Accept`（+`Content-Type`）。
5. **npm 必须是 `@ai-sdk/openai-compatible`**：本插件自己把 `/chat/completions` 转成 Anthropic Messages；声明 `@ai-sdk/anthropic` 会让入站变成 `/v1/messages`，被路径闸门本地 404。
6. **空响应必须报错**：静默结束会让 harness 认为「模型正常回答但没内容」。
7. **SSE 收尾必须 flush buffer**：否则最后一条 `message_delta`（含 `stop_reason` + `usage`）会丢。
8. **signature_delta 必须忽略**：那是 thinking 块的签名，不是正文，误发会往回答里注入十六进制。
9. **历史 reasoning 不回传**：无签名会被拒。

## 目录结构

```
lib/minimax/
├── constants.mjs   # 协议常量、兜底模型表、站点配置、modelRows()/modelEntry()
├── login.mjs       # 设备码 OAuth + PKCE + 续期
├── catalog.mjs     # 远端模型目录（5 分钟缓存，失败回退兜底表）
├── chat.mjs        # OpenAI ↔ Anthropic Messages 双向翻译 + SSE 消费
├── index.mjs       # 插件入口 (makePlugin + MiniMaxPlugin 导出)
└── README.md       # 本文件
```

## 参考实现

- F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\minimax-*.ts (7 文件，权威)
- F:\maple\ChatLink\src\main\oauth\adapters\minimax.ts
- @magpie-community/opencode-minimax-auth (社区对应物，未装)