// 账号真实模型目录：TRAE 的模型只能通过「列了它的 function」调用，且每个
// function 的 config_info_list 才是这台账号能用的 config_name。静态表猜不中，
// 猜错上游只回一句 "the param is invalid"（实测 trae-cn）。
//
// 端点与报文照社区实现 index.mjs:3455-3470（batch_get_detail_param）。

import { FUNCTIONS, clientHeaders } from "./constants.mjs";

const TTL_MS = 10 * 60 * 1000;
const CACHE = new Map();

function keyOf(regionId, base, creds) {
  return [regionId, base, creds?.uid ?? "", creds?.machineId ?? ""].join("|");
}

function labelOf(m) {
  const raw = m?.display_config?.display_name || m?.display_name || m?.display_model_name || m?.config_name;
  return String(raw ?? "");
}

/**
 * 拉账号的 (function, config_name) 目录。
 * 返回 [{ function, configName, name }]；账号没目录时返回 null。
 */
export async function fetchCatalog(region, base, token, creds, { signal, force = false } = {}) {
  const key = keyOf(region.id, base, creds);
  const hit = CACHE.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const res = await fetch(base + "/api/ide/v1/batch_get_detail_param", {
    method: "POST",
    headers: clientHeaders(region, token, creds),
    body: JSON.stringify({
      functions: FUNCTIONS,
      agent_type: "",
      current_config_info: { config_name: "", is_custom_model: false },
      mode_type: 0,
      access_type: 0,
      ab_force_vids: "",
      ab_autotest_advanced_mode: 0,
      show_custom_model: true,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(region.name + " 目录：" + res.status + " " + text.slice(0, 120)), {
      status: res.status,
    });
  }
  const json = await res.json().catch(() => null);
  const groups = json?.function_configs ?? json?.data?.function_configs;
  if (!Array.isArray(groups)) return null;

  const out = [];
  for (const g of groups) {
    const fn = String(g?.function ?? "");
    if (!FUNCTIONS.includes(fn)) continue;
    for (const m of Array.isArray(g?.config_info_list) ? g.config_info_list : []) {
      const configName = String(m?.config_name ?? "");
      if (!configName) continue;
      out.push({ function: fn, configName, name: labelOf(m) || configName });
    }
  }
  const value = out.length ? out : null;
  CACHE.set(key, { at: Date.now(), value });
  return value;
}

/** 把 magpie 给的模型名对上目录项：先 config_name，再展示名，最后宽松包含。 */
export function pairFor(catalog, model) {
  if (!Array.isArray(catalog) || !model) return null;
  const raw = String(model);
  const bare = raw.includes("__") ? raw.split("__")[0] : raw;
  return (
    catalog.find((p) => p.configName === bare) ??
    catalog.find((p) => p.name === raw) ??
    catalog.find((p) => p.configName.toLowerCase() === bare.toLowerCase()) ??
    null
  );
}

export function clearCatalogCache() {
  CACHE.clear();
}
