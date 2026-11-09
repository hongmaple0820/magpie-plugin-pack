# magpie-raccoon-auth

**商汤 Raccoon Work**（xiaohuanxiong.com）作为 magpie / OpenCode 供应商插件。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-raccoon-auth"
magpie plugin login raccoon
```

粘贴网页访问令牌（`RACCOON_ACCESS_TOKEN`）。

> 微信扫码 + 阿里云滑块登录无法在插件里自动化——请先在自己的客户端登录，再复制令牌。

## 模型

6 个：SenseNova 6.8 Flash（免费）、SenseNova 6.8 Flash Lite（免费）、GLM-5.3、Kimi K3、GLM-5.3 Flash、DeepSeek V4.1 Flash。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions` |
| 鉴权 | `Authorization: Bearer <token>` |
| 客户端头 | `X-Raccoon-Language: zh`、`X-Client-Platform: desktop-windows`、`User-Agent: Raccoon Work/1.0.35 (Windows)` |
| 组织码 | `X-Org-Code`，**为空时整条头不发** |
| 形状 | 标准 OpenAI，直通 |

**一个已实测的怪癖**（成对实验，temperature=0）：服务端**接受** `reasoning_effort` 的 8 个枚举值，但它**没有任何可观察效果**。思考只由 `extra_body.thinking.type`（`enabled`/`disabled`）控制。

本插件**两者都不发**，于是走上游默认（思考开启）——这是有意的：静默关掉思考会在不告知用户的情况下改变回答质量。

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
