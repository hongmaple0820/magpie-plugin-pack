# chatgpt-web
**ChatGPT 网页版**（chatgpt.com）作为 magpie / OpenCode 供应商插件。

> ## ⚠️ 实验性，且有一个已知的致命风险
>
> 这是逆向网页端复用订阅额度，**账号有被限流/封禁的真实风险，勿用主力号**。
>
> 更关键的是：上游可能按 **TLS 指纹**拒绝非浏览器客户端。ChatLink 自己把这条标为第一风险点（「需要换 Electron net / impersonate 传输层」）。magpie 的插件宿主是 Bun，**同样没有浏览器指纹能力**。
>
> 也就是说：**协议写得对，不代表请求能通。** 本插件在离线层面（PoW、turnstile、补丁流、载荷字段）都是按协议实现并有单测的，但真实连通性未经验证——如果上游按指纹拦截，失败属预期内。

## 安装与登录

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
magpie plugin login chatgpt-web
```

登录 chatgpt.com 后在 Console 执行：

```js
(await (await fetch("/api/auth/session")).json()).accessToken
```

也可以粘整份凭据 JSON（`accessToken` / `cookie` / `deviceId` / `userAgent` / `clientVersion`）。

> chatgpt.com 在中国大陆不可直连，需自备国际网络。

## 模型

`auto`、`gpt-5`、`gpt-5-5`、`gpt-5-5-thinking`。

## 协议事实

### 一、sentinel 握手（四步）

| 步 | 动作 |
| --- | --- |
| 1 | `GET /` → 页面里扒 `script src` 与 `data-build` |
| 2 | `POST /backend-api/sentinel/chat-requirements/prepare {p}` |
| 3 | 本地求解 proofofwork / turnstile |
| 4 | `POST …/finalize` → `token`（+ `so_token`） |

匿名通道走 `/backend-anon/*`，算法相同路径不同。

### 二、工作量证明是纯本地哈希

把 25 元素的「假浏览器指纹」按 `[0,1,2]` `[4..8]` `[10..]` 切三段，中间两个槽位放 `i` 与 `i>>1`，base64 后与 `seed` 拼接做 **sha3-512**，取前 `len(difficulty)` 字节与 difficulty 做**字节序比较**。

**不是前导零比较**——按挖矿直觉写会永远解不出来。这一点有专门的测试。

配置里的时间戳是上游固定写死的 **-05:00**（不跟夏令时），浮点序列化要按 Python 的 `repr` 规则补齐指数位（`1e-07` 而非 `1e-7`），否则哈希对不上。

### 三、turnstile 是本地解释执行

`dx` base64 解码后用 `p` 逐字符异或，得到一段程序，用一个 20 来个 opcode 的栈式虚拟机跑完，op 3 把结果 base64 作为 token。**不是打码平台**。

### 四、响应是补丁流

| 帧 | 含义 |
| --- | --- |
| `"v1"` | 协议标记，忽略 |
| `{"p":"/message/content/parts/0","o":"append","v":"…"}` | 追加正文 |
| `{"p":"","o":"patch","v":[…]}` | 批量补丁，按序应用 |
| `{"v":"…"}` | 裸续段 |
| `{"v":{…}}` | 消息快照 |

上游还会塞 `\ue200…\ue201` 包裹的内部注解，插件会改写成 `label (url)`——直接透给客户端是乱码。

## 未实现

- 图片输入（含图消息会被省略）
- 原生 function calling（网页端没有）

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）的适配器行为，代码为独立重写。
