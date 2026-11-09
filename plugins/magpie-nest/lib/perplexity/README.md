# perplexity
**Perplexity 网页版**（www.perplexity.ai）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login perplexity
```

粘贴会话令牌：登录 perplexity.ai 后 F12 → Application → Cookies → `__Secure-next-auth.session-token` 的值。

> 该站点在中国大陆通常需要国际网络。

## 模型

auto、turbo、sonar、pplx_pro、gpt-5.4、gemini-3.0-pro、gemini-3.0-flash、claude-4.6-sonnet、claude-4.6-opus、grok-4.1、nemotron。

## 协议事实

| 项 | 值 |
| --- | --- |
| 提问 | `POST https://www.perplexity.ai/rest/sse/perplexity_ask` |
| 鉴权 | `Cookie: __Secure-next-auth.session-token=<token>` |
| 请求体 | `{ params: {...}, query_str: "问题" }` |
| 流 | `blocks[].diff_block.patches[].value` |

**一次对话回答一个问题**：网页版没有多轮消息数组，只有 `dsl_query`。插件把历史对话压成上下文，最后一条用户消息作为 `query_str`。

**答案是差分补丁**：`patches[].value` 可能是 `{chunks: [...]}`（累积数组，join 后是全文）或 `{answer: "..."}`，两种都是**累积**的。插件重算全文、只发出增长部分，否则答案会整段重复。`/goals` 路径是思考过程，归到 `reasoning_content`。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
