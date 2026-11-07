/** 端砚/Discovery 各端地址与常量。 */
export const PROVIDER = "inkstone";
export const PROVIDER_NAME = "书生·端砚";

/** Orbit Agent 网关（自定义 SSE 协议）。 */
export const ORBIT_BASE = "https://discovery.intern-ai.org.cn/api/orbit/v1";
/** TokenPlan 管理面（墨点、Key 签发、模型清单；Bearer JWT + Cookie uaa-token）。 */
export const TOKENPLAN_BASE = "https://discovery.intern-ai.org.cn/api/tokenplan/v1";
/** TokenPlan OpenAI 兼容推理端点（Bearer API Key）。 */
export const API_BASE = "https://discovery-api.intern-ai.org.cn/v1";
/** 用户中心（SSO 换票、读用户）。 */
export const AUTH_BASE = "https://discovery.intern-ai.org.cn/api/user-center/v1";

export const SSO_ORIGIN = "https://sso.openxlab.org.cn";
export const SSO_CLIENT_ID = "dagw07mkg1bazlxzoy31";
export const SSO_REDIRECT = "https://discovery.intern-ai.org.cn/";
export const SSO_SOURCE = "discovery";

export const CLIENT_VERSION = "magpie-inkstone/0.1.0";
export const KEY_NAME = "magpie-inkstone";
