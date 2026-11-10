# ChatLink → magpie 插件包：整体移植方案

| 项 | 值 |
| --- | --- |
| 版本 | v1.0（待评审） |
| 日期 | 2026-11-09 |
| 目标仓库 | magpie-plugin-pack（MIT，monorepo，每插件独立发布） |
| 来源项目 | ChatLink v1.2.0（Electron，GPL-3.0）@ F:/maple/ChatLink |
| 宿主约束来源 | magpie @ F:/maple/magpie（docs/subsystems/provider-plugins.md、plugin-runtime.md、AGENTS.md movers） |
| 参考样板 | plugins/magpie-inkstone-auth（生产可用插件） |

---

## 1. 结论摘要

**做，但只做「渠道协议层」。**

ChatLink 是「Electron 外壳 + Koa 网关 + 26 个渠道适配器」的三层结构。magpie 已经把外壳和网关这两层做得更完整（多账号、故障切换、路由策略、配额卡片、签到调度、UI），所以移植的**唯一增量价值是那 26 个渠道的协议知识**：登录怎么走、请求怎么改、签到怎么判、用量怎么读。

由此推出三条硬结论：

1. **形态是「渠道插件包」，不是「一个 ChatLink 插件」。** 一个渠道一个 npm 包，独立版本、独立发布、坏一家不连坐。这是 magpie 生态的既定形态（movers 表里 11 个订阅各自独立成包），也是唯一能长期维护的形态。
2. **只有约 15 个渠道值得做。** ChatLink 的 26 个渠道中，8 个社区已有官方插件（重复），3 个是纯 API-key 型 OpenAI 兼容（magpie 用户填个自定义 provider 就行，插件无意义），真正的空白区是网页登录/私有协议型渠道。
3. **许可证必须走「按协议事实重写」。** ChatLink 是 GPL-3.0，本包是 MIT。协议端点、业务码、请求形状属于事实，不受版权保护；实现代码必须重写，不能复制源码文本。

---

## 2. 为什么架构上成立：能力映射

ChatLink 的每个子系统在 magpie 插件 API 里都有直接对应物，这不是巧合——两者解决的是同一个问题（把非标准 AI 渠道伪装成 OpenAI）。

| ChatLink | magpie 插件 API | 迁移结论 |
| --- | --- | --- |
| `providers/builtin/*.ts`（供应商定义） | `config` hook | 直接改写：字段大部分可平移 |
| `oauth/adapters/*`（20 家登录） | `auth.methods` | **需重构**（见 5.1） |
| token 续期（各适配器 refreshToken） | `auth.refresh` | 直接平移 |
| `proxy/adapters/*`（20 家协议） | `loader.fetch` | 直接平移（核心工作量） |
| `providers/checkin/*`（6 家签到） | `auth.checkin` | 直接平移 |
| `providers/checker.ts` + 配额 | `auth.usage` | 部分平移 |
| `supportedModels` / `modelMappings` | `provider.models` | 直接平移 |
| Koa 网关 / 路由 / Anthropic 转换 | 宿主自带 | **丢弃** |
| LoadBalancer / 熔断 / comboRunner | 宿主自带（groups + 9 种策略） | **丢弃** |
| React UI / 托盘 / 自动更新 / 统计 | 宿主自带 | **丢弃** |
| riskGuard（节流/退避） | 宿主账号退避机制 | **丢弃** |
| InAppLogin（Electron 抓 cookie） | 无对应 | **必须重构**（见 5.1） |

宿主关键约束（来自 plugin-runtime.md）：

- 插件函数与其 `config` hook 各 20s 加载超时 → **模块顶层禁止网络请求**。
- `models` hook 20s 超时，超时即回退到旧清单。
- 插件宿主是 Bun，插件以用户权限运行；Node 标准 API 大体可用。
- hook 值会被宿主校验并按白名单裁剪，异常值静默丢弃。

---

## 3. 插件包形态与命名

### 3.1 目录与命名

    magpie-plugin-pack/
      plugins/
        magpie-<provider>-auth/     # 目录名 = npm 包名
          index.mjs                 # 唯一入口：导出插件函数
          package.json              # 含 magpie 元数据块
          lib/                      # 协议实现，按职责分文件
          test/                     # node:test 单测
          README.md                 # 中文主文档
          README.en.md              # 英文
          icon.svg
          LICENSE                   # MIT（与 pack 一致）

命名沿用社区惯例：`magpie-<id>-auth` 或 `opencode-<id>-auth`。本包用 `magpie-` 前缀，与现有 inkstone 插件一致。

provider id 必须与 ChatLink 的 id 对齐（`lobsterai`、`deepseek-web`、`chatgpt-web`、`opencode-free` …），已在社区插件占用的 id 一律不复用（避免宿主"两个插件抢一个 id"的冲突态）。

### 3.2 package.json 必备字段

    {
      "name": "magpie-<id>-auth",
      "version": "0.1.0",
      "type": "module",
      "main": "./index.mjs",
      "files": ["index.mjs", "lib", "test", "README.md", "README.en.md", "icon.svg"],
      "keywords": ["opencode", "opencode-plugin", "magpie-plugin", "<id>"],
      "license": "MIT",
      "magpie": {
        "name": "<中文显示名>",
        "maxConcurrency": 4,
        "summary": { "en": "...", "zh": "..." },
        "icon": "data:image/svg+xml;base64,..."
      },
      "scripts": { "test": "node test/*.test.mjs" }
    }

**零运行时依赖**是硬约束（inkstone 先例）：协议工具自包含在 `lib/` 里，不引第三方包。理由：插件在宿主 Bun 里加载，依赖树越浅越快越稳，且 `magpie plugin add <文件夹>` 就地加载时无需 `npm install`。

---

## 4. 标准插件骨架

以下是所有渠道插件共用的骨架，M0 交付后即固化为模板。

    // index.mjs
    import { PROVIDER, PROVIDER_NAME, API_BASE } from "./lib/constants.mjs";
    import { normalizeAuth } from "./lib/auth.mjs";
    import { methods } from "./lib/login.mjs";        // auth.methods
    import { readUsage } from "./lib/usage.mjs";      // 可选
    import { checkin } from "./lib/checkin.mjs";      // 可选
    import { fetchUpstream } from "./lib/bridge.mjs"; // loader.fetch 主体

    export const Plugin = async (_input, _options) => ({
      // ① 供应商声明：未登录也先声明，模型选择器里有一份静态清单
      config: async (cfg) => {
        cfg.provider ??= {};
        cfg.provider[PROVIDER] ??= {
          name: PROVIDER_NAME,
          npm: "@ai-sdk/openai-compatible",
          api: API_BASE,
          models: STATIC_MODELS,
        };
      },

      // ② 登录 / 续期 / 用量 / 签到
      auth: {
        provider: PROVIDER,
        methods,
        refreshLead: REFRESH_LEAD_MS,
        async refresh(auth) { /* 返回要合并进账号的字段 */ },
        async loader(getAuth) {
          const first = normalizeAuth(await getAuth());
          if (!first.token) return {};
          return {
            async fetch(input, init) {
              const cred = normalizeAuth(await getAuth());
              return fetchUpstream(cred, input, init);
            },
          };
        },
        async usage(getAuth) { /* { windows: [...] } */ },
        async checkin(getAuth) { /* { outcome, credit?, message? } */ },
      },

      // ③ 动态模型列表（可省略，省略即用 config 里的静态清单）
      provider: {
        id: PROVIDER,
        async models(provider, { auth } = {}) { /* 失败时 return provider.models */ },
      },
    });

    export default Plugin;

**关键约定（照 inkstone 的实战经验）：**

1. `loader` 里拿一次 auth 做健康判定，`fetch` 内部**每次重新 getAuth**——magpie 会在请求间更新账号（续期回写），用闭包里的旧凭据会导致续期不生效。
2. `fetch` 返回标准 `Response`。**401 原样返回**（宿主据此标记账号需要重登并故障切换），**429/5xx 原样返回**（宿主退避 + 切换），只有厂商把"额度耗尽"包成 4xx/402 时才转成 429。
3. `models` hook 任何异常都要 `return provider.models`，不能抛——抛了宿主会记为 listError 并保留旧清单，虽然行为可接受，但显式返回更可控。
4. 账号用户名必须来自真实数据（JWT 的 sub/email），拿不到就不填 `accountId`，**绝不编造**（ChatLink 的既有铁律，也是 inkstone 的做法）。

---

## 5. 五项关键设计决策

### 5.1 登录 UX：三档映射（最大重构点）

ChatLink 的 InAppLogin 用 Electron BrowserWindow 拦截 cookie/localStorage，magpie 插件宿主没有这个能力。按三个档位降级：

**档 A —— 标准 OAuth（授权码）**
适用：lobsterai、glm、kimi、qwen、qwen-ai、zai、gemini。
做法照 inkstone 的 `method: "code"`：`authorize` 返回 `{ url, instructions, method: "code", callback }`，magpie 打开 URL，用户在浏览器完成登录，把回跳后的整条地址栏粘回输入框，`callback` 解析 code 再换 token。
关键文案（照 ChatLink 的 helpText 打磨）："若页面把 code 清掉了，按浏览器后退一次找回带 code 的地址"。这一步的文案质量直接决定登录成功率。

> **需在 M0 验证的假设**：插件能否在 `authorize` 期间起一个本地 HTTP 回调服务器，让浏览器完成后自动回填（无粘贴）。若能，lobsterai/gemini 的用户体验会显著优于粘贴式。若不能（宿主只支持"用户粘贴"这一种回执），保持档 A 的粘贴式，不引入额外复杂度。

**档 B —— 手动粘贴凭据**
适用：doubao、deepseek-web、chatgpt-web（降级）、raccoon、loomy。
`auth.methods` 用 `type: "api"` + `authorize` 纯校验（发一个只读请求验证 token 有效），instructions 里给 F12 抓取的分步指引（ChatLink 的 helpText 可直接改写成中文分步说明）。
注意：OpenCode 的 `type: "api"` 语义是"粘贴密钥"，落库后账号名会显示成"API key …尾号"。若渠道能拿到用户名，应在 callback 里返回 `accountId`/email，避免这种难看形态。

**档 C —— 匿名（零账号）**
适用：opencode-free。
不声明 `auth` 方法，`config` 里直接给 provider；插件在 `fetch` 里伪造客户端指纹与 `Bearer public`。
> **待验证**：magpie 对"没有 auth 的插件 provider"如何处理账号播种。ChatLink 的做法是播种一个匿名账号。若 magpie 必须有账号才能列出模型，则退回档 B 提供一个"点一下即完成"的空输入登录。

**不可自动化、明确排除**：loomy 短信验证码、raccoon 微信扫码 + 阿里云滑块、zcode 现场 headful captcha。这些渠道用档 B 手动粘贴，README 写明"需自行在官方 App 完成登录后取 token"。

### 5.2 请求桥接：loader.fetch

插件收到的 input/init 是 OpenAI Chat 形状（宿主已把 Anthropic / Responses 请求翻译成 Chat）。插件的职责：

1. 解析 body → 换成厂商协议；
2. 加鉴权与渠道头；
3. 发请求；
4. 把响应换成 OpenAI 形状（流式返回 SSE ReadableStream，非流式返回 JSON `Response`）。

**ChatLink 里那些复杂机制在插件里会变简单**，因为不需要 Provider 配置层，渠道规则可以硬编码：

| ChatLink 机制 | 插件里的写法 |
| --- | --- |
| `forceStream`（上游 SSE-only） | `fetch` 里恒发 `stream:true`，非流式调用方自己聚合 SSE |
| `userAgentByModelPrefix`（UA 按模型分档） | 一个 12 行的 `pickUA(modelId)` 函数 |
| `{{conversationId}}` 等动态头 | 模块级 `Map` 缓存 + `randomUUID()` |
| `bodyDefaults` / `ensureLeadingSystemMessage` | 发请求前直接改 body 副本 |
| `riskGuard` 节流 | **删除**，宿主负责退避 |

**错误语义三条铁律：**
- 上游 401 → 原样返回（宿主标账号、切下一个）。
- 上游 429/5xx → 原样返回（宿主退避/熔断）。
- **排队类错误绝不可回 429**（ChatLink 踩过：Qoder 的排队码被 riskGuard 误判成风控封 10 分钟）。有限等待后回 `503` + `Retry-After`，让宿主判定 busy 并切候选。

### 5.3 签到：auth.checkin

返回值 `{ outcome, credit?, streak?, message?, until? }`，outcome ∈ `claimed | done | ineligible | inactive | captcha | failed`。

- 幂等判据必须照 ChatLink 的实测结论硬编码（每家不同：`base_resp.status_code`、`replayed`、`alreadyProcessed`、`claimedToday`、`10001/1001=已领`、`9074=人数过多`）。
- **captcha 一律返回 `outcome: "captcha"`，不尝试破解**——这是 magpie 的明确边界，插件 README 也要写清楚"请去官方 App 签到"。
- 宿主有自己的调度（北京日、每 30 分钟、失败 30 分钟后重试、中午前的"已完成"视为暂定）。插件**不要**自己实现定时器。

### 5.4 用量：auth.usage

返回 `{ windows: [...] }`。三种窗口形态（按 magpie 语义）：
- 配额型：`{ name, used, limit }`
- 钱包型：`{ name, balance, unit }`（无 used/limit）
- 纯展示型：`{ name, display }`（无 used，卡片只显示文字，不参与路由）

网页逆向型渠道多数**没有**配额 API → 直接不实现 `usage`，magpie 显示"无配额报告"。不要编造数字。

### 5.5 传输层与 TLS 指纹（最高风险）

ChatLink 全部渠道用 axios（Node TLS），且自己在 chatgpt-web 适配器里标注："若上游按 TLS 指纹拦截，需要换 Electron net / impersonate 传输层——已知第一风险点"。

magpie 插件宿主是 Bun，**同样没有浏览器 TLS 指纹**。结论：
- 对 deepseek-web / chatgpt-web 这类强反爬渠道，**TLS 指纹拦截可能无解**，按"实验性"立项，失败即归档，不阻塞其他渠道。
- README 顶部必须醒目警示封号风险与指纹风险。
- 首日做一个小实验：用宿主 fetch 打一次 chatgpt.com 的 `/backend-api/me`，看是否被 Cloudflare 拦。这个实验的结果决定 M4 是否值得投入。

---

## 6. 渠道矩阵

### 6.1 排除清单（不做，附理由）

| 渠道 | 理由 |
| --- | --- |
| mimo、qoder/qoder-cn、zcode、workbuddy/workbuddy-ai、trae-cn、codebuddy、minimax-code、cline | 社区已有官方插件（`@magpie-community/opencode-*-auth`），含签到实现 |
| kilo、opencode、deepseek（API 型） | 标准 OpenAI 兼容 + API key，magpie 加自定义 provider 即可，插件零增量 |
| ChatLink 的 combo 模型 / 管理 API / 会话管理 / 统计 | magpie 原生 groups、路由策略、用量台账覆盖 |

> **M1 首日必须核实**（避免重复造轮子）：`gemini`（Code Assist）、`trae` 国际版、`kimi/glm/qwen` 网页版是否已有第三方插件。核实方式：查 magpie-community/plugins 仓库与 movers 表。

### 6.2 交付矩阵

| 批次 | 渠道 id | 登录档 | 协议难度 | 签到 | 用量 | 核心难点 |
| --- | --- | --- | --- | --- | --- | --- |
| **M0** | `lobsterai` | A | 中 | ✅ | — | 登录换 token + 续期字段贯穿 + forceStream 聚合 + 两个承重头 |
| **M1** | `opencode-free` | C | 低 | — | — | 匿名池 + v2 客户端指纹 |
| M1 | `zai` | A | 低 | — | — | 直转 + 拒绝 guest token |
| M1 | `qwen` | A | 中 | — | — | 适配器桥接 |
| M1 | `qwen-ai` | A | 中 | — | — | 同上，凭据映射不同 |
| M1 | `glm` | A | 中 | — | — | 适配器桥接 |
| M1 | `kimi` | A | 中 | — | — | 适配器桥接 |
| M1 | `perplexity` | A | 中 | — | — | 流式适配器 |
| **M2** | `doubao` | B | 中 | — | — | 手动 cookie + 用真实用户名填 accountId |
| M2 | `loomy` | B | 中 | ✅ | — | OpenAI 兼容 + HMAC-SHA1 签名 account |
| M2 | `gemini` | A | 高 | — | — | v1internal 协议 + access token 1h 自动续期 |
| M2 | `agnes` | B | 中 | — | — | 图像/视频生成（media 端点，非 chat） |
| **M3** | `deepseek-web` | B | 高 | — | — | sha3 PoW + 补丁流 SSE 状态机 + 200 信封业务码 |
| M3 | `raccoon` | B | 高 | — | — | 私有协议适配器 |
| **M4** | `chatgpt-web` | A | 极高 | — | — | sentinel 握手 + PoW + turnstile + 补丁流 + **TLS 指纹** |

### 6.3 M0 样板渠道的事实档案（lobsterai，已核查源码）

> 这一节是"渠道事实档案"的范例，后续每家都照此格式写进对应插件的 README。

**产品**：有道 LobsterAI（`lobsterai-server.youdao.com`），OpenAI 兼容但有两个承重约束。

**推理**：`POST /api/proxy/v1/chat/completions`
- `stream: false` 会被上游回 **500** —— 端点 SSE-only。插件必须恒发 `stream: true`，非流式调用方自己聚合。
- 两个头是**承重墙**，不是元数据：
  - `X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1`
    （缺第一个 → 上游静默返回不含 kimi-k3 的模型表；缺第二个 → `reasoning_effort: "off"` 回 500）
  - `X-LobsterAI-Client-Version: 2026.9.4`
- `User-Agent: LobsterAI/0.1.0`（照官方客户端逐字，与真实版本号无关）
- **刻意不发**：腾讯系的 `X-Domain` / `X-Product` / `X-IDE-*` 归因头（发了会错误归因客户端）
- 不支持图片输入（text only）

**登录**：`{portal}/portal#/login?source=electron&redirect_uri=...&state=...`
- 是 **hash 路由**，`#/login` 属 fragment，不能用 searchParams 构造，必须显式拼装。
- 换 token：`POST /api/auth/exchange`，**不带 Authorization**（此时还没有 token）。
- 响应是信封 `{code, data}`，code≠0 即失败。
- 凭据包含 `authCode / firstKeyfrom / latestKeyfrom / uuid / version`，其中 **`uuid` 与 `firstKeyfrom` 由客户端生成并贯穿账号生命周期**（续期时必须原样回传）。
- 推荐实现：把 `uuid` + `firstKeyfrom` 编进 `state` 参数随 URL 走，callback 时收回，无状态、无需服务端会话。

**续期**：整份凭据 JSON（含 refresh_token 与三个身份字段）存一个字段；续期失败**不抛**，继续用旧 token；401 时强制续期重试一次。

**签到**：三段式
1. `GET /` 版本号（来自 `api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update` 的 `data.value.version`，服务端不硬校验，兜底 `2026.9.4`）
2. `GET /api/client-activities/slot?placement=desktop_sidebar&containerApiVersion=2&platform=win32&clientVersion=…`
3. `GET /api/client-activities/{activityCode}/context?configRevision=…`
4. `POST /api/client-activities/{activityCode}/actions/check_in`
- **幂等是客户端负责的**：请求带 `idempotencyKey`（UUID4），必须先检查 context 的 `state.claimedToday` **且** `actions` 含 `check_in` 才能领（只看 claimedToday 会漏掉"活动存在但今天不可领"）。
- 三个响应都在 `{code, data}` 信封里；积分字段有三级兜底 `creditsGranted → rewardCredits → credits`。
- 签到鉴权是纯 Bearer，无签名。

**模型**：18 个（DeepSeek-V4 / Kimi-K2.7/K2.6 / Qwen3.7 / MiniMax-M3 / Doubao-Seed-2.1 / GLM-5.x），展示名与 wire id 映射需逐条照搬（如 `MiniMax-M3` → `MiniMax-M3`，`Doubao-Seed-2.1-Pro` → `doubao-seed-2-1-pro-260628`）。

---

## 7. 每批的工作项清单

新增一个渠道插件的固定十步（M0 固化后作为 checklist）：

1. 建 `plugins/magpie-<id>-auth/`，抄模板骨架。
2. `lib/constants.mjs`：provider id、显示名、API 基址、模型清单与映射。
3. `lib/login.mjs`：`auth.methods`，含中文分步 instructions。
4. `lib/bridge.mjs`：请求改写 + SSE 投影 + 错误映射。
5. `lib/checkin.mjs`（可选）：三段式 + 幂等判据。
6. `lib/usage.mjs`（可选）：窗口数组。
7. `test/`：至少覆盖 — 协议解析、SSE 补丁流投影、签到业务码矩阵、续期判定、错误映射。
8. `package.json`：magpie 元数据 + `scripts.test`（会被根目录 `test-all.mjs` 自动发现）。
9. `README.md` + `README.en.md`：渠道事实档案 + 封号风险警示 + 登录图解。
10. 根 README 的插件表补一行；`npm test` 全绿；真机验收。

**真机验收清单（每插件必须全过，需用户真实账号）：**
登录成功 → 账号显示真实用户名（非"API key…"）→ 模型列表正确 → 一次流式对话 → 一次非流式对话 → 多轮上下文正常 → 签到（若有）→ 用量卡片（若有）→ 401 后 magpie 自动切换下一个账号。

---

## 8. 测试与 CI

- **单测**：`node:test`，零依赖。ChatLink 的 792 个 vitest 用例是**逻辑规格**而非可直接复制的代码——照其断言重写为 fixture 测试。
- **fixture 来源**：真机抓包脱敏后存 `test/fixtures/`（SSE 补丁流样本、签到各业务码响应、PoW 挑战与解）。
- **CI**：已有 `.github/workflows/test.yml` 在 ubuntu + windows 双平台跑 `node scripts/test-all.mjs`，新插件自动纳入。
- **不做**：不引入 vitest/jest，不给插件加 devDependencies。

---

## 9. 许可证合规

**事实**：ChatLink = GPL-3.0；magpie-plugin-pack = MIT。

**路线 A（推荐）——按协议事实重写：**
- 允许：读 ChatLink 源码理解协议、抄端点/业务码/字段名/头名、照搬测试断言所表达的行为规格。
- 禁止：复制源码文本（含注释、变量命名风格、函数结构）到 MIT 文件。
- 实践中就是"看完关掉，凭事实清单自己写"。每家适配器 200~600 行，重写成本远小于合规成本。
- 每个插件的 LICENSE 文件写 MIT，README 里注明"协议事实参考 ChatLink（GPL-3.0）的实现行为，代码为独立重写"。

**路线 B（备选，不推荐）——GPL 单插件**：
pack 允许每插件独立许可，可直接移植并以 GPL-3.0 发布。缺点是混许可仓库让人犹豫采用，npm 生态也敏感。

**红线**：无论哪条，不把 ChatLink 源码文本贴进 MIT 文件。

---

## 10. 里程碑

| 里程碑 | 内容 | 验收 | 估时 |
| --- | --- | --- | --- |
| **M0** ✅ | lobsterai 样板插件 + 模板固化 | **已交付**：38 个单测全绿、magpie 0.1.3226 成功加载（`lobsterai (LobsterAI, 18 models)`）；**真机验收待用户账号** | 已完成 |
| **M1** | opencode-free、zai、qwen、qwen-ai、glm、kimi、perplexity（7 家）+ 社区覆盖核实 | 各自真机验收过 | 4–6 天 |
| **M2** | doubao、loomy、gemini、agnes（4 家） | 同上；gemini 需验 1h token 自动续期 | 5–7 天 |
| **M3** | deepseek-web、raccoon（2 家） | 同上 + PoW 单测；README 标实验性 | 5–7 天 |
| **M4** | chatgpt-web（已立项） | 先做 TLS 指纹实验；通过则走真机验收，不通过则归档并留痕 | 2 天实验 + 3–5 天实现 |
| **收尾 A** | 中英 README + 根 README 插件表 + 文件夹就地加载全链路验证 | `magpie plugin add <文件夹路径>` 即用 | 含在各批次内 |
| **收尾 B**（后续） | npm 逐包发布 + magpie-community/plugins registry PR | 用户 `magpie plugin add <包名>` 即用 | 2 天 |

累计约 4–5 周。

---

## 11. 风险登记册

| 风险 | 等级 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 上游协议变更（ChatLink 记录显示渠道迭代很快） | 高 | 插件失效 | 一渠道一包一版本，坏一家不连坐；协议事实集中在 `lib/` 便于热修 |
| 封号风险（网页逆向渠道） | 高 | 用户账号受损 | README 顶部醒目警示；建议非主力号；不实现自动化高频调用 |
| TLS 指纹拦截（deepseek-web / chatgpt-web） | 高 | 渠道根本不可用 | M4 先做可行性实验；失败即归档，不阻塞 |
| 登录 UX 降级（无法自动抓 cookie） | 中 | 用户放弃 | instructions 文案逐字打磨（照 ChatLink helpText）；标准 OAuth 渠道优先交付 |
| 宿主 API 与文档不一致 | 中 | 返工 | M0 首日用手搭的最小插件实测全部 hook，以实测为准修正模板 |
| GPL 污染 | 中 | 法律风险 | 路线 A + 交付前 diff 抽查 |
| 15 个包的长期维护 | 中 | 腐烂 | 渠道事实档案化；接受社区 PR；提供 `plugin add` 就地加载方便用户自行热修 |
| Bun 宿主与 Node 差异（WASM / node:crypto sha3） | 中 | 个别渠道阻塞 | M3 首日专项验证；备选带 wasm 文件用 `import.meta.url` 定位 |

---

## 12. 决策记录（2026-11-09 已锁定）

| # | 决策 | 结论 | 影响 |
| --- | --- | --- | --- |
| D1 | 许可证 | **路线 A：按协议事实重写，全部 MIT** | 禁止复制 ChatLink 源码文本；交付前 diff 抽查 |
| D2 | 渠道范围 | **15 家全做**（M0~M4 全量，含重做 deepseek-web / opencode-free / chatgpt-web） | 见 §12.1：这三家已有第三方插件，需处理 provider id 冲突 |
| D3 | chatgpt-web | **立项**（M4 正式排期，不再是条件性） | 先做 TLS 可行性实验，失败则降级为"已归档"并在文档留痕 |
| D4 | 交付方式 | **第一阶段只做文件夹就地加载**；npm 逐包发布 + 社区 registry 作为收尾阶段 | 收尾阶段推迟，不阻塞 M0~M3；`files` 字段与 README 仍按可发布标准写 |

D4 的落地含义：每个插件必须能被
```
magpie plugin add "F:\maple\magpie-plugin-pack\plugins\magpie-<id>-auth"
```
就地加载并随代码改动生效，因此**零运行时依赖 + 纯 ESM** 从"偏好"升级为"硬约束"。

---

## 12.1 provider id 冲突（D2 的直接后果）

**事实**（2026-11-09 实测本机 magpie 0.1.3226 的已装插件）：

| 渠道 | 已有插件 | 状态 |
| --- | --- | --- |
| `deepseek-web` | `github:volcanicll/magpie-deepseek-web-auth` 0.1.1 | 已登录，2 个模型 |
| `chatgpt-web` | `github:guanwenpeng2001-bot/magpie-chatgpt-web` 0.2.0（在服务）<br>`github:mu-zi-lee/magpie-chatgptweb2api` 0.1.0（同 id） | 均未登录，仅 1 个模型 |
| `opencode-free` | `@magpie-community/opencode-zen-free-auth` 0.1.26（provider id 为 `opencode-zen-free`） | 已登录，11 个模型 |

**宿主规则**（provider-plugins.md「Two plugins for one provider id」）：一个 provider id 只由一个插件服务；两个插件都声明同一 id 时，由 `plugins.json` 的 `prefer` 决定，默认取列表最后一个；两个插件的行都会显示在 Plugins 页，落选的一行带 **Use for {name}** 按钮。

**本项目的处理**：

1. **不用相同 id 硬碰**。新插件改用可区分的 id：
   - `deepseek-web` → 若重做，id 用 `deepseek-web`（与现状同名，靠 `magpie plugin use` 切换归属），并在 README 写明与 volcanicll 版的差异。
   - `chatgpt-web` → 同上，id `chatgpt-web`。
   - `opencode-free` → **已存在同名语义插件**（`opencode-zen-free`），本项目 id 用 `opencode-free`，与 zen-free 并存不冲突。
2. 交付时在 README 给出明确的切换命令：
   ```
   magpie plugin use <本插件> <provider-id>
   ```
3. **不静默接管**：绝不覆盖用户已有的账号配置；首次安装后必须由用户显式选择归属。
4. 若用户不想有两个插件，README 说明如何移除旧插件。

---

## 12.2 参考实现优先级（重要）

原方案设想"照 ChatLink 源码重写"。实测后发现本机 `~/.config/magpie/plugins/node_modules/` 下有**多个可运行的 magpie 插件**，它们是更直接的参考（真实 hook 用法、真实错误处理、真实宿主约定）：

| 参考 | 路径 | 用途 |
| --- | --- | --- |
| 社区插件（13 个） | `node_modules/@magpie-community/opencode-*-auth` | 标准结构、登录方法、签到、用量 |
| `magpie-deepseek-web-auth` | `node_modules/magpie-deepseek-web-auth` | PoW + 补丁流 SSE 的 magpie 侧写法 |
| `magpie-chatgpt-web` | `node_modules/magpie-chatgpt-web` | sentinel/Turnstile 的 magpie 侧写法 |
| `magpie-inkstone-auth` | 本仓库 `plugins/` | 本项目既有样板 |

**新顺序**：先读 magpie 侧参考实现（拿 hook 用法）→ 再读 ChatLink（拿协议事实）→ 自己写。这样既避开 GPL 文本，又天然贴合宿主约定。

---

## 13. 待技术验证（M0 首日必须闭环）

| # | 假设 | 验证方式 | 失败时的退路 |
| --- | --- | --- | --- |
| V1 | 插件能在 `authorize` 期间跑本地回调服务器，实现登录"零粘贴" | 手搭最小插件 + lobsterai 登录页实测 | 退回档 A 粘贴式（inkstone 已验证可行） |
| V2 | 匿名 provider（不声明 auth）宿主能播种账号 | 手搭最小插件查 `/api/providers` | 改用档 B 空输入登录 |
| V3 | 宿主 fetch 打 chatgpt.com 是否被 Cloudflare/TLS 指纹拦截 | 打 `/backend-api/me` 看响应 | M4 标注实验性失败，归档 |
| V4 | 本机 `magpie` 可执行（当前不在 PATH） | 定位二进制并 `magpie --version` | 从 `F:\maple\magpie` 源码构建，或请用户提供安装路径 |

---

## 14. 交付记录

### M0 — lobsterai（2026-11-09）

| 项 | 结果 |
| --- | --- |
| 位置 | `plugins/magpie-lobsterai-auth/`（1574 行，18 文件） |
| 单测 | `npm test` **38/38 通过**（http / sse / login / checkin / bridge 五组） |
| 宿主加载 | `magpie plugin add` 成功，识别为 `lobsterai (LobsterAI, 18 models)` |
| 全包回归 | 根目录 `npm test`（遍历 plugins/*）全绿 |
| 未完成 | **真机验收**：需要用户的 LobsterAI 账号完成一次登录 → 对话 → 签到 |

**开发中发现并修正的真实缺陷（由测试暴露）：**
- 签到流程里一次 HTTP/网络异常会直接抛出，而不是收敛成 `outcome: "failed"` —— 已改为整体 try/catch，让 magpie 按其退避重试。

**M0 沉淀的可复用经验（后续 14 个插件直接照用）：**
1. 插件入口只导出**一个**函数；magpie 会把模块里每个导出函数都当插件调用。
2. `auth.loader(getAuth)` 返回 `{ baseURL, apiKey, fetch }`；`fetch` 内必须**每请求重新 getAuth**，否则续期不生效。
3. 错误响应通过 `x-magpie-sign-in: expired` 头告诉宿主"该账号需要重新登录"。
4. 手填凭据（`type: "api"`）落库字段是 `auth.key`，不是 `token`。
5. 签到 outcome 用 magpie 词汇：`claimed / done / ineligible / inactive / captcha / failed`（ChatLink 的 `already` 要映射成 `done`）。
6. 上游 SSE-only 时：请求恒发 `stream: true`，流式调用方原样透传字节，非流式调用方聚合。
7. 额度耗尽若以 402 或 4xx + 中文文案返回，要转成 **429** 才能让宿主切下一个账号。

---

## 15. M1 进展与阻塞（2026-11-09）

### 已交付并装入本机 magpie

| 插件 | provider id | 模型 | 单测 | 宿主 |
| --- | --- | --- | --- | --- |
| magpie-lobsterai-auth | `lobsterai` | 18 | 38 | ✅ 已加载 |
| magpie-zai-auth | `zai-web` | 4 | 2 | ✅ 已加载 |
| magpie-opencode-free-auth | `opencode-free` | 9 | 10 | ✅ 已加载 |

全包 `npm test` 通过（含既有 inkstone）。

### 阻塞一：provider id 与 magpie 内置 preset 冲突（已解决）

`magpie presets` 显示内置已有 `zai`、`kimi`、`qwen`（API-key 版供应商）。插件沿用同名 id 时，magpie 会：
1. 把插件 provider 改名成 `zai-plugin`；
2. 内置的模型清单覆盖插件清单（首次实测得到 18 个模型而非 4 个）。

**处置**：Web 会话型渠道一律用 `-web` 后缀（`zai-web`、`kimi-web`、`qwen-web`），并把模型合并顺序改为「插件清单最后写入」。这不是命名洁癖——两者是不同凭证、不同模型集。

### 阻塞二：多个渠道依赖「客户端常量」，而它在源码里被遮蔽

ChatLink 的部分适配器依赖客户端侧的签名密钥 / 反爬指纹常量，这些值在读取时被遮蔽为 `{{SECRET_…}}`：

| 渠道 | 依赖的常量 | 后果 |
| --- | --- | --- |
| `glm` | `SIGN_SECRET`（`md5(timestamp-nonce-secret)` 的密钥） | 无法签名 → 请求必被拒 |
| `qwen-ai` | `bx-ua` / `bx-umidtoken`（阿里反爬指纹） | 无法构造合法请求头 |
| `kimi` / `perplexity` | User-Agent 串 | 可用自备 UA 替代，不阻塞 |

**结论**：这两个渠道无法在"重写"路线下完成——不是工作量问题，是缺少必要的互操作常量。需要用户决定是否授权我用机械方式把常量搬进插件（值不进我的上下文），或改为手动填写。

### 阻塞三：剩余渠道协议复杂度重估

对照 ChatLink 适配器实现，剩余 12 家**没有一家是 OpenAI 直转**：

| 渠道 | 真实形态 | 关键依赖 |
| --- | --- | --- |
| `glm` | 自定义 SSE + 会话 id | md5 签名（阻塞二） |
| `kimi` | Connect 协议帧（`application/connect+json`） | 帧封装 |
| `qwen` | 自定义 SSE + **zstd 响应解压** | zstd 运行时支持 |
| `qwen-ai` | 先建 chat（`/api/v2/chats/new`）再发消息，phase 状态机（think/answer） | 反爬头（阻塞二） |
| `perplexity` | 先取会话（backend_uuid/token）再 SSE | 会话引导 |
| `doubao` | cookie 鉴权 + 自定义协议 | JWT 身份提取 |
| `loomy` | OpenAI 兼容 + HMAC-SHA1 签名账号 | 签名 |
| `gemini` | v1internal 协议 + access token 1h 续期 | 续期链路 |
| `deepseek-web` | sha3 PoW + 补丁流 SSE 状态机 | PoW |
| `chatgpt-web` | sentinel 握手 + PoW + Turnstile + 补丁流 | 反爬 + TLS 指纹 |
| `raccoon` | 私有协议 | 待评估 |
| `agnes` | 图像/视频生成端点（非 chat） | media 路由 |

每家的真实工作量是 1–3 天（含真机验证），M1 剩余 5 家 + M2/M3/M4 的 7 家合计约 3 周。

### 下一步建议顺序

1. 解决阻塞二（授权方式）→ 解锁 `glm`、`qwen-ai`。
2. 用户真机登录 `lobsterai` 完成 M0 闭环验收。
3. 按 `perplexity` → `kimi` → `qwen` → `doubao` → `loomy` 顺序推进（按"协议可自洽实现"排序）。
4. `gemini` / `deepseek-web` / `chatgpt-web` 最后做，且每个都要先跑通一次真实请求再写代码。
### 本轮补充（2026-11-09 晚）：glm 与 qwen-ai 已交付

常量搬运按用户授权以机械方式完成（值不进入模型上下文），两家的协议实现如下：

| 插件 | provider id | 模型 | 单测 | 关键协议 |
| --- | --- | --- | --- | --- |
| magpie-glm-auth | `glm` | 3 | 6 | `md5(时间戳-随机数-密钥)` 签名；时间戳倒数第二位是校验位；流是**累积快照**要算增量 |
| magpie-qwen-ai-auth | `qwen-ai` | 10 | 9 | 先 `/api/v2/chats/new` 建会话再发消息；delta 带 `phase`（think/answer） |

**当前总进度：5 / 15**（lobsterai、zai-web、opencode-free、glm、qwen-ai），全部已装入本机 magpie，全包测试通过。

### 剩余 10 家与其真实门槛

| 渠道 | 原型状态 | 主要工作量 |
| --- | --- | --- |
| `perplexity` | 未开始 | 先取会话（backend_uuid / read_write_token）再 SSE |
| `kimi` | 未开始 | Connect 协议帧（`application/connect+json`） |
| `qwen` | 未开始 | 自定义 SSE + zstd 响应解压 |
| `doubao` | 未开始 | cookie 鉴权 + 自定义协议 |
| `loomy` | 未开始 | OpenAI 兼容 + HMAC-SHA1 签名 |
| `gemini` | 未开始 | v1internal 协议 + 1h token 续期 |
| `agnes` | 未开始 | 图像/视频生成端点（非 chat，需 media 路由） |
| `deepseek-web` | 未开始 | sha3 PoW + 补丁流 SSE 状态机 |
| `raccoon` | 未开始 | 私有协议，待评估 |
| `chatgpt-web` | 未开始 | sentinel + PoW + Turnstile + TLS 指纹 |

按已交付 5 家的实际速度（每家含读协议、写实现、写测试、装宿主验证），剩余 10 家约 2–3 周。
### 进度更新（按建议顺序推进后）：7 / 15

| # | 插件 | provider id | 模型 | 单测 | 协议要点 |
| --- | --- | --- | --- | --- | --- |
| 1 | magpie-lobsterai-auth | `lobsterai` | 18 | 38 | SSE-only 聚合 + 承重头 + 四段式签到 |
| 2 | magpie-zai-auth | `zai-web` | 4 | 2 | OpenAI 直转 |
| 3 | magpie-opencode-free-auth | `opencode-free` | 9 | 10 | 匿名池 + v2 会话指纹 + 指纹工具 |
| 4 | magpie-glm-auth | `glm` | 3 | 6 | md5 签名 + 校验位时间戳 + 累积 parts |
| 5 | magpie-qwen-ai-auth | `qwen-ai` | 10 | 9 | 先建会话再发消息 + phase 分流 |
| 6 | magpie-perplexity-auth | `perplexity` | 10 | 9 | 会话 Cookie + diff 补丁累积 |
| 7 | magpie-kimi-auth | `kimi-web` | 4 | 10 | gRPC-Web 帧封装 + 跨包分片解码 |

全部已装入本机 magpie，全包 `npm test` 通过（含既有 inkstone）。

**仍未完成（8 家）**：`qwen`、`doubao`、`loomy`、`gemini`、`agnes`、`deepseek-web`、`raccoon`、`chatgpt-web`。

### `qwen` 的已知技术判断（下一个目标）

ChatLink 的 qwen 适配器依赖 **zstd 响应解压**（`Uint8Array` 级解压，还带 `zstd-codec` 依赖）。magpie 的插件宿主是 **Bun**，其 `node:zlib` 是否提供 zstd 未知。

**不必硬碰**：HTTP 的 `Accept-Encoding` 由请求方决定。插件只要不声明 `zstd`（只发 `gzip, deflate, br`），上游应当以标准编码回应，从而绕开解压需求。若上游强制 zstd，则退回到"内置 WASM 解码器"方案，工作量会显著上升——这一点必须在写代码前用一次真实请求确认。
### 进度更新（续）：10 / 15

按建议顺序新增 3 家，均已装宿主、单测通过：

| 插件 | provider id | 模型 | 单测 | 协议要点 |
| --- | --- | --- | --- | --- |
| magpie-qwen-auth | `qwen-web` | 9 | 12 | SSE 累积内容 + `meta_data.multi_load` 思考分片；思考是换 agent 不是加开关 |
| magpie-doubao-auth | `doubao` | 1 | 12 | 编号事件 2001/2003；`event_data` 字符串套 JSON 再套 JSON；内容是真增量 |
| magpie-loomy-auth | `loomy` | 8 | 2 | 标准 OpenAI 直通；模型名带计费倍率 |

**关于 qwen 的 zstd 岔路：此前判断有误，实测源码后作废。** ChatLink 的 qwen 适配器默认请求头里**并没有声明 `Accept-Encoding: zstd`**（zstd 只是防御性分支），所以服务端不会返回 zstd，标准 fetch 即可。这条不需要用户提供 token 才能定夺——读源码就能定。

**doubao 的一处主动偏离**：官方客户端声明 `Accept-Encoding: gzip, deflate, br, zstd`，本插件**不声明 zstd**——运行时装不了解码器就会拿到读不了的字节。这是有意为之，已写进 README。

### 剩余 5 家

`gemini`、`agnes`、`deepseek-web`、`raccoon`、`chatgpt-web`。

其中 `gemini` 需要 v1internal 协议 + access token 1h 续期；`agnes` 是图像/视频端点（非 chat，需要 media 路由）；`deepseek-web` 是 sha3 PoW + 补丁流状态机；`raccoon` 私有协议；`chatgpt-web` 是 sentinel + Turnstile + TLS 指纹。
### 进度更新（续）：13 / 15

| 插件 | provider id | 模型 | 单测 | 协议要点 |
| --- | --- | --- | --- | --- |
| magpie-gemini-auth | `gemini-code-assist` | 4 | 14 | v1internal 信封 + antigravity 身份头 + 1h token 续期 |
| magpie-raccoon-auth | `raccoon` | 6 | 4 | OpenAI 直通 + 组织码头（空则不发） |
| magpie-agnes-auth | `agnes` | 5 | 3 | 文本模型直通；媒体模型**刻意不列** |

**又一处 id 冲突**：`gemini` 与 magpie 内置订阅同名，装上去被改名成 `gemini-plugin`，已改为 `gemini-code-assist`。

**agnes 的范围收缩（有依据）**：它的 `agnes-image-*` / `agnes-video-*` 不是 chat completions（图像同步返回 URL、视频异步轮询最长 900s），属于 magpie 的图像/视频 drawer 表面。列在对话 provider 里只会让用户点了就报错，所以只上文本模型并在 README 写明。

### 未完成：2 家（deepseek-web、chatgpt-web）

这两家与前面 13 家的难度不在一个量级——它们不是"协议形状不同"，而是**带校验的状态机**：

| 渠道 | 缺什么 |
| --- | --- |
| `deepseek-web` | 每次写操作前要取 PoW 挑战，用官方 sha3 WASM 解出 `x-ds-pow-response`（仓库根有 26KB 的 `sha3_wasm_bg.7b9ca65ddd.wasm` 要一并打进插件）；响应是补丁流状态机（`{"v":…}` 快照 + `{"p":"response/fragments","o":"APPEND"}` 增量）；再加会话 create/delete |
| `chatgpt-web` | sentinel 握手拿 4 个 token、PoW、Turnstile、补丁流；且**依赖浏览器 TLS 指纹**，ChatLink 自己标注为第一风险点，magpie 的 Bun 宿主同样没有 |

**为什么没有硬做**：PoW 和 Turnstile 的正确性只有在真实端点上才验证得出来——写一个"结构对但解不出"的求解器，产物是坏的而不是不完整的，比不做更糟。这两家需要先跑通一次真实请求，再按观测结果写。
### 进度更新（续）：14 / 15

| 插件 | provider id | 模型 | 单测 | 协议要点 |
| --- | --- | --- | --- | --- |
| magpie-deepseek-web-auth | `deepseek-web` | 2 | 11 | sha3 PoW（wasm 随包）+ 每轮新会话 + 补丁流状态机 |

**踩到并修掉了一个真实事故**：装上后 magpie 按"最后添加者服务"的默认规则，让我的插件接管了 `deepseek-web`，而用户原本已登录的是 volcanicll 版——两者凭据格式不同，接管会让一个**本来可用的账号变成登录失效**。

已用 `magpie plugin use github:volcanicll/magpie-deepseek-web-auth deepseek-web` 回退，原插件恢复服务，用户的登录态完好。**教训**：同 id 渠道的插件安装后必须立即显式指定归属，不能依赖默认规则；这条要写进后续任何插件包的安装文档。

### 未完成：1 家（chatgpt-web）

sentinel 握手拿 4 个 token + PoW + Turnstile + 补丁流，且**依赖浏览器 TLS 指纹**。ChatLink 自己把它标注为第一风险点（"若上游按指纹拦截，需要换 Electron net / impersonate 传输层"）。magpie 的 Bun 宿主同样没有指纹能力，所以这一家的成败不取决于协议写得对不对，而取决于传输层——需要先做一次真实连通性实验才能判断值不值得投入。
### 交付完成：15 / 15（2026-11-09）

| 插件 | provider id | 模型 | 单测 | 协议要点 |
| --- | --- | --- | --- | --- |
| magpie-chatgpt-web-auth | `chatgpt-web` | 4 | 18 | sentinel 四步握手 + 本地 PoW（sha3-512 字节序比较）+ turnstile 栈式 VM + 补丁流 |

**交付前修掉一个真实缺陷（宿主加载失败暴露）**：`index.mjs` 导出了 `conversationMessages` / `conversationPayload` 两个辅助函数，magpie 把**每个导出函数都当插件调用**，`conversationPayload(input, options)` 在宿主里直接执行并崩在 `cred.timezone` —— M0 已记录过的坑在 chatgpt-web 上重犯了。修复：载荷构造移入 `lib/payload.mjs`，入口只导出插件函数。**这条要进模板 checklist 的第一条**：入口文件 `grep '^export'` 必须只有一行。

**归属未接管**：`chatgpt-web` 仍由原有的 `github:guanwenpeng2001-bot/magpie-chatgpt-web` 服务（两个既有插件都未登录，无账号可破坏）。按 §12.1 规则不静默接管；用户要切到本插件：
```
magpie plugin use F:\maple\magpie-plugin-pack\plugins\magpie-chatgpt-web-auth chatgpt-web
```
`deepseek-web` 归属同样保持 volcanicll（用户已登录账号完好）。

**chatgpt-web 的实验性边界**：PoW、turnstile、补丁流、载荷字段全部离线实现并有单测（含 turnstile VM 真实执行端到端、真实 sha3 求解），但**真实连通性未验证**——上游可能按 TLS 指纹拒绝 Bun 宿主的非浏览器客户端。README 顶部有显著警示。若真机被拦，失败属预期内，不在插件侧修复范围内。

### 全量终态（15 插件）

| # | 插件 | id | 模型 | 单测 |
| --- | --- | --- | --- | --- |
| 1 | magpie-lobsterai-auth | lobsterai | 18 | 38 |
| 2 | magpie-zai-auth | zai-web | 4 | 2 |
| 3 | magpie-opencode-free-auth | opencode-free | 9 | 10 |
| 4 | magpie-glm-auth | glm | 3 | 6 |
| 5 | magpie-qwen-ai-auth | qwen-ai | 10 | 9 |
| 6 | magpie-perplexity-auth | perplexity | 10 | 9 |
| 7 | magpie-kimi-auth | kimi-web | 4 | 10 |
| 8 | magpie-qwen-auth | qwen-web | 9 | 12 |
| 9 | magpie-doubao-auth | doubao | 1 | 12 |
| 10 | magpie-loomy-auth | loomy | 8 | 2 |
| 11 | magpie-gemini-auth | gemini-code-assist | 4 | 14 |
| 12 | magpie-raccoon-auth | raccoon | 6 | 4 |
| 13 | magpie-agnes-auth | agnes | 5 | 3 |
| 14 | magpie-deepseek-web-auth | deepseek-web | 2 | 11 |
| 15 | magpie-chatgpt-web-auth | chatgpt-web | 4 | 18 |

合计 118 个模型条目、160 个单测，全包 `npm test` 通过，15 个插件全部可 `magpie plugin add` 就地加载。

**遗留（非阻塞）**：
1. **真机登录验证全部未做**——每个插件都需要用户账号跑一次 `magpie plugin login`。
2. loomy 的签到未移植（低优先）。
3. agnes 的图像/视频（drawer 表面）未实现，README 已写明。
4. npm 逐包发布 + 社区 registry PR 属收尾 B（按 D4 决策推迟）。

### 合并为单包 magpie-nest（2026-11-09，用户要求：插件太多，安装麻烦）

**动机**：15+1 个独立插件对用户是 16 次 `plugin add`、16 行插件页、16 份 npm 发布。

**架构（qoder 同款）**：入口 `index.mjs` 导出 16 个插件函数（`InkstoneAuthPlugin`…`ZaiPlugin`），宿主把每个导出函数当**独立插件**运行——故障隔离、per-provider 登录、并发限制全部保留。各渠道代码原样收进 `lib/<id>/`（index.mjs + 原 lib/*.mjs 平铺），只改 import 路径；协议笔记随迁为 `lib/<id>/README.md`；deepseek 的 wasm 进包根 `assets/`。

**两个踩坑**：
1. bash 里 `"$NEW/test/$name__file"` 被解析成变量 `name__`（下划线属于变量名字符集）→ 前缀静默丢失，inkstone 与 lobsterai 的 `bridge.test.mjs` 同名相撞覆盖、测试少了一份。修复：`${name}-`。教训：**bash 拼文件名永远花括号**。
2. inkstone 的 `install.test.mjs` 断言「入口恰好导出 1 个插件函数」——合订包 16 个直接红。改写为 `pack-install.test.mjs`：入口恰好 16 个**具名**插件函数（多=辅助泄漏，少=渠道丢失）、`files` 白名单复制到临时 node_modules 后整包可装载（含 wasm 资产）、`magpie.icon` data URI 与 icon.svg 一致。

**终态**：合订包 164/164 单测全绿；magpie 侧 16 个旧目录插件已 `plugin rm`、合订包一行装载；归属不变（inkstone=自有代码继续服务、登录 hong 完好；deepseek-web=volcanicll；chatgpt-web=guanwenpeng2001-bot）。git 检查点 `d6fef71` 保留了合并前的 16 插件形态。

### 更名 + 品牌：鹊巢 magpie-nest（2026-11-09 晚，用户反馈：名字不合意、缺 logo 和说明）

**名字**：magpie-web-auth-pack → **鹊巢 magpie-nest**。两次 ask_user_question 均超时未答，按推荐候选执行并记录为假设——换名成本 = 目录 + package.json + 一轮 sed，一条命令的事。语义：喜鹊爱收集亮闪闪的小物回巢，magpie 收集 16 家渠道共栖一巢，与宿主品牌同源。

**logo**（三处同源：仓库根 logo.svg = plugins/magpie-nest/icon.svg = package.json 的 magpie.icon data URI，pack-install 测试强制一致）：暮色圆角底 + 星子；黑头白身喜鹊、琥珀眼喙、青绿长尾挑向左上；褐色编织巢 + 三颗宝石（琥珀/青/粉，代表 16 渠道）；喙尖衔一颗星。**三版浏览器实渲染迭代**：v2 鸟读不出（白腹像云、头是孤立圆点）；v3 尾和头都在右上，尾被看成头顶冠羽；v4 尾改挑左上，读出「喜鹊 + 长尾 + 巢 + 三宝石 + 衔星」定稿。

**identity**：magpie.name「鹊巢」、中英 summary/description/keywords；根 README（中英）加 banner（logo + 品牌题 + CI 徽章）；16 个 lib/<id>/README 的旧独立包名与安装路径全部改为合订包形态（含 inkstone 的注册表示例、沙箱冒烟脚本、目录树图）。

**magpie 侧**：旧路径条目 rm → 新路径 add；inkstone 登录态（hong）无损迁移；deepseek-web/chatgpt-web 归属不变。

**待用户手动**（本机无 gh CLI）：GitHub 仓库 Description + Topics，文案见交付说明。

### 双版本渠道 + 浏览器一键登录（2026-11-10，用户反馈：「有国内国外版的都需要支持」）

**双版本原则**：厂商若同时经营中国版与国际版，两版**账号体系互不通用**，必须各占一个 provider id、各自登录。审计后补齐 4 家 × 2 版（共 9 个新 provider，合订包 16 → 25）：

| 厂商 | 国际版 id | 中国版 id | 依据 |
| --- | --- | --- | --- |
| 阿里 Qwen | `qwen-ai`（已有） | `qwen-web`（已有） | chat.qwen.ai / qianwen.com |
| 智谱 | `zai-web`（已有） | `glm`（已有） | chat.z.ai / chatglm.cn |
| 阿里 Qoder | `qoder` | `qoder-cn` | 宿主 agents.go:281-282 就叫 qoder/qoderCN；社区 opencode-qoder-auth 有 region 表 |
| 字节 TRAE | `trae-global` | `trae-cn` | 域名 trae.ai（api-sg/us + core*/grow*）与 trae.cn（api.trae.cn、trae-api-cn.mchost.guru） |
| 腾讯 | `workbuddy-ai` | `workbuddy` + `codebuddy` | ChatLink oauth/adapters/codebuddy.ts:73-94 的 buddyProduct 表：同一授权协议、三个产品 |
| 智谱 AutoGLM | `autoclaw` | `autoclaw-cn` | autoglm-api.autoglm.ai / autoglm-api.zhipuai.cn |

**Agnes 是单版本**：agnes-ai.com 只是英文官网，API 只在 api.agnes-ai.cn（实测 .com/v1/models 返回 404），不需要拆两版。

**执行拓扑**：4 个厂商互相正交、目录互不相交 → 并行派 4 个子代理各做一家，dispatcher 只保留入口注册、package.json、验收三个写点。

**真机验收逼出的 6 个集成 bug**（子代理自测全过，联网即暴露）：
1. `qoder` 把**上游**路径 `/agent_chat_generation` 当**入站**校验，宿主发的是 `/chat/completions` → 全部 404。
2. `qoder-cn` 的模型 key 与国际版完全不同：国际版档位名（ultimate/performance/efficient）在中国版网关一律 400「Unsupported model」，真实 key 是 `qmodel_latest`/`qfmodel`/`kmodel_latest` 族。联网实测出 8 个可用模型。
3. `trae` 静态模型表猜不中（账号实际 88 / 67 个）→ 改为拉账号真实目录 `/api/ide/v1/batch_get_detail_param`，并按「列了该模型的 function + config_name」路由；静态猜的 channel 上游只回 "the param is invalid"。
4. `trae-global` 把**用量主机**当模型主机：`api-sg-central.trae.ai` / `api-us-east` / `grow-*` 都不是 chat 主机，模型只在 `coresg-normal`（新加坡）/ `coreva-normal`（美国），否则上游回一张 404 网页。
5. `workbuddy-ai` 要求首条必须是 system，否则 `11128 first message is not system prompt`。
6. **四家统一**：未在静态表里的模型不再本地 404，放行给上游判断——静态表只用于展示与能力声明，本地拒绝会让厂商一上新模型渠道就废。

**浏览器一键登录（lib/weblogin/，零依赖）**：宿主只支持 `oauth` / `api` 两种登录方式，没有 WebView、没有本地回调端口——ChatLink 那种 Electron 内嵌登录窗口在插件里不存在。改用 **CDP 驱动用户真实浏览器**：拉起 Chrome/Edge（`--user-data-dir` 按渠道独立 + `--remote-debugging-port`）→ 手写 RFC6455 WebSocket 客户端（`ws.mjs`，客户端帧必须掩码）→ `Network.enable` + `Runtime.evaluate` → cookie / localStorage / 请求头三路抓取，1.5s 节流轮询（HttpOnly cookie 拿不到 DOM 事件，只能轮询）→ 命中渠道规则即关窗并落库。以 `oauth` + `url:""` 形态接入（宿主后台直接调 callback，不开页面、不弹输入框），与 inkstone 的客户端导入同款。zai-web 端到端实跑通过（抓到 278 字符令牌，`/api/models` 返回 200）。

**顺带修的既有问题**：`agnes` 的 429 —— 该账号 37 次请求里 34 次被上游 429（未实名账户 RPM 低），插件原样透传错误体，用户看到的就是「回答中断、很乱」。loader 加 429/503 退避重试（2s/3s/5s，ChatLink 对 z.ai 同款）。`qoder` 排队码 10605 同样按 `retryAfterSeconds` 自动重试（最多 2 次，单次封顶 60s）。

**终态**：25 个 provider 全部装载，7 个新渠道用真实账号联网测通（qoder-cn ✓ / trae-cn ✓ / trae-global ✓ / workbuddy ✓ / workbuddy-ai ✓ / autoclaw ✓；qoder 国际版受上游排队限制，重试机制已就位）；164/164 单测全绿；git 检查点 `1ddbb51`。
