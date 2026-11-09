# doubao
**豆包**（www.doubao.com）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login doubao
```

粘贴 `sessionid`：登录 www.doubao.com 后 F12 → Application → Cookies。

## 模型

只有一个：`doubao`。网页端选的不是模型 id，而是助手。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://www.doubao.com/samantha/chat/completion?aid=497858&…` |
| 鉴权 | `Cookie: "sessionid=" + sessionId + "; sessionid_ss=" + sessionId,` |
| 编号事件 | `2001` 带内容，`2003` 结束本轮 |
| 载荷 | 事件里 `event_data` 是**字符串套 JSON**，再里面 `message.content` 还是 JSON |

**三层嵌套**：外层事件 JSON 的 `event_data` 是字符串，解析后 `message.content` 又是 JSON，文本可能落在 `text` / `delta.text` / `content` 或直接是字符串。插件按这几种形状依次读取，读不到就跳过。

**内容是真增量**：每个 2001 事件只带新增片段，直接拼接即可。

**多轮对话是模板文本**：网页端收的是一条消息，多轮要用 `role\n内容\n<|im_end|>\n` 拼起来。

**刻意不发 `Accept-Encoding: zstd`**：官方客户端会声明 zstd，但运行时装不了解码器就会拿到读不了的字节。这个头交给 HTTP 层，它只会申请自己能解的编码。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
