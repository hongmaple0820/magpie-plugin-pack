/**
 * 书生·端砚 云端 Orbit 网关客户端（Agent 通道）。
 * Base: https://discovery.intern-ai.org.cn/api/orbit/v1
 * 鉴权: Authorization: Bearer <jwt> + id: <ssoUid>
 *
 * 三个动作：拉模型清单、开聊天（拿 chatId）、开 SSE 消息流。
 * 协议 2.0 请求体与事件流的翻译在 lib/bridge.mjs。
 */
import { ORBIT_BASE, CLIENT_VERSION } from "./constants.mjs";
import { orbitHeaders, readEnvelope, jsonRequest, UpstreamError } from "./http.mjs";

export { CLIENT_VERSION };

/** 拉取模型能力清单（data.models）。 */
export async function listModels(jwt, uid, { signal } = {}) {
  const data = await jsonRequest(`${ORBIT_BASE}/local-agent/models`, {
    headers: { ...orbitHeaders(jwt, uid, { Accept: "application/json" }) },
    signal,
  });
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .map((model) => ({
      id: String(model?.id ?? ""),
      canonicalId: String(model?.canonical_id || model?.id || ""),
      name: String(model?.display_name || model?.id || ""),
      contextWindow: Number(model?.context_window) || 128000,
      maxOutput: Number(model?.max_output_tokens) || 8192,
      supportsThinking: model?.supports_thinking === true,
      pro: model?.pro === true,
    }))
    .filter((row) => {
      if (!row.id) return false;
      const id = row.id.toLowerCase();
      const canonical = row.canonicalId.toLowerCase();
      return (
        id !== "auto" &&
        canonical !== "auto" &&
        id !== "default" &&
        canonical !== "default" &&
        canonical !== "local-default"
      );
    });
}

/** 新建会话，返回 chatId。detached 推理每轮都要开一个。 */
export async function newChat(jwt, uid, { signal } = {}) {
  const data = await jsonRequest(`${ORBIT_BASE}/chat/new`, {
    method: "POST",
    headers: { ...orbitHeaders(jwt, uid, { Accept: "application/json", "Content-Type": "application/json" }) },
    body: JSON.stringify({ scenario: 2, type: 0, provider: 0, agent: "local_agent" }),
    signal,
  });
  if (typeof data?.id !== "number" || data.id <= 0) {
    throw new UpstreamError("端砚 /chat/new 返回了无效的会话 id", { code: "CHAT_INVALID" });
  }
  return data.id;
}

/** POST /local-agent/messages，成功时返回 SSE Response；失败抛 UpstreamError。 */
export async function openMessages(jwt, uid, body, { signal } = {}) {
  const response = await fetch(`${ORBIT_BASE}/local-agent/messages`, {
    method: "POST",
    headers: {
      ...orbitHeaders(jwt, uid, { Accept: "text/event-stream", "Content-Type": "application/json" }),
      "X-Client-Version": CLIENT_VERSION,
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(6 * 60 * 1000),
    cache: "no-store",
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (response.ok && response.body && contentType.includes("text/event-stream")) return response;
  await readEnvelope(response);
  throw new UpstreamError(`端砚推理 HTTP ${response.status}`, { status: response.status, retryable: response.status >= 500 });
}
