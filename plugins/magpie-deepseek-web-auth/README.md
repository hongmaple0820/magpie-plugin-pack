# magpie-deepseek-web-auth

**DeepSeek 网页版**（chat.deepseek.com）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-deepseek-web-auth"
magpie plugin login deepseek-web
```

粘贴 token（`localStorage.userToken`），或整份凭据 JSON：

```json
{"token":"…","cookie":"…","hifDliq":"…","hifLeim":"…"}
```

## 模型

`deepseek-chat` / `deepseek-reasoner`。**思考模式是模型，不是开关**（`thinking_enabled` 由模型名推导）。

## 协议事实

| 项 | 值 |
| --- | --- |
| 挑战 | `POST /api/v0/chat/create_pow_challenge` → `data.biz_data.challenge` |
| 会话 | `POST /api/v0/chat_session/create` → `data.biz_data.chat_session.id`；用完 `/delete` |
| 对话 | `POST /api/v0/chat/completion`，头带 `x-ds-pow-response` |
| 鉴权 | `Authorization: Bearer <token>` + 可选 `x-hif-dliq` / `x-hif-leim` |

**每次写操作都要 PoW**：挑战里的 `salt` 与 `expire_at` 拼成前缀，用 DeepSeek 自家的 sha3 wasm 求解，答案连同 `signature` 和 `target_path` 一起 base64 成头值。**wasm 已随插件打包**（`assets/sha3_wasm_bg.wasm`，26KB），不依赖运行时下载。

**每轮一个新会话**：对话历史以纯文本转写进 `prompt`，`parent_message_id` 恒为 `null`——服务端按消息树回溯不到历史，会话自身状态不影响上下文。

**响应是补丁流，不是 delta**：

| 帧 | 含义 |
| --- | --- |
| `{"v":{"response":{...}}}` | 完整快照（当作基线，不重复上屏） |
| `{"p":"response/fragments","o":"APPEND","v":{type,content}}` | 追加片段，`type` 为 THINK 时是思考 |
| `{"p":"response/fragments/-1/content","v":"…"}` | 续写最后一个片段 |
| `{"v":"…"}` | **承接上一条 p 建立的通道** |

**裸续段必须跟随通道**：服务端先发 `thinking_content` 建立思考通道，再用裸 `{"v":…}` 发完剩下的思考。把裸续段一律当正文，就会把思考当答案显示给用户。

## 已知限制

- 未做图片输入（`ref_file_ids` 恒为空）。
- 该渠道是逆向网页端，账号有被限流风险，勿用主力号。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写；PoW 求解器用的是 DeepSeek 网页客户端自带的 sha3 wasm（ChatLink 同款资产）。
