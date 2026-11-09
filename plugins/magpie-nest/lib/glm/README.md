# glm
**智谱清言网页版**（chatglm.cn）作为 magpie / OpenCode 供应商插件。走网页会话，不是 API Key。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login glm
```

粘贴 **refresh_token**：登录 chatglm.cn 后 F12 → Application → Local Storage → `chatglm_refresh_token`。

插件用它换取 1 小时有效的 access_token 并缓存，到期前由 magpie 的 refresh 钩子自动续期。

## 模型

`glm-5.3` / `glm-5.2` / `glm-5`（显示名 GLM-5.3 等）。选择 `glm-5.3` 时会带 `chat_mode: "zero"`（深度思考）。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://chatglm.cn/chatglm/backend-api/assistant/stream` |
| 续期 | `POST /chatglm/user-api/user/refresh`，`Authorization: Bearer <refresh_token>` → `result.access_token` |
| 签名 | `md5(timestamp-nonce-secret)`，走 `X-Sign` / `X-Timestamp` / `X-Nonce` |
| 会话 | 整个对话压成**一条** user 消息，末尾以 `Assistant: ` 收尾 |
| 流 | 累积式 `parts`（按 `logic_id`），不是增量 delta |

**时间戳不是原始时钟**：把毫秒字符串的倒数第二位替换成校验位（各位数字和减去倒数第二位后取模 10）。照抄原值会 403。

**流是累积快照**：每个事件携带各 part 的完整当前内容，所以插件重算全文、只发出增长的部分——直接把 part 内容转发会重复整段答案。

## 许可

MIT。协议事实与客户端常量参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写；常量（签名密钥）以机械方式搬运，未参与人工改写。
