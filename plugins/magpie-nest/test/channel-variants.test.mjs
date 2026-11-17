// 跨渠道不变量：模型行的 `variants` 必须是「键=梯队档位词」的普通对象。
//
// 规则出处（magpie）：
//   - F:\maple\magpie\internal\plugin\host.js:2357  `variants: Object.keys(m.variants ?? {}),`
//     —— 插件 config 里的 variants **只取键**，值整块丢弃；键就是模型的思考档位名。
//   - F:\maple\magpie\internal\agent\agents.go:969 `modelEffort(efforts, level)`
//     —— 只认梯队词（+ EffortAliases light→low / extra_high→xhigh），别的键永远匹配不上。
//   - F:\maple\magpie\internal\agent\dsh.go:1935 `dshModelLevels`
//     —— 命中 0 个、或只命中 off 一个，就返回 nil：DSH 里该模型一个档位都没有。
//   - host.js:2343 `reasoning: !!m.capabilities?.reasoning` —— reasoning 是能力位，
//     与档位无关：模型可以「会思考但没有可选档位」（如 deepseek-reasoner、glm）。
//
// 历史事故（本测试就是为了钉住它们）：
//   - cline 用显示名当键（None/Low/Medium/High/Extra）→ 全部模型没档位；
//   - minimax M3 用 on/none 当键 → on 被丢，只剩 off → dshModelLevels 返回 nil；
//   - minimax M3.1 把远端的 default 当键 → 被丢（无实质影响，但说明别透传私有词）；
//   - workbuddy / workbuddy-ai 直接传字符串数组 → Object.keys 得 ["0","1","2"] → 全没档位。

import { test } from "node:test";
import assert from "node:assert/strict";

import * as nest from "../index.mjs";

/** magpie 认得的档位词（catalog.EffortRank 的键 + JSON 别名）。 */
const LADDER = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "light", "extra_high"]);

/** 收集所有渠道 config 里的模型行：{ 渠道 id: { 模型 id: row } }。 */
async function collectModels() {
  const out = {};
  for (const [name, factory] of Object.entries(nest)) {
    if (typeof factory !== "function") continue;
    const hooks = await factory();
    if (!hooks?.provider || typeof hooks.config !== "function") continue;
    const cfg = { provider: {} };
    await hooks.config(cfg);
    const id = hooks.provider.id;
    const provider = cfg.provider[id];
    if (!provider?.models) continue;
    out[id] = provider.models;
  }
  return out;
}

test("跨渠道：variants 必须是「键=梯队档位词」的对象，不能是字符串数组", async () => {
  const models = await collectModels();
  assert.ok(Object.keys(models).length >= 27, `渠道数偏少：${Object.keys(models).length}`);

  const problems = [];
  for (const [channel, rows] of Object.entries(models)) {
    for (const [modelId, row] of Object.entries(rows)) {
      const variants = row?.variants;
      if (variants === undefined) continue;
      if (Array.isArray(variants)) {
        // 数组会被 Object.keys 变成 "0"/"1"/"2"，DSH 一个档位都不认。
        problems.push(`${channel}/${modelId}: variants 是数组 ${JSON.stringify(variants)}`);
        continue;
      }
      if (typeof variants !== "object" || variants === null) {
        problems.push(`${channel}/${modelId}: variants 不是对象 ${JSON.stringify(variants)}`);
        continue;
      }
      const keys = Object.keys(variants);
      const unknown = keys.filter((key) => !LADDER.has(key));
      if (unknown.length) {
        problems.push(`${channel}/${modelId}: 非梯队档位 ${JSON.stringify(unknown)}（全部键 ${JSON.stringify(keys)}）`);
      }
      // 只剩一个 off：dshModelLevels 直接返回 nil，等于声明了空选择器。
      if (keys.length === 1 && keys[0] === "none") {
        problems.push(`${channel}/${modelId}: 只有 none 一档，DSH 会当作没有档位`);
      }
      // 声明了档位就该同时声明 reasoning 能力，否则 UI 上是空选择器。
      if (row?.reasoning !== true) {
        problems.push(`${channel}/${modelId}: 有 variants 却没声明 reasoning=true`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
