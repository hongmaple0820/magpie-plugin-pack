# gemini
**Gemini Code Assist**（Cloud Code / Antigravity 通道）作为 magpie / OpenCode 供应商插件。

这不是 Gemini 的公开 API，而是 Cloud Code 工具链说的 **v1internal** 协议。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login gemini
```

粘贴**整份 Google 凭据 JSON**：

```json
{"access_token":"…","refresh_token":"…","expiry":0,"cloudaicompanionProject":"…"}
```

> **必须带 `refresh_token`**：access token 只有 1 小时有效期，只贴裸 token 的账号一小时后必废。refresh token 是签发给 Cloud Code 客户端的，只能由该客户端兑换，所以插件内置了那个公开的 client_id/secret 用于续期。

## 模型

`gemini-3.8-flash-low` / `-medium` / `-high` / `-tiered`。

**裸名 `gemini-3.8-flash` 会 404**，只接受带 tier 后缀的名字。上游对未知模型名不报错而是静默跑 3.8，所以插件在本地就拒绝未知名。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` |
| 探测 | `/v1internal:loadCodeAssist`，body 逐字为 `{"metadata":{"ideType":"ANTIGRAVITY"}}` |
| 续期 | `POST https://oauth2.googleapis.com/token` |
| 信封 | `{model, project, request:{contents, generationConfig, systemInstruction, sessionId}}` |
| 流 | `{"response":{candidates:[{content:{parts}}],usageMetadata}}`（有时是裸的） |

**客户端身份是硬要求**：`User-Agent: antigravity/4.3.0 (cmdc-pak)` 加四个 `x-client-*` 头，只有 `Authorization` 不够。**刻意不发** `x-goog-api-key` / `x-goog-api-client`。

**project 是每账号的**：先调 `loadCodeAssist` 问；免费档常回空，此时回退 `aicode-consumers`。

**思考走 part 标记**：`parts[]` 里 `thought: true` 的片段是思考，其余是正文。

## 许可

MIT。协议事实与客户端常量（OAuth client secret）参考 ChatLink（GPL-3.0）的适配器，代码为独立重写；常量以机械方式搬运。
