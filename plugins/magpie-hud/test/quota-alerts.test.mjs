import test from "node:test";
import assert from "node:assert/strict";
import { quotaAlerts } from "../webapp/notify.mjs";

const w = (key, percent) => ({ key, provider: key.split("|")[0], window: key.split("|")[1], percent });

test("crossing the threshold announces once, not twice", () => {
  let prev = {};
  // 第一次 85%：未越线
  let r = quotaAlerts(prev, [w("acme|5h", 85)]);
  assert.deepEqual(r.fresh, []);
  prev = r.prev;
  // 到 91%：越线，报一次
  r = quotaAlerts(prev, [w("acme|5h", 91)]);
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].window, "5h");
  assert.equal(r.fresh[0].threshold, 90);
  prev = r.prev;
  // 还在 93%：不重复报
  r = quotaAlerts(prev, [w("acme|5h", 93)]);
  assert.deepEqual(r.fresh, []);
});

test("seeding records without announcing", () => {
  const r = quotaAlerts({}, [w("acme|5h", 99)], 90, { seed: true });
  assert.deepEqual(r.fresh, [], "首次播种不弹卡");
  assert.equal(r.prev["acme|5h"], 99, "但要记住已经超线");
  // 播种后继续涨：不再报（本来就在线上）
  const r2 = quotaAlerts(r.prev, [w("acme|5h", 100)]);
  assert.deepEqual(r2.fresh, [], "已在线上继续涨不重复报");
});

test("without seeding, first sight above the line announces", () => {
  const r = quotaAlerts({}, [w("acme|5h", 99)]);
  assert.equal(r.fresh.length, 1, "没播种时首见即报（函数语义）");
});

test("dropping below clears the record so it can announce again", () => {
  let r = quotaAlerts({}, [w("acme|5h", 95)]);
  assert.equal(r.fresh.length, 1);
  r = quotaAlerts(r.prev, [w("acme|5h", 10)]); // 重置
  assert.deepEqual(r.fresh, []);
  assert.equal(r.prev["acme|5h"], 10, "回落后只记新值");
  r = quotaAlerts(r.prev, [w("acme|5h", 92)]); // 又烧上去
  assert.equal(r.fresh.length, 1, "再次越线应重新报");
});

test("custom threshold and non-finite percents", () => {
  const r = quotaAlerts({}, [w("a|b", 75), { key: "c|d", percent: null }, { key: "e|f", percent: NaN }], 70);
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].key, "a|b");
});

test("several at once all announce", () => {
  const r = quotaAlerts({}, [w("a|x", 91), w("b|y", 95), w("c|z", 20)]);
  assert.deepEqual(r.fresh.map((f) => f.key).sort(), ["a|x", "b|y"]);
});

test("malformed input is tolerated", () => {
  assert.deepEqual(quotaAlerts({}, null).fresh, []);
  assert.deepEqual(quotaAlerts({}, [null, undefined]).fresh, []);
  assert.deepEqual(quotaAlerts(null, []).fresh, []);
});
