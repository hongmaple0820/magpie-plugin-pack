# kimi
**Kimi 网页版**（www.kimi.com）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login kimi-web
```

粘贴访问令牌（`eyJ` 开头的 JWT）：登录 kimi.com 后从浏览器开发者工具获取。

> 令牌过期后需要重新粘贴——网页版的续期依赖 cookie 侧的额外状态，插件暂不代为续期。

## 模型

`kimi-k3` / `kimi-k2.7-code` / `kimi-k2.6` / `kimi-k2.5`。

模型名含 think 或 r1 时自动开启思考；含 search 时自动带联网搜索工具。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat` |
| 帧格式 | **gRPC-Web**：1 字节标志 + 4 字节大端长度 + JSON |
| Content-Type | `application/connect+json` |
| 鉴权 | `Authorization: Bearer <JWT>` |
| 场景标记 | `SCENARIO_K2D5` |

**请求体不是 JSON，是帧**。直接 POST JSON 会被拒；必须先包一层帧。

**响应也是帧流**，且会跨网络分片切在任意偏移上——插件用一个带余量的解码器累积，不能假设一次 read 就是一帧。

**block.text.content 是增量**，block.text.flags 为 thinking 时是思考、answer 时是正文。心跳帧（heartbeat）直接丢弃。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
