# magpie-qwen-ai-auth

**Qwen AI 网页版**（chat.qwen.ai，国际版）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-qwen-ai-auth"
magpie plugin login qwen-ai
```

粘贴令牌：登录 chat.qwen.ai 后 F12 → Application → Local Storage → `token`。

## 模型

qwen3.8-max、qwen3.7-max、qwen3.7-plus、qwen3.6-plus、qwen3.5-plus、qwen3.5-flash、qwen3-max-2026-01-23、qwen3-coder-plus、qwen3-vl-plus、qwen-max-latest。

## 协议事实

| 项 | 值 |
| --- | --- |
| 建会话 | `POST /api/v2/chats/new` → `data.id` |
| 对话 | `POST /api/v2/chat/completions?chat_id=<id>` |
| 鉴权 | `Authorization: Bearer <token>` |
| 流 | OpenAI 形状，但 delta 带 `phase` |

**一次请求两次调用**：网页版是有状态的，必须先建会话再往里发消息。

**delta 有阶段**：`phase` 为 `think` / `thinking_summary` / `answer`（或 `null`）。插件只把 `answer` 当正文，其余归到 `reasoning_content`；`status: "finished"` 结束本轮。

**反爬头**：`bx-v` / `bx-umidtoken` / `bx-ua` 是网页客户端指纹常量，随请求发出。

## 许可

MIT。协议事实与客户端常量参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写；常量以机械方式搬运，未参与人工改写。
