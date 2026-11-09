# loomy
**Loomy**（讯飞）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login loomy
```

粘贴会话令牌（已登录 Loomy 客户端里的 session token）。

> 短信验证码登录流程无法在插件里表达——请先在自己的客户端登录，再复制令牌。

## 模型

8 个，**模型名里的 `· xN` 是计费倍率**，不是装饰：同一请求在不同模型上可能差 30 倍花费。

DeepSeek V4 Flash · x3.0、MiniMax M3 · x4.0、Kimi k2.6 · x6.5、Qwen 3.8 Max · x12.0、GLM 5.3 Flash · x0.8、Qwen 3.8 Flash · x0.8、Spark X2.5 · x0.1、MiMo V2.5 · x3.3。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://loomyad.xunfei.cn/api/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <session>` |
| 形状 | 标准 OpenAI，标准 SSE，两个方向直通 |

**鉴权头不对称**：对话端点只认 `Authorization: Bearer`，业务端点（`/models`、`/points/*`）只认 `token:` 头。本插件只访问对话端点。

## 未实现

每日签到（ChatLink 有该渠道的签到适配器）尚未移植。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
