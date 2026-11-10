# Qoder 双版本渠道（qoder / qoder-cn）

鹊巢 magpie-nest 的 Qoder 插件：一个目录、两个 provider。账号体系互相独立，
协议同形、host 与 client_id 不同。

## 两版差异

| | qoder（国际版） | qoder-cn（中国版） |
|---|---|---|
| provider id | `qoder` | `qoder-cn` |
| 授权页 authBase | https://qoder.com | https://qoder.cn |
| 账号/轮询/userinfo openApi | https://openapi.qoder.sh | https://openapi.qoder.com.cn |
| 推理网关 api | https://api3.qoder.sh | https://gateway.qoder.com.cn |
| client_id | e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb | 732aef47-9cf2-46a2-95fe-4cebb5d0d1fa |
| 设备码换 job token | 必须（POST /api/v1/me/jobToken） | 先试 job token，4xx 退回设备 token 直接聊天 |

出处：ChatLink oauth/adapters/qoder.ts:40-62（region 常量）、
dsh-our-free-model qoder-product.ts:446,609（CN asar 实测佐证 client_id 归属）、
社区 index.mjs:3050-3077（host 与 deviceChat 语义）。

## 登录

第一项为设备码 OAuth（自动化），第二项为 PAT 兑换；两者都落成
{type:success, access, refresh, expires, accountId, uid, machineId, ...}。

1. **设备码流**（推荐）：PKCE verifier/challenge（43..128 字符，challenge 去 padding）
   → 打开 {authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id
   → 每 2 秒轮询 GET {openApi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
   → 200 拿 {token, refresh_token, expires_at} →（国际版）POST {openApi}/api/v1/me/jobToken {clientId}
   换 job token → GET {openApi}/api/v1/userinfo 取真实用户名/uid。
   出处：ChatLink qoder.ts:6-26, 89-102；社区 index.mjs:639-731。
2. **PAT**：从 {authBase}/account/integrations 创建，POST {openApi}/api/v1/jobToken/exchange {personal_token}
   换 job token；PAT 长至一年，job refresh 失效时用 PAT 重新兑换。
   出处：社区 README.md:32-55、index.mjs:743-785。

## 推理协议（不是 OpenAI 兼容）

- 请求目标：{api}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
  （社区 index.mjs:45）。
- 请求体：Chat Completions → Qoder agent_chat_generation 明文 JSON → 自定义 base64
  （字母表 + '$' 补齐）→ swapThirds 置换 → 作为 POST body（社区 index.mjs:180-217）。
- 必需头（COSY 信封，社区 index.mjs:121-173）：
  Authorization: Bearer COSY.<payload>.<md5sig>、Cosy-Key、Cosy-Date、
  Cosy-MachineId、Cosy-MachineOS、Cosy-User、Cosy-Version: 1.1.69、
  Cosy-Business-Product: app、Cosy-ClientType: 10、Login-Version: v2；
  chat 端点额外带 X-Model-Key / X-Model-Source / Cosy-MachineHostname。
  账号 blob AES-128-CBC（key 即 IV），key 用 Qoder 内嵌 RSA 公钥包装。
- 响应：SSE 每行 data: {body: <OpenAI chunk json>, statusCodeValue: 200}，
  插件把 body 里的 chunk 翻回 OpenAI Chat Completions（流式/非流式都支持）；
  工具调用写在文本里的 <tool_call> JSON 或 <function=…> / <invoke …> XML
  会被 lift 成 tool_calls（社区 index.mjs:1907-2417）。
- 模型名用目录 key（qfmodel / dmodel…），不是展示名（ChatLink
  providers/builtin/qoder.ts:14-18）。

## 坑（实测，不要顺手改）

1. **轮询必须挂 openApi**（openapi.qoder.sh / openapi.qoder.com.cn），不是 authBase；
   qoder.com 同路径回 401（ChatLink qoder.ts:16-17）。
2. **client_id 分 region 且两版不同**：写错症状是「授权页 302 正常、点授权后报参数无效」
   （ChatLink qoder.ts:18-19）。⚠️ 社区插件 index.mjs:3050-3067 的 SITES 表把两个
   client_id 写反了；本实现按 ChatLink + CN asar 实测归属（见上表）。
3. **真实用户名只能来自 /api/v1/userinfo**：设备码响应没有 user_name，
   拿不到时退回账号 id，绝不用假名（ChatLink qoder.ts:20-22）。
4. **未知模型必须本地拒绝**：网关对未知 key 静默换成别的模型，不回错
   （ChatLink providers/builtin/qoder.ts:17-18；本插件 loader 抛 404）。
5. **job/device refresh token 一次性**：续期并发会花掉两次，本插件由 magpie 的
   auth.refresh 串行调用（社区 README.md:61-63）。
6. **qoder-cn 换不到 job token 是正常路径**：CN CLI 用设备 token 直接聊天，
   本插件按社区 index.mjs:672-677 退回设备 token 通道。

## 本实现边界（相对社区完整实现的取舍）

- 未实现：VPC / 企业专属域 / Lingma 1.0 专属域登录、用量与每日签到、
  10605 队列等待（busy 时按上游原样透传 503/错误体）、动态模型目录拉取
  （登录后静态表不再刷新；未登录时可用，登录后模型列表以静态表为准）。
- 上游非 2xx：响应体原样透传并补 x-magpie-sign-in（401/403 标 kept，
  明确过期标 expired）；Qoder 的错误码语义见社区 README 错误表。
- 静态模型表：国际版 17 行（社区 index.mjs:818-836）、中国版 4 档
  （社区 index.mjs:841-844，Ultimate/Performance/Efficient/Lite）。
