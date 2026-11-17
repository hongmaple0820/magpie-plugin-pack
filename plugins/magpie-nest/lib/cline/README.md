# Cline 渠道

鹊巢 magpie-nest 的 Cline 插件。单版本（id=`cline`）。

## 协议概览

| 项目 | 值 |
|------|-----|
| provider id | `cline` |
| npm（入站 SDK 形态） | `@ai-sdk/openai-compatible` |
| API host | `https://api.cline.bot` |
| WorkOS host | `https://api.workos.com` |
| WorkOS client_id | `client_01K3A541FN8TA3EPPHTD2325AR` |
| 令牌前缀 | `workos:`（**不可剥**，剥掉即 401） |
| 推理端点 | `POST /api/v1/chat/completions`（标准 OpenAI，SSE 也标准） |
| 推荐模型目录 | `GET /api/v1/ai/cline/recommended-models`（**匿名可读**） |
| 全量模型目录 | `GET /api/v1/models`（匿名可读，455 条，本插件**不用**） |
| 设备码申请 | `POST /user_management/authorize/device`（WorkOS） |
| 令牌轮询 | `POST /user_management/authenticate`（WorkOS） |
| 账号注册 | `POST /api/v1/auth/register` |
| 续期 | `POST /api/v1/auth/refresh` |
| 账号信息 | `GET /api/v1/users/me` |

## 登录

工作路线是 **WorkOS 设备码** 三步（对齐 OFM `cline-oauth.ts`）：

1. `POST {workOs}/user_management/authorize/device`，form `client_id=<id>`
   → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}`
   （实测 `verification_uri` 是 `https://authkit.cline.bot/device`，默认 300s / 5s）
2. 每 `interval` 秒轮询 `POST {workOs}/user_management/authenticate`，form
   `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…`
   → `{access_token, refresh_token, token_type}`
   ⚠️ **看 body 里的 `error`，不看状态码**：`authorization_pending` 继续轮询、`slow_down` 真的 +1s 退避、
   `access_denied` 取消、`expired_token`/`invalid_grant` 过期（**2026-11-17 实测假 device_code 就是 `invalid_grant`**）
3. `POST {api}/api/v1/auth/register`，JSON `{accessToken, refreshToken}`
   → `{success:true, data:{accessToken, refreshToken, expiresAt, tokenType, userInfo:{clineUserId,email,…}}}`
   register 会用 refreshToken 真去刷一次；**它挂了不致命**（WorkOS 令牌已可用），失败了就丢掉。

续期：`POST {api}/api/v1/auth/refresh`，JSON 是**驼峰** `{refreshToken, grantType:"refresh_token"}`。
响应与 register 同构，判据是 `success !== false && data.accessToken`——只看裸 `accessToken`
会把 `{success:false, error:…}` 的失败信封当成功。`expiresAt` 是 **ISO 8601 字符串**。

另一条入口是「粘贴令牌」：把浏览器里那条 `workos:eyJ…` 直接贴进来即可，前缀会自动补。

> ⚠️ **access_token 必须保留 `workos:` 前缀**，上游 `Authorization: Bearer workos:<jwt>` 少前缀就 401。
> 只有解 JWT 取过期时间时才 `replace(/^workos:/, "")`。

## 推理协议

上游就是 **OpenAI Chat Completions**，插件几乎只做透传：

- 请求：`POST {api}/api/v1/chat/completions`，`Authorization: Bearer workos:…`
- 头族必带：`HTTP-Referer: https://cline.bot`、`X-Title: Cline`、`X-IS-MULTIROOT: false`、`X-CLIENT-TYPE: cline-sdk`
- 请求体透传 `messages`/`tools`/`temperature`/`max_tokens`/`stop`/`reasoning_effort`

插件只做三件事：

1. **思考增量搬家**：上游给 `delta.reasoning`（ChatLink 与 OFM 一致），本仓库与 DSH 只读
   `delta.reasoning_content` → 补写同值字段并**删掉**旧键（不双份）。流式逐行改，非 `data:` 帧原样透传。
2. **工具 schema 清洗**：递归删掉 `enum` 里的空字符串成员，清完为空则整个删掉 `enum` 键。
   Gemini 系上游见到 `enum:[""]` 会 400；数字/布尔枚举**保留**。
3. **错误分类**：401/403 且命中地域限制文案 → `x-magpie-sign-in: kept`（换号没用，是本地区不可用）；
   否则 401/403 → `expired`（重新登录）；402/429 → `kept`（额度问题，可换号）。

### 思考档位（远端不下发，全模型共用一张表）

| wire id | OFM 里的显示名 | 实测思考字符数（2026-10-05） |
|---------|----------------|------------------------------|
| `none` | None | 0 |
| `low` | Low | 67 |
| `medium` | Medium | 379 |
| `high` | High（**默认**） | 294 |
| `max` | Extra | 1192 |

> ⚠️ **`variants` 的键必须是 wire id**（`none/low/medium/high/max`），不能用显示名。
> magpie 只取 `Object.keys(variants)` 当档位名（`internal/plugin/host.js:2357`），值整块丢弃；
> 曾经这里用 `None/Extra` 当键 → 一个梯队词都不认 → DSH 里 cline 全部模型没有档位可选。
> 代价只是 DSH 里 `max` 显示成 `max` 而不是 `Extra`。
> ⚠️ **不传 `reasoning_effort` 就是不思考**，所以本插件声明默认 `high`（OFM `CLINE_DEFAULT_REASONING_EFFORT`）。
> 代价是思考 token 计入 `completion_tokens`。
> ⚠️ **请求侧绝不做档位白名单**：上游对不认识的档位静默忽略不报错
> （实测 `reasoning_effort:"banana"` → 200 且 0 思考），本地校验只会把新档位挡在门外。

## 远端模型目录

`GET {api}/api/v1/ai/cline/recommended-models`，**无需认证**，响应键 `recommended / free / clinePass / clineCloud`。

- 只取 `free` → `recommended` → `clinePass` 三段，**跳过** `/api/v1/models` 的 455 条裸 id：
  那段会把免费模型挤出视野，还会让 magpie 写进 DSH 的配置体量暴涨。
- **免费判定只认 `free[]`**：实测当日三条 free 里 `nvidia/nemotron-3.5-lightning-free` 既不是
  `cline-free/` 前缀也不是 `:free` 后缀，靠 id 猜必然漏。
- 兜底表元数据优先，其次由 id 派生名字（`cline-free/solar-mini4` → `Solar Mini 4`）。
- 缓存 **5 分钟**（按 `site.api` 分桶）；非 2xx / 解析出 0 条 → 回退兜底表并留日志。
- `free[]` 会轮换，所以列表以远端为准，兜底表只在远端不可用时整表顶上。

## 兜底模型表（3 条，2026-11-17 实测 free[]）

| id | name | ctx | maxTokens | image |
|----|------|-----|-----------|-------|
| `cline-free/nemotron-3.5-super-vl` | Nemotron 3.5 Super VL | 200K | 0（未知） | ✅ |
| `cline-free/solar-mini4` | Solar Mini 4 | 200K | 0（未知） | ❌ |
| `nvidia/nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 200K | 0（未知） | ❌ |

> ⚠️ 窗口与输出上限上游不给，就填 200K/0，**不编造**。

## 坑（实测，不要顺手改）

1. **别剥 `workos:` 前缀**：那是上游要求的 Bearer 值本身，剥掉整条渠道 401。
2. **令牌错误看 body `error` 不看状态码**：WorkOS 用 400 + `{error:"authorization_pending"}` 表示「还在等」。
3. **`invalid_grant` 要归到「重新登录」**：假/过期 device_code 实测就返回它，不是网络错误。
4. **register/refresh 判据是 `success && data.accessToken`**：失败信封同样带 `success` 字段。
5. **思考字段是 `delta.reasoning`**：不是 `reasoning_content`，不搬家 DSH 就看不到思考过程。
6. **npm 必须是 `@ai-sdk/openai-compatible`**：上游本来就是这套协议，声明 `anthropic` 会让入站
   变成 `/v1/messages`，被路径闸门本地 404。
7. **不要请求 `/api/v1/models` 做模型列表**：455 条会把免费模型淹掉（见上）。
8. **401/403 先排除地域限制**：命中 `not available in your region` 之类的文案时换号没用，要标 `kept`。

## 目录结构

```
lib/cline/
├── constants.mjs   # 协议常量、头族、思考档位表、兜底模型表、modelRows()/modelEntry()
├── login.mjs       # WorkOS 设备码三步 + 续期 + 令牌前缀
├── catalog.mjs     # 远端推荐目录（5 分钟缓存，失败回退兜底表）
├── chat.mjs        # OpenAI 透传 + reasoning 搬家 + 工具 schema 清洗 + 错误分类
├── index.mjs       # 插件入口（ClinePlugin 导出）
└── README.md       # 本文件
```

## 参考实现

- F:\maple\tmp\dsh-our-free-model\vendor\channel-pack\src\cline-*.ts（`cline-product.ts` / `cline-oauth.ts` / `cline-adapter.ts` / `cline-models.ts`，权威）
- F:\maple\ChatLink\src\main\providers\builtin\cline.ts
