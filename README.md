# magpie-plugin-pack

一套 **magpie / OpenCode 供应商插件合集**。每个插件都是标准的 OpenCode v1 插件（`config` / `auth` / `provider`），在 magpie 里开箱即用：多账号、故障切换、额度展示、自动更新都由 magpie 负责。

> English: see [README.en.md](./README.en.md)。

## 包含的插件

| 插件 | 供应商 id | 说明 | 登录方式 | 目录 |
| --- | --- | --- | --- | --- |
| magpie-inkstone-auth | `inkstone` | 书生·端砚（Discovery）云端模型：Orbit Agent + TokenPlan API 双通道、墨点用量 | Windows 本机端砚客户端一键导入（无需浏览器、无需任何输入），或网页 SSO | [plugins/magpie-inkstone-auth](./plugins/magpie-inkstone-auth) |
| magpie-lobsterai-auth | `lobsterai` | 有道 LobsterAI：18 个模型（DeepSeek V4 / Kimi K2.x / Qwen3.x / MiniMax M3 / Doubao Seed 2.x / GLM-5.x）、SSE-only 端点聚合、每日签到带积分 | 浏览器登录 + 粘贴回跳地址（可选手动粘 token） | [plugins/magpie-lobsterai-auth](./plugins/magpie-lobsterai-auth) |
| magpie-zai-auth | `zai-web` | Z.ai 网页版：GLM-5.3 / 5.2 / 5.1 / 5，OpenAI 兼容端点直通 | 粘贴网页令牌（eyJ…） | [plugins/magpie-zai-auth](./plugins/magpie-zai-auth) |
| magpie-opencode-free-auth | `opencode-free` | OpenCode 免密免费通道：9 个匿名池模型，无需账号与密钥 | 一键启用（无输入） | [plugins/magpie-opencode-free-auth](./plugins/magpie-opencode-free-auth) |
| magpie-glm-auth | `glm` | 智谱清言网页版：GLM-5.3 / 5.2 / 5，签名请求 + 累积式分片流 | 粘贴 `chatglm_refresh_token` | [plugins/magpie-glm-auth](./plugins/magpie-glm-auth) |
| magpie-qwen-ai-auth | `qwen-ai` | Qwen AI 网页版（chat.qwen.ai）：10 个模型，先建会话再发消息的协议 | 粘贴网页令牌 | [plugins/magpie-qwen-ai-auth](./plugins/magpie-qwen-ai-auth) |
| magpie-perplexity-auth | `perplexity` | Perplexity 网页版：11 个模型（auto/sonar/pplx_pro/GPT-5.4/Claude/Gemini/Grok），SSE 差分补丁流 | 粘贴会话 Cookie | [plugins/magpie-perplexity-auth](./plugins/magpie-perplexity-auth) |
| magpie-kimi-auth | `kimi-web` | Kimi 网页版：K3 / K2.7-Code / K2.6 / K2.5，gRPC-Web 帧封装 | 粘贴访问令牌 | [plugins/magpie-kimi-auth](./plugins/magpie-kimi-auth) |
| magpie-qwen-auth | `qwen-web` | 通义千问网页版：9 个 Qwen3 模型，SSE 回合与思考分片 | 粘贴 `tongyi_sso_ticket` | [plugins/magpie-qwen-auth](./plugins/magpie-qwen-auth) |
| magpie-doubao-auth | `doubao` | 豆包网页版：samantha 补全流与编号事件协议 | 粘贴 `sessionid` | [plugins/magpie-doubao-auth](./plugins/magpie-doubao-auth) |
| magpie-loomy-auth | `loomy` | 讯飞 Loomy：8 个模型，OpenAI 兼容直通，模型名带计费倍率 | 粘贴会话令牌 | [plugins/magpie-loomy-auth](./plugins/magpie-loomy-auth) |
| magpie-gemini-auth | `gemini-code-assist` | Gemini Code Assist：v1internal 信封 + antigravity 客户端身份，4 个 tier | 粘贴整份 Google 凭据 JSON | [plugins/magpie-gemini-auth](./plugins/magpie-gemini-auth) |
| magpie-raccoon-auth | `raccoon` | 商汤 Raccoon Work：6 个模型，OpenAI 兼容 + 组织码 | 粘贴网页访问令牌 | [plugins/magpie-raccoon-auth](./plugins/magpie-raccoon-auth) |
| magpie-agnes-auth | `agnes` | Agnes AI 文本模型（图像/视频未实现） | 粘贴 API Key | [plugins/magpie-agnes-auth](./plugins/magpie-agnes-auth) |
| magpie-deepseek-web-auth | `deepseek-web` | DeepSeek 网页版：sha3 PoW（wasm 随包）+ 每轮会话 + 补丁流投影 | 粘贴 token 或凭据 JSON | [plugins/magpie-deepseek-web-auth](./plugins/magpie-deepseek-web-auth) |
| magpie-chatgpt-web-auth | `chatgpt-web` | ChatGPT 网页版（**实验性**）：sentinel 握手 + 本地 PoW/turnstile + 补丁流；可能被 TLS 指纹拦截 | 粘贴 access token 或凭据 JSON | [plugins/magpie-chatgpt-web-auth](./plugins/magpie-chatgpt-web-auth) |

> 后续新插件都放进 `plugins/<name>/`，并补一行到上表。

## 一键安装全部插件

### Windows（PowerShell 5.1+）

```powershell
# 克隆仓库
git clone https://github.com/hongmaple0820/magpie-plugin-pack.git
cd magpie-plugin-pack

# 一键添加 plugins/ 下所有插件到 magpie（文件夹就地加载，改代码即生效）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

如果 magpie 不在 PATH：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Magpie "D:\Program Files\magpie-windows-amd64.exe"
```

### macOS / Linux

```bash
git clone https://github.com/hongmaple0820/magpie-plugin-pack.git
cd magpie-plugin-pack
./install.sh                     # 或 sh install.sh
# 自定义 magpie 路径： MAGPIE=/path/to/magpie ./install.sh
```

脚本只是遍历 `plugins/*/package.json`，对每个目录执行 `magpie plugin add <绝对路径>`，重复执行是安全的（magpie 会拒绝已添加的项）。

## 安装单个插件（手动）

magpie 支持「文件夹就地加载，不安装任何东西」，这是没发布 npm 之前最方便的方式：

```powershell
# 终端里（每个 magpie 命令都按文件夹当前内容加载）
magpie plugin add "F:\路径\magpie-plugin-pack\plugins\magpie-inkstone-auth"

# 或在 magpie 应用里：插件 → 添加插件 → 填上面的文件夹路径
```

装好后在「插件 → 已安装」里打开插件、登录即可。

## 登录

以 inkstone 为例：

```powershell
magpie plugin login inkstone     # 选「从本机端砚客户端导入登录态」（Windows，无需浏览器、无需输入）
magpie provider test inkstone    # 每种 API 发一个很小的请求
magpie quota                     # 看墨点余额与 5h/7d 窗口
magpie plugin                    # 看插件 / 账号 / 模型列表
```

其它插件见各自目录下的 README。

## 更新

未发布 npm 前，更新 = `git pull` 拉最新代码：

```powershell
cd magpie-plugin-pack
git pull
```

- 终端 CLI：什么都不用做，每条命令按文件夹当前内容加载。
- magpie 应用（GUI）：到「插件 → 已安装」把对应插件**关掉再打开**，或重启 magpie。

## 测试

仓库根一条命令跑完所有插件（跨平台，Windows 也能跑）：

```bash
npm test
# 等价于 node scripts/test-all.mjs —— 遍历 plugins/*/package.json 逐个跑各自的 npm test
```

GitHub Actions（[.github/workflows/test.yml](./.github/workflows/test.yml)）在每次 push / PR 自动在 **ubuntu + windows** 双平台跑全部插件测试。插件零运行时依赖，无需 `npm install`。

## 目录结构

```
magpie-plugin-pack/
├── README.md / README.en.md      # 中英说明（本文件）
├── LICENSE                       # MIT
├── install.ps1 / install.sh      # 一键安装全部插件
├── scripts/test-all.mjs          # 跨平台跑全部插件测试
├── .github/workflows/test.yml    # CI：push/PR 双平台测试
└── plugins/
    └── magpie-inkstone-auth/     # 每个插件一个目录，含自己的 package.json + README
        ├── index.mjs
        ├── lib/
        ├── test/
        ├── package.json
        └── README.md
```

约定：

- 一个插件 = `plugins/` 下的一个目录，目录名 = npm 包名。
- 插件入口按 magpie 规则解析（`exports["./server"]` → `main` → `exports["."]` → `index.ts/.tsx/.js/.mjs/.cjs`）。
- 入口模块只导出插件函数，辅助函数放到 `lib/` 或用 `export default { id, server }`。

## 发布（后续推 npm）

仓库是 monorepo，**每个 `plugins/<name>/` 独立发布**：

```bash
cd plugins/magpie-inkstone-auth
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm pack --dry-run
npm publish --tag beta
```

发布后用户直接：

```
magpie plugin add magpie-inkstone-auth
```

想进 magpie 社区推荐列表，给 `magpie-community/plugins` 的 `registry.json` 提 PR（详见 magpie 文档「发布与上架」）。

## License

[MIT](./LICENSE)
