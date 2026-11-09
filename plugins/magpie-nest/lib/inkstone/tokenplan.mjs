/**
 * TokenPlan 管理面：墨点余额、套餐、API Key 签发、模型清单。
 * 全部走 JWT（Bearer + Cookie uaa-token，见 http.authHeaders）。
 * 完整 API Key 只在创建响应里出现一次，调用方必须立刻落库、禁止打日志。
 */
import { TOKENPLAN_BASE, KEY_NAME } from "./constants.mjs";
import { authHeaders, jsonRequest, UpstreamError } from "./http.mjs";

/** 随机幂等键；不依赖 node: 模块。 */
function newIdem() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `inkstone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

async function request(jwt, path, { method = "GET", body, extraHeaders, signal } = {}) {
  return jsonRequest(`${TOKENPLAN_BASE}${path}`, {
    method,
    headers: { ...authHeaders(jwt, extraHeaders), ...(body ? { "Content-Type": "application/json" } : {}) },
    body,
    signal,
  });
}

export async function getBalance(jwt, { signal } = {}) {
  return request(jwt, "/credits/balance", { signal });
}

export async function listPackages(jwt, { signal } = {}) {
  return request(jwt, "/credits/packages", { signal });
}

/** 列出账号的 API Key（厂商只回 masked_key，永不回显完整值）。 */
export async function listKeys(jwt, { signal } = {}) {
  const data = await request(jwt, "/keys", { signal });
  // 实测信封：data.items[]，每项 {id,name,masked_key,status,created_at,last_used_at}
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  return { items };
}

/** 删除一个 API Key（重新登录时用来给新 key 腾名额/拿回完整值）。 */
export async function deleteKey(jwt, keyId, { signal } = {}) {
  if (!keyId) return false;
  try {
    await request(jwt, `/keys/${encodeURIComponent(keyId)}`, { method: "DELETE", signal });
    return true;
  } catch {
    return false;
  }
}

export async function listApiModels(jwt, { signal } = {}) {
  return request(jwt, "/models?page=1&page_size=50", { signal });
}

export async function createKey(jwt, { name = KEY_NAME, idempotencyKey, signal } = {}) {
  const idem = String(idempotencyKey || newIdem());
  const data = await request(jwt, "/keys", {
    method: "POST",
    body: JSON.stringify({ name }),
    extraHeaders: { "Idempotency-Key": idem },
    signal,
  });
  const key = typeof data?.key === "string" ? data.key.trim() : "";
  if (!key) {
    throw new UpstreamError("创建 API Key 成功但未返回完整密钥", { code: "-15108" });
  }
  return {
    id: typeof data.id === "string" ? data.id : "",
    name: typeof data.name === "string" ? data.name : name,
    key,
    idempotencyKey: idem,
  };
}

/**
 * 保证账号手里有可用的 TokenPlan API Key。
 *
 * 完整 key 只在创建响应里出现一次，厂商对重复 Idempotency-Key 的重放
 * 只回 masked_key（"API Key cannot be viewed again"），所以：
 *   - 幂等键永远用新的随机值（不用稳定派生值，重放只会拿到不可见的 key）；
 *   - 创建失败时，先按名字/旧 keyId 找到插件名下的旧 key 删掉，再建新的——
 *     这样重新登录总能拿回完整 key，也不会累积占名额（每账号上限 10 个）。
 * 不会抛错：签发失败时把原因写进 error，Orbit 通道只认 JWT，仍然能用。
 */
export async function ensureApiKey(jwt, { existingApiKey = "", existingKeyId = "", signal } = {}) {
  if (String(existingApiKey ?? "").trim()) {
    return {
      apiKey: String(existingApiKey).trim(),
      apiKeyId: String(existingKeyId ?? ""),
      apiKeyName: KEY_NAME,
      apiKeyIdempotency: "",
      error: "",
    };
  }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const idem = newIdem();
    try {
      const created = await createKey(jwt, { idempotencyKey: idem, signal });
      return {
        apiKey: created.key,
        apiKeyId: created.id,
        apiKeyName: created.name,
        apiKeyIdempotency: created.idempotencyKey,
        error: "",
      };
    } catch (error) {
      lastError = error;
      // 撞上已有 key（幂等重放 / 同名限制）：删掉插件名下的旧 key 再试一次。
      const removed = await removeOwnKey(jwt, { existingKeyId, signal });
      if (removed && attempt === 0) continue;
      break;
    }
  }
  const code = String(lastError?.code || "");
  const message =
    code === "-15110"
      ? "该账号 API Key 已达 10 个上限，请到 Token Plan 页删除一个后刷新用量"
      : lastError?.message || "签发 API Key 失败";
  return {
    apiKey: "",
    apiKeyId: "",
    apiKeyName: "",
    apiKeyIdempotency: "",
    error: message,
  };
}

/**
 * 删掉插件名下（name === KEY_NAME，或就是之前的 apiKeyId）的 key。
 * 只在重新签发时用：完整值不可见，删旧建新是唯一能拿回可用 key 的路。
 */
async function removeOwnKey(jwt, { existingKeyId = "", signal } = {}) {
  let items = [];
  try {
    const listed = await listKeys(jwt, { signal });
    items = listed.items;
  } catch {
    return false;
  }
  const matches = items.filter((item) => item && (
    (existingKeyId && item.id === existingKeyId) || item.name === KEY_NAME
  ));
  let removed = false;
  for (const item of matches) {
    if (await deleteKey(jwt, item.id, { signal })) removed = true;
  }
  return removed;
}

function numberOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function windowOf(windows, key) {
  const row = windows?.[key] && typeof windows[key] === "object" ? windows[key] : {};
  return {
    remain: numberOf(row.remaining_credits),
    limit: numberOf(row.limit_credits),
    recover: String(row.next_recover_at ?? ""),
  };
}

/** 余额 + 套餐 → 面板/用量展示用的快照（与 DSH 插件 store.js 保持同构）。 */
export function snapshotOf(balance, packages) {
  const windows = balance?.usage_windows && typeof balance.usage_windows === "object" ? balance.usage_windows : {};
  const pkg = Array.isArray(packages?.packages) ? packages.packages[0] : null;
  const win5h = windowOf(windows, "5h");
  const win7d = windowOf(windows, "7d");
  return {
    availableCredits: numberOf(balance?.available_credits),
    rpmLimit: numberOf(balance?.rpm_limit),
    tpmLimit: numberOf(balance?.tpm_limit),
    decisionRpmLimit: numberOf(balance?.decision_rpm_limit),
    remain5h: win5h.remain,
    limit5h: win5h.limit,
    recover5h: win5h.recover,
    remain7d: win7d.remain,
    limit7d: win7d.limit,
    recover7d: win7d.recover,
    packageEndAt: String(pkg?.current_cycle?.end_at ?? ""),
    packageRemark: String(pkg?.remark ?? ""),
    calculatedAt: String(balance?.calculated_at ?? ""),
    accessStatus: Number(balance?.access_status) || 0,
    error: "",
  };
}

/** TokenPlan 模型清单 → 插件模型条目；只保留支持 openai_chat 的。 */
export function mapApiModels(data) {
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.flatMap((model) => {
    const id = String(model?.id ?? "").trim();
    if (!id) return [];
    const protocols = Array.isArray(model.supported_protocols) ? model.supported_protocols : [];
    if (!protocols.includes("openai_chat")) return [];
    const capabilities = [
      ...(Array.isArray(model.capabilities) ? model.capabilities : []),
      ...(Array.isArray(model.capabilities_en) ? model.capabilities_en : []),
    ].map(String);
    const inputs = Array.isArray(model.input_types) ? model.input_types.map(String) : ["text"];
    const inputPrice = numberOf(model.input_uncached_price);
    const outputPrice = numberOf(model.output_price);
    return [{
      id,
      name: String(model.display_name || id),
      contextWindow: Number(model.context_length) || 128000,
      maxOutput: 8192,
      supportsThinking: capabilities.some((item) => item.includes("深度思考") || /reasoning/i.test(item)),
      supportsTools: capabilities.some((item) => item.includes("工具调用") || /tool/i.test(item)),
      inputModalities: inputs.includes("image") ? ["text", "image"] : ["text"],
      // 按厂商标价：两项都是 0 才算免费（墨点计价，不是美元）。
      free: inputPrice === 0 && outputPrice === 0,
      inputPrice,
      outputPrice,
    }];
  });
}

export { UpstreamError };
