# agnes
**Agnes AI**（api.agnes-ai.cn）的**文本模型**，作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login agnes
```

粘贴平台签发的 API Key。

## 模型

agnes-2.5-flash、agnes-2.5-pro、agnes-2.5-pro-alpha、agnes-2.5-pro-beta、agnes-3.0-flash。

## 未实现：图像与视频生成

Agnes 另外提供 `agnes-image-*` 与 `agnes-video-*`，但它们的端点是：

- 图像：同步返回图片 URL
- 视频：异步任务 + 轮询（最长 900 秒）

**这不是 chat completions**，属于 magpie 的另一套表面（图像/视频 drawer），不能挂在对话路径上。因此插件**故意不列出**这些模型——列出来只会让用户点了就报错。

## 协议事实

| 项 | 值 |
| --- | --- |
| 基址 | `https://api.agnes-ai.cn/v1` |
| 对话 | `POST /v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <api key>` |
| 形状 | 标准 OpenAI，直通 |

**基址必须带 `/v1`**：去掉前缀会直达裸主机，Cloudflare 直接回 403 HTML 挑战页。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
