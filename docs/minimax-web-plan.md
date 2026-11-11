# 新 magpie 插件方案：MiniMax 网页会话渠道（minimax-web）

> 日期：2026-11-11。状态：研究完成，方案待用户确认。
> 依据：用户指定「写一个新的 magpie 插件，F:/maple/agent-hud-open 为参考研究对象，方案由我制定」。

## 1. 结论

给 magpie-nest 新增第 26 个渠道插件 **minimax-web**：登录 MiniMax 网页版
（中国版 minimax.cn / 国际版 minimax.io），把网页会话变成 magpie 的 provider；
并复用 agent-hud-open 里 MiniMax 模块的协议知识，向 magpie 上报套餐额度窗口。

一句话：**agent-hud-open 提供「额度与区域协议」，magpie-plugin-pack 提供「渠道形态与逆向工程经验」，
二者拼成一个新渠道。**

## 2. 为什么是 MiniMax（覆盖核查）

agent-hud-open 里带协议知识的厂商，几乎都被 magpie 本体或社区插件覆盖了：

| 厂商 | agent-hud 模块 | magpie 现状 | 结论 |
| --- | --- | --- | --- |
| Factory | agents/src/droid | 社区插件 opencode-factory-auth（accounts_cli.go:591 「Factory runs on its plugin now」） | 跳过 |
| Grok | agents/src/grok | 内置 grok.go（cli-chat-proxy.grok.com，CLI sign-in） | 跳过 |
| Cursor | agents/src/cursor | 社区插件 opencode-cursor-auth | 跳过 |
| Zed | agents/src/zcode | 社区插件 opencode-zed-auth | 跳过 |
| Nous Portal | agents/src/hermes | magpie 内置预设 | 跳过 |
| Volcengine Ark | agents/src/ark | 内置预设 + /v1/magpie/native 原生路由 | 跳过 |
| MiniMax 官方 API / 编码套餐 key | agents/src/minimax | 内置预设 + planquota.go 已读 token_plan/remains（sk-cp- key） | 跳过 |
| **MiniMax 网页会话** | agents/src/minimax（额度/区域部分） | **无** | **选它** |

pack 自有 25 渠道里没有 MiniMax 自有渠道（loomy/lobsterai 只是聚合渠道列了 MiniMax-M3 模型，
不是 MiniMax 账号体系）。同时 MiniMax 是中国 web AI 阵营里唯一缺失的大厂
（智谱/通义/Kimi/豆包都已在 pack），且同时有中国版与国际版，符合 nest 的双版本惯例
（qwen/qwen-ai、glm/zai-web、trae-cn/trae-global 先例）。

## 3. agent-hud-open 贡献的协议事实（直接复用）

来源：F:/maple/agent-hud-open/src/crates/agents/src/minimax/

1. 区域双平台（routes.rs Region）：Global = minimax.io；China = minimax.cn（原 minimaxi.com）。
2. key 形态（routes.rs usable()）：套餐 key 前缀 sk-cp-，按量 API key 前缀 sk-api-（套餐读取排除 sk-api-）。
3. 额度端点及顺序（account.rs endpoints()）：
   - China：GET https://www.minimax.cn/v1/token_plan/remains，
     旧 Coding Plan key 走 https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains；
   - Global：GET https://www.minimax.io/v1/token_plan/remains，
     旧 Coding Plan key 走 https://api.minimax.io/v1/api/openplatform/coding_plan/remains。
4. 字段语义（account.rs + remains.rs）：usage_count 是「剩余」不是已用；model_remains 每模型族给 5 小时/周窗口。
5. 模型族命名（remains.rs service()）：文本（general / minimax-m* / m2.*）、视频、语音、图生视频、
   文生视频、图像、音乐。
6. 外部佐证：CodexBar 的 MiniMax reader（MIT, 897bff3），端点行为已在其实现中验证。

注意：agent-hud 不给 MiniMax 的网页聊天端点（它只读额度），聊天协议要在开发第一步抓包确认。

## 4. 交付物与文件布局（全部在 magpie-plugin-pack 内）

plugins/magpie-nest/lib/minimax-web/
  README.md        渠道说明、登录方式、模型表、额度说明
  constants.mjs    ID/NAME/NPM/API_BASE/模型行（照 nest 惯例 stripModel）
  login.mjs        web 登录（复用 weblogin；China/Global 区域自选）
  sign.mjs         网页请求签名（若与 glm/qwen 同构则仿写）
  stream.mjs       SSE 状态机 → OpenAI chunks（仿 glm/stream.mjs，reasoning/content 分列）
  token.mjs        refresh token 交换（若网页版用 refresh token）
  usage.mjs        移植 agent-hud 的 token_plan/remains 解析 → auth.usage 形状
  index.mjs        export const MiniMaxWebPlugin = async () => ({ auth, provider })
plugins/magpie-nest/index.mjs   加一行 export
plugins/magpie-nest/test/minimax-web.test.mjs   装载 + flatten + usage 窗口解析测试

## 5. 插件设计

### auth 钩子
- provider id：minimax-web（避开 magpie 内置 minimax）。
- methods：web 登录（浏览器窗口，复用 nest 现有 weblogin 组件），登录后持有网页会话凭证。
- 区域：China（minimax.cn）与 Global（minimax.io）是两个独立账号体系，互不代替。
  先做 China 版；若两区协议差异大，拆 minimax-web / minimax-web-global 两个 id（qwen/qwen-ai 先例）。
- auth.usage：用会话凭证调额度端点，返回 nest 形状
  { plan, user, balance, windows, until, error, signIn }，仿 lib/inkstone/usage.mjs。

### provider 钩子
- 把 OpenAI chat.completions 请求翻译成 MiniMax 网页会话请求（单条扁平消息，仿 lib/glm/index.mjs flatten），
  SSE 流回投成 OpenAI chunks（reasoning/content 分列，仿 glm project）。
- 模型表以网页版实际可选模型为准（MiniMax-M2.x / M3、Agent 系列）；constants.mjs 里处理前缀剥离。

### usage（额度窗口，直接移植 agent-hud）
- 按区域调 token_plan/remains（旧 key 回退 coding_plan/remains），解析 model_remains：
  usage_count=剩余、5h/周窗口、模型族名（文本/视频/语音/图像/音乐）。
- 转 magpie 窗口形状：amount=已用=limit-usage_count，limit=总配额；无上限窗口 aside:true
  （不让路由误判 100% 用尽，见 inkstone/usage.mjs 注释）。
- 401/过期：signIn:"expired"；文案避免「重新登录」字样（magpie 会当登录失效标记账号）。

## 6. 实施步骤（PDCA）

1. 协议侦察：抓包 minimax.cn 网页登录与聊天请求，确认端点、签名、SSE 事件形状、模型 id。
2. constants + login + token：照 nest 惯例实现登录与模型表。
3. provider 流：实现 flatten + 签名 + SSE 投影；单轮/多轮/reasoning 自测通过。
4. usage 移植：按第 3 节端点实现额度读取与窗口解析，单测覆盖 remains 样例。
5. 集成验证：入口加 export，跑 pack-install 测试；magpie plugin add 本地路径 → login →
   provider test 真实回话 → Usage 页核对窗口数值与网页端一致。

## 7. 验收标准

1. test/pack-install.test.mjs 与新增 minimax-web.test.mjs 全绿（装载、模型剥离、flatten、usage 窗口）。
2. magpie plugin login minimax-web 能完成网页登录并保持会话。
3. magpie provider test minimax-web 真实流式回话通过，多轮与 reasoning 正常。
4. magpie Usage 页显示 MiniMax 套餐 5h/周额度窗口，数值与网页端一致。
5. 登录失效时 usage 返回 signIn:"expired"，账号被正确标记而非反复报错。

## 8. 风险、假设与备选

- 假设 1：MiniMax 网页聊天协议可逆向且与现有渠道（glm/qwen 一类）同构；第一步抓包验证，
  不成立则本方案退回重选。
- 假设 2：网页端允许以第三方客户端形态长期持会话（refresh token 可换）；若只有短效会话，
  登录体验与失效频率需要评估。
- 风险 1：国际版 minimax.io 可能无中文网页聊天或需境外账号；先做 China 版，国际版按需追加。
- 备选 B：Grok 网页会话（grok.com）。magpie 内置 Grok 走 CLI sign-in，网页渠道理论上仍有空间，
  但 agent-hud 只给 CLI 的 billing/settings 端点，参考价值低于 MiniMax。
- 不做：MiniMax 套餐 key（sk-cp-）直连官方 API——magpie 内置 minimax + planquota.go 已覆盖，做了是冗余。
