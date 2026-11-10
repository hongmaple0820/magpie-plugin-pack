import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, foldEvent, textOfChunkData } from "../lib/doubao/stream.mjs";
import { requestBody, chatQuery, modelRows, stripModel } from "../lib/doubao/protocol.mjs";
import { ID as CONST_ID, API_BASE, CHAT_PATH } from "../lib/doubao/constants.mjs";

const chunk = (blocks, patchType = 1) =>
  "data: " + JSON.stringify({ patch_op: [{ patch_type: patchType, patch_value: { content_block: blocks } }] });

test("STREAM_CHUNK 的 10000 块按追加累计正文", () => {
  const state = newState();
  const block = (text) => ({ block_type: 10000, content: { text_block: { text } } });
  assert.equal(foldEvent(state, chunk([block("你")])), "你");
  assert.equal(foldEvent(state, chunk([block("好")])), "好");
  assert.equal(state.text, "你好");
});

test("patch_type=2 的替换块不进正文", () => {
  const state = newState();
  const block = (text) => ({ block_type: 10000, content: { text_block: { text } } });
  assert.equal(foldEvent(state, chunk([block("替换")], 2)), null);
  assert.equal(state.text, "");
});

test("非 10000 块（思考 UI / 计时）被忽略", () => {
  const state = newState();
  const ui = { block_type: 10040, content: { thinking_block: { streaming_title: "正在思考" } } };
  const timer = { block_type: 10091, content: { elapsed_block: {} } };
  assert.equal(foldEvent(state, chunk([ui, timer])), null);
  assert.equal(state.text, "");
});

test("SSE_REPLY_END 收尾", () => {
  const state = newState();
  foldEvent(state, "data: " + JSON.stringify({ end_type: 1 }));
  assert.equal(state.finished, true);
  assert.equal(state.endType, 1);
});

test("error_code 是错误", () => {
  const state = newState();
  foldEvent(state, "data: " + JSON.stringify({ error_code: 710020202, error_msg: "common invalid param" }));
  assert.equal(state.error, "common invalid param");
  assert.equal(state.finished, true);
});

test("请求体带全新会话标识与完整 option", () => {
  const body = requestBody({ text: "hi" });
  const meta = body.client_meta;
  assert.ok(meta.local_conversation_id.startsWith("local_"));
  assert.equal(meta.conversation_id, "");
  assert.equal(meta.bot_id, "7338286299411103781");
  assert.equal(body.messages[0].content_block[0].block_type, 10000);
  assert.equal(body.messages[0].content_block[0].content.text_block.text, "hi");
  assert.equal(body.option.need_create_conversation, true);
  const other = requestBody({ text: "hi" });
  assert.notEqual(meta.local_conversation_id, other.client_meta.local_conversation_id);
  assert.notEqual(body.messages[0].local_message_id, other.messages[0].local_message_id);
});

test("指纹 query 抄自登录，可变参数每次生成", () => {
  const q = chatQuery({ device_id: "123", fp: "verify_x", msToken: "abc", a_bogus: "zz", tea_uuid: "t", web_id: "w" });
  const p = new URLSearchParams(q);
  assert.equal(p.get("fp"), "verify_x");
  assert.equal(p.get("device_id"), "123");
  assert.equal(p.get("aid"), "497858");
  assert.equal(p.get("pc_version"), "3.45.0");
  const q2 = chatQuery({ device_id: "123", fp: "verify_x", msToken: "abc", a_bogus: "zz", tea_uuid: "t", web_id: "w" });
  assert.notEqual(new URLSearchParams(q2).get("web_tab_id"), p.get("web_tab_id"));
});

test("端点是新版 /chat/completion 而不是废弃的 samantha", () => {
  assert.equal(CHAT_PATH, "/chat/completion");
  assert.equal(CONST_ID, "doubao");
  assert.equal(API_BASE, "https://www.doubao.com");
});

test("模型表与去前缀", () => {
  assert.ok(modelRows().doubao);
  assert.equal(stripModel("doubao/doubao"), "doubao");
  assert.equal(stripModel("doubao"), "doubao");
});

test("textOfChunkData 直读 patch 数据", () => {
  const data = { patch_op: [{ patch_type: 1, patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: "OK" } } }] } }] };
  assert.equal(textOfChunkData(data), "OK");
  assert.equal(textOfChunkData({}), "");
});
