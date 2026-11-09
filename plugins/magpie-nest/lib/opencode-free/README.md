# opencode-free
**OpenCode 免密免费通道**（opencode.ai/inference/v1）作为 magpie / OpenCode 供应商插件：**不需要账号，也不需要密钥**。

## 安装

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
```

## 登录

选「启用匿名免费通道（无需登录、无需输入）」，点确定即可。账号会以 `anonymous` 出现。

这一条通道用的是上游公开的匿名池（`Authorization: Bearer public`）——官方 CLI 自己的免密钥值。

## 模型

9 个，全部实测接受匿名凭证：

Big Pickle、Space Bunny、LongCat 2.5 Preview、MiMo V2.6 Flash、MiMo V2.5、DeepSeek V4.1 Flash、GLM 5.3 Flash、Nemotron 3 Ultra、Nemotron 3.5 Lightning。

目录里还有 80+ 个 id，但只有这几个接受 `Bearer public`，其余会回 401（付费）或 403 FreeTierError。**未知名在本地就被拒绝**——上游对未知 id 不报错，而是静默换一个模型回答。

## 三个被指纹校验的东西

网关（v2）校验客户端形状，三样缺一不可：

1. **User-Agent**：`opencode/latest/2.0.26/cli`，整串匹配，不要加后缀。
2. **四个会话头**：`x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id`，**必须同一个值**，且形如 `ses_` + 12 hex + 14 base62，hex 段要读起来像递减时间戳。随机 UUID 会被拒。
3. **两个工具定义**：CLI 自带的 `read` / `shell`，定义逐字对齐。它们是真工具，所以另外用一句 system 提示让模型别调用——写成"禁止使用"的桩会连调用方自己的 read/shell 一起被拒。

## 协议事实

| 项 | 值 |
| --- | --- |
| 对话 | `POST https://opencode.ai/inference/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer public` |
| 端点 | **SSE-only**，恒发 `stream: true`；非流式调用方由插件聚合 |
| `tool_choice` | v2 网关对 `"none"` 直接 403，插件会去掉 |

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的行为，代码为独立重写。
