# magpie-zai-auth

**Z.ai**（chat.z.ai）作为 magpie / OpenCode 供应商插件。端点本身是 OpenAI Chat Completions，所以插件很薄：换令牌、带上网关要的浏览器上下文、两个方向原样透传。

## 安装

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-zai-auth"
```

## 登录

只有一种方式：**粘贴 Z.ai 令牌**（登录 chat.z.ai 后，F12 → Application → Cookies 里以 `eyJ` 开头的那个值）。

> 网页版登录无法自动化：Z.ai 的登录页没有可用的授权码回跳，且游客令牌会被上游签发成 `guest-xxx@guest.com`。若粘贴的是游客令牌，请求会 401 —— 请在浏览器里真正完成登录再复制。

## 模型

`glm-5.3` / `glm-5.2` / `glm-5.1` / `glm-5`（显示名 GLM-5.3 等）。

上游对**未知模型名不报错**，而是静默换一个模型回答；插件因此在本地拒绝未知名，避免"看起来能用其实换了模型"。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://chat.z.ai/api/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <JWT>` |
| 形状 | 标准 OpenAI（SSE 与非流式都是），两个方向直通 |

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的行为，代码为独立重写。
