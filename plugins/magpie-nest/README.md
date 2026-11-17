# 鹊巢 · magpie-nest

<p align="center"><img src="icon.svg" width="128" alt="鹊巢 logo"/></p>

**27 家网页版 AI 渠道**合订为一个 magpie / OpenCode 插件包：一次安装，27 个 provider 各自独立——宿主把入口导出的每个插件函数当独立插件运行（qoder 同款模式），每个渠道有自己的登录、自己的并发限制、自己的故障隔离。喜鹊爱收集亮闪闪的东西回巢，这个包就是 magpie 的巢。

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
```

然后按渠道登录：`magpie plugin login <id>`。

## 渠道一览

| provider id | 服务 | 模型 | 登录方式 | 实验性 |
| --- | --- | --- | --- | --- |
| `inkstone` | 书生·端砚 | 16 | Windows 本机客户端一键导入，或网页 SSO | |
| `lobsterai` | LobsterAI | 18 | 浏览器登录 + 粘贴回跳地址 | |
| `zai-web` | Z.ai | 4 | 粘贴网页令牌（eyJ…） | |
| `opencode-free` | OpenCode Free | 9 | 一键启用（无输入） | |
| `glm` | 智谱清言 | 3 | 粘贴 `chatglm_refresh_token` | |
| `qwen-ai` | Qwen AI | 10 | 粘贴网页令牌 | |
| `qwen-web` | 通义千问 | 9 | 粘贴 `tongyi_sso_ticket` | |
| `kimi-web` | Kimi | 4 | 粘贴访问令牌 | |
| `doubao` | 豆包 | 1 | 粘贴 `sessionid` | |
| `loomy` | Loomy | 8 | 粘贴会话令牌 | |
| `gemini-code-assist` | Gemini Code Assist | 4 | 粘贴整份 Google 凭据 JSON | |
| `perplexity` | Perplexity | 10 | 粘贴会话 Cookie | |
| `raccoon` | Raccoon Work | 6 | 粘贴网页访问令牌 | |
| `agnes` | Agnes AI | 5 | 粘贴 API Key | |
| `deepseek-web` | DeepSeek 网页版 | 2 | 粘贴 token 或凭据 JSON | |
| `chatgpt-web` | ChatGPT 网页版 | 4 | 粘贴 access token 或凭据 JSON | ⚠️ 可能被 TLS 指纹拦截 |

各渠道的协议细节与登录字段说明见 `lib/<渠道>/README.md`。

## 共同事实

- **全部是逆向网页协议**，非官方 API：上游改版随时可能失效；账号有限流/封禁风险，勿用主力号。
- **一次安装 = 27 个插件**。不想要的渠道不登录即可，不影响其他渠道。
- 与既有社区插件同 id 时（`inkstone`/`deepseek-web`/`chatgpt-web`），用 `magpie plugin use` 指定归属，本包不抢已登录的账号。

## 模型行的思考档位（variants）——改之前先看这里

插件 `config()` 里每个模型行的 `variants` **只取键**：`variants: Object.keys(m.variants ?? {})`
（magpie `internal/plugin/host.js:2357`），值整块丢弃，键直接当模型的档位名发给 DSH：

- 键必须落在梯队词里：`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`
  （另有别名 `light`→`low`、`extra_high`→`xhigh`）。别的键永远匹配不上
  （`internal/agent/agents.go:969` `modelEffort`），DSH 里就看不到这一档。
- 命中 0 档，或**只命中 `none` 一档**时，`dshModelLevels` 直接返回 nil
  （`internal/agent/dsh.go:1935`）：模型在 DSH 里一个档位都没有。
- 所以 `variants` 必须是 `{ [档位词]: { reasoningEffort: 档位词 } }` 这种**对象**，
  不能是字符串数组（`Object.keys(["low","high"])` 得到 `["0","1"]`）；显示名当键也不行
  （`Extra`/`None` 都会被丢）。
- 我们模型行里的 `efforts` / `defaultEffort` / `alwaysThinks` 是**本包自己的**元数据
  （思考翻译、测试用），magpie 从不读；上游私有档位词（`on`、`default`）必须在这里
  翻译成梯队词，否则 UI 上无法选择。
- 回归防线：`test/channel-variants.test.mjs` 会遍历全部 27 个渠道，断言每条 `variants`
  都是梯队词对象。

## 已知限制

- `chatgpt-web`：协议层完整（sentinel 握手 + 本地 PoW/turnstile + 补丁流），但宿主无浏览器 TLS 指纹，上游拦截则无法工作。
- `agnes`：仅文本，图像/视频未实现。
- `loomy`：签到未移植。
- 各渠道图片输入均未实现。

## 测试

```bash
npm test          # 164 个单测，含合订包装载回归 pack-install.test.mjs
```

## 许可

MIT。协议事实参考 ChatLink（GPL-3.0）与社区插件的适配行为，代码为独立重写；`deepseek-web` 的 PoW 求解用 DeepSeek 网页客户端自带的 sha3 wasm（`assets/sha3_wasm_bg.wasm`）。
