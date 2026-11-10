# AutoClaw 双版本渠道（magpie-nest）

智谱 **AutoClaw（OpenClaw 云端账号体系）** 的 magpie provider。协议事实与两版差异均出自已装可用的社区实现
`C:/Users/Administrator/.config/magpie/plugins/node_modules/@magpie-community/opencode-autoclaw-auth/`（v0.2.21）。

## 两版差异

| 项 | autoclaw（国际版） | autoclaw-cn（国内版） |
|---|---|---|
| provider id | `autoclaw` | `autoclaw-cn` |
| 名称 | AutoClaw (Zhipu) | AutoClaw 国内 (Zhipu) |
| 登录方式 | Google / z.ai 网页 OAuth（本地引导页 + 阿里滑块） | +86 手机验证码（agent-send-code / agent-login） |
| API 域（登录/额度） | `https://autoglm-api.autoglm.ai` | `https://autoglm-api.zhipuai.cn` |
| 对话域 | `https://autoglm-api.autoglm.ai` | `https://autoglm-acceleration-api.zhipuai.cn`（managed gateway） |
| 对话路径 | `/autoclaw-proxy/proxy/autoclaw/v1/chat/completions` | `/autoclaw-proxy/proxy/autoclaw/chat/completions` |
| 对话指纹 | 官方 AutoClaw 2.0.3 desktop（X-Channel: official） | AutoClaw 2.1.0（X-Channel: AutoClaw26） |

出处：参考实现 `index.mjs:57-62`（host 与路径）、`index.mjs:2168-2181`（provider id/名称）、`README.md:11-14`。

## 协议事实

- **鉴权形态**：oauth access token。对话请求用 `X-Authorization: Bearer <access token>`，且必须**删除** `Authorization` 头（参考 `index.mjs:613/1316` 与 `index.mjs:611/1317`）。登录/积分等 envelope 接口才用普通 `Authorization: Bearer`（`bizHeaders`，`index.mjs:527-547`）。
- **必需业务签名**：`X-Auth-Sign: md5("100003&<秒级时间戳>&<appKey>")`，配合 `X-Auth-Appid: 100003`、`X-Auth-TimeStamp`、`X-Product: autoclaw`、客户端 UA（`index.mjs:27-44`、`index.mjs:513-547`）。缺这套 WAF 会拒登录/对话请求。
- **对话网关 406 坑**：缺任一条都回 `406 Not Acceptable` 且 body 为空（`README.md:105-111`）：
  1. system 消息必须以 `You are AutoClaw. Answer the user directly and concisely.` 开头（插件自动加前缀/补最小 system，`index.mjs:452-469`）。
  2. 必须删 `max_tokens` / `max_completion_tokens`（`index.mjs:471-472`）。
  3. 不得发送 `X-Harness-Type`（`index.mjs:612`）。
  4. system 里出现外部 harness 身份句会被拦（`DeepSeek Harness`、`Claude Code`、`Codex` 等），插件 `unflag` 改写已知句式（`index.mjs:66-145`，本目录为 abridged 子集）。
- **国际版对话指纹**：`X-Channel: official`、`X-Version: 2.0.3`、`X-Lang: en`、`X-Client-Type: pc`、`x_trace_id: autoclaw-desktop`、`X-Session-Id`（同一对话不变）、OpenAI/JS 6.26.0 UA 与 `X-Stainless-*`（`index.mjs:583-614`）。
- **国内版对话指纹**：`X-Channel: AutoClaw26`、`X-Version: 2.1.0`、`X-Agent-Id: main`、`X-Request-Model`（`index.mjs:1302-1318`）。
- **403 不一定是登录失效**：`code 810000`/额度文案 → 转 429（保留登录）；`code 410004`/封禁文案 → 403 保留登录（`index.mjs:271-341`）。本目录按同规则处理；请求过大误报 401（`README.md:126`）未移植，见「存疑点」。
- **模型**：上游在线模型为 `zai_auto` / `zai_auto-fast` / `zaicoding_glm-5.3` / `zai_glm-5.3-flash`（`index.mjs:485-503`）；`zai_glm-5-turbo` 与豆包映射已下线（`README.md:22`）。国内版带 reasoning variants low/high/max。
- **国际登录本地 OAuth**：回调必须落在官方 TokenServer 端口池 18432/19654/19723/53699，路径固定 `http://localhost:<port>/auth/callback-<vendor>`；上游授权页下发的 `state` 必须原样带回校验（`index.mjs:1830`、`index.mjs:1903-1954`）。引导页完成阿里滑块后凭 `ali_captcha_verify_param` 换取授权页地址（`index.mjs:1909`）。
- **国内登录**：`POST /userapi/v1/agent-send-code` 发码 → `POST /userapi/v1/agent-login/` 用验证码换 token（`index.mjs:1727-1776`）；验证码必须按数字发送（`index.mjs:679`）。

## 登录路径

- `autoclaw`：网页 OAuth（Google / z.ai），本地引导页自动完成滑块与回调捕获，无需复制粘贴。
- `autoclaw-cn`：手机验证码，`authorize` 发码后宿主以 code 流程回填验证码。

token 响应转 `{access, refresh, expires}`（expires 取 JWT `exp` 减 10 分钟，`index.mjs:685-697`）。

## 文件

- `constants.mjs` — REGIONS 表、模型行、stripModel、协议常量
- `headers.mjs` — 签名/指纹头、请求整形、错误映射、envelope 调用
- `login.mjs` — 两种登录方式（短信 + 国际本地 OAuth）
- `index.mjs` — 两个 plugin 导出
