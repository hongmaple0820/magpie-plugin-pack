// 入口约定（magpie-nest 同款）：host 把入口导出的每个函数都当作一个
// 插件运行，所以入口必须只导出一个插件函数——多导出的辅助函数会被当
// 成插件跑（stopPageServices 会把页面服务停掉）。这条测试守住它。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as entry from "../index.mjs";

test("the entry exports exactly one plugin function", () => {
  assert.deepEqual(Object.keys(entry).sort(), ["MagpieHudPlugin"]);
  assert.equal(typeof entry.MagpieHudPlugin, "function");
});
