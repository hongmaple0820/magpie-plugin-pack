<p align="center"><img src="logo.svg" width="128" alt="鹊巢 logo"/></p>

<h1 align="center">鹊巢 · magpie-nest</h1>

<p align="center">一个包，16 家网页版 AI 渠道——一次安装，各自登录</p>

<p align="center"><a href="https://github.com/hongmaple0820/magpie-plugin-pack/actions/workflows/test.yml"><img src="https://github.com/hongmaple0820/magpie-plugin-pack/actions/workflows/test.yml/badge.svg" alt="tests"/></a></p>

本仓库（magpie-plugin-pack）发布一个合订包 **`magpie-nest`**：标准的 OpenCode v1 插件包（`config` / `auth` / `provider`），入口导出 16 个插件函数，宿主把每个函数当独立插件运行——**一次安装，16 个渠道各自登录、互不影响**。多账号、故障切换、额度展示、自动更新都由 magpie 负责。

> English: see [README.en.md](./README.en.md)。

## 包含的渠道

全部位于 [plugins/magpie-nest](./plugins/magpie-nest)。渠道代码在 `lib/<id>/`，协议细节与登录字段见各 `lib/<id>/README.md`。

| 供应商 id | 渠道 | 登录方式 |
| --- | --- | --- |
| `inkstone` | 书生·端砚（Discovery）云端模型：Orbit Agent + TokenPlan API 双通道、墨点用量 | Windows 本机端砚客户端一键导入（无需浏览器、无需任何输入），或网页 SSO |
| `lobsterai` | 有道 LobsterAI：18 个模型（DeepSeek V4 / Kimi K2.x / Qwen3.x / MiniMax M3 / Doubao Seed 2.x / GLM-5.x）、SSE-only 端点聚合、每日签到带积分 | 浏览器登录 + 粘贴回跳地址（可选手动粘 token） |
| `zai-web` | Z.ai 网页版：GLM-5.3 / 5.2 / 5.1 / 5，OpenAI 兼容端点直通 | 粘贴网页令牌（eyJ…） |
| `opencode-free` | OpenCode 免密免费通道：9 个匿名池模型，无需账号与密钥 | 一键启用（无输入） |
| `glm` | 智谱清言网页版：GLM-5.3 / 5.2 / 5，签名请求 + 累积式分片流 | 粘贴 `chatglm_refresh_token` |
| `qwen-ai` | Qwen AI 网页版（chat.qwen.ai）：10 个模型，先建会话再发消息的协议 | 粘贴网页令牌 |
| `perplexity` | Perplexity 网页版：11 个模型（auto/sonar/pplx_pro/GPT-5.4/Claude/Gemini/Grok），SSE 差分补丁流 | 粘贴会话 Cookie |
| `kimi-web` | Kimi 网页版：K3 / K2.7-Code / K2.6 / K2.5，gRPC-Web 帧封装 | 粘贴访问令牌 |
| `qwen-web` | 通义千问网页版：9 个 Qwen3 模型，SSE 回合与思考分片 | 粘贴 `tongyi_sso_ticket` |
| `doubao` | 豆包网页版：samantha 补全流与编号事件协议 | 粘贴 `sessionid` |
| `loomy` | 讯飞 Loomy：8 个模型，OpenAI 兼容直通，模型名带计费倍率 | 粘贴会话令牌 |
| `gemini-code-assist` | Gemini Code Assist：v1internal 信封 + antigravity 客户端身份，4 个 tier | 粘贴整份 Google 凭据 JSON |
| `raccoon` | 商汤 Raccoon Work：6 个模型，OpenAI 兼容 + 组织码 | 粘贴网页访问令牌 |
| `agnes` | Agnes AI 文本模型（图像/视频未实现） | 粘贴 API Key |
| `deepseek-web` | DeepSeek 网页版：sha3 PoW（wasm 随包）+ 每轮会话 + 补丁流投影 | 粘贴 token 或凭据 JSON |
| `chatgpt-web` | ChatGPT 网页版（**实验性**）：sentinel 握手 + 本地 PoW/turnstile + 补丁流；可能被 TLS 指纹拦截 | 粘贴 access token 或凭据 JSON |

> ⚠️ 这些渠道全部是**逆向网页协议**，非官方 API：上游改版随时可能失效；账号有限流/封禁风险，勿用主力号。与既有社区插件同 id 时（`inkstone`/`deepseek-web`/`chatgpt-web`），用 `magpie plugin use` 指定归属，本包不抢已登录的账号。

## 安装（一条命令）

```powershell
git clone https://github.com/hongmaple0820/magpie-plugin-pack.git
magpie plugin add "F:\路径\magpie-plugin-pack\plugins\magpie-nest"
```

- 或在 magpie 应用里：插件 → 添加插件 → 填上面的文件夹路径。
- 仓库根的 `install.ps1` / `install.sh` 仍可用（遍历 `plugins/*/`，对每个目录执行 `magpie plugin add`），重复执行安全。

装好后在「插件 → 已安装」里打开需要的渠道、登录即可；不登录的渠道完全不影响其他渠道。

## 登录

以 inkstone 为例：

```powershell
magpie plugin login inkstone     # 选「从本机端砚客户端导入登录态」（Windows，无需浏览器、无需输入）
magpie provider test inkstone    # 每种 API 发一个很小的请求
magpie quota                     # 看墨点余额与 5h/7d 窗口
magpie plugin                    # 看插件 / 账号 / 模型列表
```

其它渠道见 `plugins/magpie-nest/lib/<id>/README.md`。

## 更新

未发布 npm 前，更新 = `git pull` 拉最新代码：

```powershell
cd magpie-plugin-pack
git pull
```

- 终端 CLI：什么都不用做，每条命令按文件夹当前内容加载。
- magpie 应用（GUI）：到「插件 → 已安装」把合订包**关掉再打开**，或重启 magpie。

## 测试

仓库根一条命令跑完全部渠道（跨平台，Windows 也能跑）：

```bash
npm test
# 等价于 node scripts/test-all.mjs —— 遍历 plugins/*/package.json 跑包内 npm test
```

合订包内 `test/pack-install.test.mjs` 是装载回归：入口恰好导出 16 个插件函数、`files` 白名单复制后整包可装载（含 deepseek 的 wasm 资产）。

GitHub Actions（[.github/workflows/test.yml](./.github/workflows/test.yml)）在每次 push / PR 自动在 **ubuntu + windows** 双平台跑全部测试。零运行时依赖，无需 `npm install`。

## 目录结构

```
magpie-plugin-pack/
├── README.md / README.en.md      # 中英说明（本文件）
├── LICENSE                       # MIT
├── install.ps1 / install.sh      # 一键安装
├── scripts/test-all.mjs          # 跑全部测试
├── .github/workflows/test.yml    # CI：push/PR 双平台测试
└── plugins/
    └── magpie-nest/     # 唯一的包：16 渠道合订
        ├── index.mjs             # 只导出 16 个插件函数（宿主各跑各的）
        ├── lib/<id>/             # 各渠道协议实现 + README（inkstone 在 lib/inkstone/）
        ├── assets/               # deepseek-web 的 sha3 wasm
        ├── test/                 # 164 个单测
        └── package.json
```

约定：

- **入口模块只导出插件函数**：宿主会把入口里每个导出函数都当插件执行，多导出一个辅助函数就会在加载时崩溃。辅助代码一律放 `lib/<id>/`。
- 渠道之间零共享状态，新增渠道 = `lib/` 下新目录 + 入口加一行 export + 一份测试。
- 旧的单插件形态已并入本包（git 历史里仍可查）。

## 发布（后续推 npm）

单包发布：

```bash
cd plugins/magpie-nest
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm pack --dry-run
npm publish --tag beta
```

发布后用户直接：

```
magpie plugin add magpie-nest
```

想进 magpie 社区推荐列表，给 `magpie-community/plugins` 的 `registry.json` 提 PR（详见 magpie 文档「发布与上架」）。

## License
