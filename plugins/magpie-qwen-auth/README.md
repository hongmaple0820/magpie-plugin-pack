# magpie-qwen-auth

**通义千问网页版**（qianwen.com）作为 magpie / OpenCode 供应商插件。走网页会话，不是 API Key。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-qwen-auth"
magpie plugin login qwen-web
```

粘贴 `tongyi_sso_ticket`：登录 qianwen.com 后 F12 → Application → Cookies。

## 模型

Qwen3.8-Max、Qwen3.7-Plus、Qwen3.8-Flash、Qwen3.5-Plus、Qwen3-Max、Qwen3-Max-Thinking、Qwen3-Plus、Qwen3-Flash、Qwen3-Coder。

**思考模式是换模型不是加开关**：选 Qwen3-Max 且模型名含 think/r1 时，插件会改发 `tongyi-qwen3-max-thinking-agent`。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://chat2.qianwen.com/api/v2/chat?biz_id=ai_qwen&…` |
| 鉴权 | `Cookie: tongyi_sso_ticket=<ticket>` |
| 请求体 | 单条 `messages[]`，含 `session_id` / `req_id` / `protocol_version: "v2"` |
| 流 | SSE，事件里 `data.messages[]` 携带**累积**内容 |

**内容是累积的**：每个事件的 `messages[].content` 是到目前为止的全文，插件按长度取增量，否则答案会重复。

**思考在 `meta_data.multi_load` 里**：`type` 为 `deep_think`（或 `multimodal_chat_think`）的 load 携带 `think_content`，同样累积。答案开始后不再发思考。

**内容里会有 `[(deep_think)]` 这类标记**，必须剥掉，否则会被当成正文。

关于 zstd：ChatLink 的适配器保留了 zstd 分支，但它的默认请求头**并不声明 `Accept-Encoding: zstd`**，所以该分支实际不会触发。本插件用标准 fetch，压缩由运行时自动处理。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
