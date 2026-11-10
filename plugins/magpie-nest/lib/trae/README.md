# TRAE 双版本渠道（鹊巢 magpie-nest）

ByteDance AI IDE「Trae」的两个 provider，id 与 magpie 宿主已有 id 一致：

| id | 名称 | 站点 | 聊天 API 域 |
| --- | --- | --- | --- |
| `trae-cn` | Trae CN | https://www.trae.cn | https://trae-api-cn.mchost.guru |
| `trae-global` | Trae Global | https://www.trae.ai | https://coresg-normal.trae.ai（SG，默认）/ https://coreva-normal.trae.ai（US） |

## 协议事实（非 OpenAI 兼容）

TRAE 的 agent 端点 `/api/agent/v3/llm_utils_chat` **两个方向都不是 OpenAI 形状**，
因此 loader 里完整实现了「OpenAI 请求 → SOLO 请求 → SOLO SSE → OpenAI SSE」的转换，
不能只做转发。

出处：

- ChatLink `F:/maple/ChatLink/src/main/providers/builtin/trae.ts:6-20`（SOLO、SSE-only、uid 必需、channel 逃生舱）
- ChatLink `F:/maple/ChatLink/src/main/proxy/adapters/trae.ts:117-228`（请求改写）、`:230-247`（SSE 投影）、`:360-469`（流式/非流式）
- 社区实现 `C:/Users/Administrator/.config/magpie/plugins/node_modules/@magpie-community/opencode-trae-auth/index.mjs:34-88`（CN 域名/模型）、`:153-199`（Global 域名/模型）、`:765-780`（请求头）、`:1484-1534`（chatBody）、`:1584-1620`（SSE 解析）

### 请求改写（OpenAI → SOLO，`constants.mjs` 的 `toSoloBody`）

- `messages[].content` 若是字符串，改写成 parts 数组：`[{ type: "text", text }]`
- assistant `tool_calls[].function` 改名为 `function_call`
- `tools[].function.parameters` 必须是 JSON **字符串**（不是对象）
- `tool_choice` 没有对象形态：`none` 直接删掉 tools；`{type:"function"}` 压成函数名
- 模型骑在两个字段上：`model` + `config_name`（都取 `__` 后缀之前的 base id）
- 追加 `function`（路由 channel）、`request_id`、`session_id`；`stream: true` 恒为真
- 只转发调用方实际设置了的采样字段，避免 SOLO 对 null 值报错

### 响应投影（SOLO SSE → OpenAI SSE，`index.mjs`）

上游是 `event: output|done|error|token_usage` 帧，不是 `chat.completion.chunk`：

- `output`：`response` → `delta.content`，`reasoning_content` → `delta.reasoning_content`，`tool_calls` 做 `function_call → function` 归一化（去 `namespace` / `partial_arguments`）
- `token_usage`：记下 usage，附到收尾 chunk 上
- `done`：`finish_reason` 在这里到达，收尾 chunk 从它发出，之后 `data: [DONE]`
- `error`：流内错误（如 channel 不对时的 4001），投影成 OpenAI `error` 帧 + `[DONE]`
- 流意外结束而没收到 `done` 时也补一个收尾 chunk，否则客户端会挂起
- 非流式调用方：把流排干（drain）后拼成单个 `chat.completion`（保留 `reasoning_content`）

## 鉴权方式

登录方式为 `type:"api"` 粘贴：主框粘贴 IDE 令牌（Cloud-IDE-JWT），随后填写设备身份字段。
**目前没有接浏览器一键登录**：社区插件已实现可自动化的 OAuth 流程
（`@magpie-community/opencode-trae-auth` 的 `browserSignIn`，`index.mjs:3834`，授权页回调
127.0.0.1 拿 JWT + refresh token），但移植它需要本地回调服务器与设备密钥交换（该文件 3843 行），
超出本目录范围，留作后续。

### 凭证从哪里取（IDE DevTools）

1. 登录 Trae IDE（CN 或国际版），打开开发者工具（帮助 → Toggle Developer Tools）
2. 随便发一句对话，在 Network 里找到 `llm_utils_chat` 请求
3. 从**请求头**复制：
   - 令牌：`Authorization: Cloud-IDE-JWT …` 里 `Cloud-IDE-JWT ` 之后的部分（粘主框）
   - `X-Uid`（必填）
   - `X-Machine-Id`、`X-Device-Id`（可选但建议填）

### 必需头（`constants.mjs` 的 `clientHeaders`）

- `Authorization: Cloud-IDE-JWT <token>`、`X-Cloudide-Token: <token>`、`X-Ide-Token: <token>` ——
  令牌要同时发在四处，网关独立校验（ChatLink `adapters/trae.ts:286-319`）
- `X-Uid` —— **缺 uid 直接被拒**（ChatLink `providers/builtin/trae.ts:11-14`）
- `X-Machine-Id` / `X-Device-Id` —— 设备身份，新设备缺 machineId 时网关更严格
- `X-App-Id`（`6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`）、`X-Ide-Version` 家族、`X-Device-*` 家族

## 两版差异与坑

| 项 | trae-cn | trae-global |
| --- | --- | --- |
| 模型主机 | `trae-api-cn.mchost.guru` | `coresg-normal.trae.ai`（SG）/ `coreva-normal.trae.ai`（US） |
| 鉴权/账号域 | `api.trae.cn`、`api.trae.com.cn` | `grow*-normal.trae.ai` |
| 用量域 | `api.trae.cn`（credits） | `api-sg-central.trae.ai` / `api-us-east.trae.ai`（美元 entitlement） |
| 默认模型 | glm-5.2 / glm-5 / kimi-k2.6 / qwen-3.7-plus / DeepSeek-V4-Pro / DeepSeek-V4-Flash | gpt-5.4 / gemini-3-flash / kimi-k2.5 / minimax-m2 / deepseek-v3.2 |
| 模型列表 | 整表下发 | 隐藏 `is_invisible_to_user` 的 Auto/付费通道（社区 `index.mjs:158-160`） |

- **channel（`function`）是逃生舱**：模型只有在某个 channel 里列出才能被调用，映射表在远端，
  无法离线得知。默认 `solo_agent` 覆盖面最广；若某模型在流内回 4001，在登录时的
  channel 字段换 `solo_work_lite` / `solo_agent_lite` / `solo_coder` 试（ChatLink
  `providers/builtin/trae.ts:16-20`）。
- **未知模型必须 404**：网关对未知 id 会静默换一个模型回答，loader 里先校验
  `modelRows()` 并拒绝，这是唯一诚实的做法（同 zai 的处理）。
- **非 2xx 响应**：上游响应体原样返回，带 `x-magpie-sign-in` 头（401 时为 `expired`，
  其余为 `kept`）；无刷新令牌可换，401 就是令牌作废。
- **US 账户**（trae-global）：默认走 SG 主机 `coresg-normal.trae.ai`，US 账户在登录时把
  API 域覆盖填成 `https://coreva-normal.trae.ai`。
- **deviceId/machineId 要稳定**：中继项目观察到设备身份每次变会被网关丢请求
  （社区 `index.mjs` 的 device 注释），所以粘贴一次后别反复重新登录。

## 模型 id

`stripModel(providerId, value)` 去掉 `"trae-cn/"` / `"trae-global/"` 前缀；
`modelRows(regionId)` 返回该渠道的模型行。
