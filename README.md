# magpie-plugin-pack

一套 **magpie / OpenCode 供应商插件合集**。每个插件都是标准的 OpenCode v1 插件（`config` / `auth` / `provider`），在 magpie 里开箱即用：多账号、故障切换、额度展示、自动更新都由 magpie 负责。

> English: see [README.en.md](./README.en.md)。

## 包含的插件

| 插件 | 供应商 id | 说明 | 登录方式 | 目录 |
| --- | --- | --- | --- | --- |
| magpie-inkstone-auth | `inkstone` | 书生·端砚（Discovery）云端模型：Orbit Agent + TokenPlan API 双通道、墨点用量 | Windows 本机端砚客户端一键导入（无需浏览器、无需任何输入），或网页 SSO | [plugins/magpie-inkstone-auth](./plugins/magpie-inkstone-auth) |

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
