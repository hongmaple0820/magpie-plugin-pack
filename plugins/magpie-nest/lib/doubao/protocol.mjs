// 豆包真实协议（2026-11-10 抓包实测，PC 网页版 3.45.0）。
//
// 端点：POST /chat/completion?<全套 query>。旧版 /samantha/chat/completion 已废弃：
// 网关回 STREAM_ERROR 710020202 "common invalid param"。
// query 的关键是指纹族（fp=verify_…、msToken、a_bogus、device_id、tea_uuid、web_id），
// 一键登录时整套存进账号（fpQuery），重放有效（实测同一指纹连发两次均 200）。
// 请求体：client_meta + messages[{content_block:[{block_type:10000,…}]}] + option{...}。
// 响应 SSE：STREAM_CHUNK.data.patch_op[].patch_value.content_block[]；
//   block_type 10000 + patch_type 1 追加即正文；10040 是思考 UI 元数据；
//   10091 是计时块；SSE_REPLY_END 收尾。DOWNLINK_CMD + end_type=3 表示
//   会话 ID 冲突（服务器让你拉历史），换全新 local_conversation_id 即可。
// 凭据：整套 cookie（一键登录 cookieJar）。

import { randomUUID } from "node:crypto";

export const CHAT_PATH = "/chat/completion";
export const BOT_ID = "7338286299411103781";

/** 一次登录会话的指纹 query（fp/msToken/a_bogus/device_id/tea_uuid/web_id），
 * 由一键登录从真实浏览器抄下来，随账号落库；这里拼上可变部分。 */
export function chatQuery(fpQuery = {}) {
  const q = new URLSearchParams({
    aid: "497858",
    device_platform: "web",
    doubao_device_platform: "web",
    doubao_pc_version: "3.45.0",
    language: "zh",
    pc_version: "3.45.0",
    pkg_type: "release_version",
    real_aid: "497858",
    region: "CN",
    samantha_web: "1",
    sys_region: "CN",
    tz_name: "Asia/Shanghai",
    "use-olympus-account": "1",
    version_code: "20800",
    web_platform: "pc",
    web_tab_id: randomUUID(),
  });
  for (const key of ["device_id", "fp", "msToken", "a_bogus", "tea_uuid", "web_id"]) {
    const v = String(fpQuery[key] ?? "").trim();
    if (v) q.set(key, v);
  }
  return q.toString();
}

export function newConversationId() {
  return "local_" + String(Math.random()).slice(2, 18);
}

/** messages[] -> 豆包请求体。单条用户消息（网页客户端每轮只发一条）。 */
export function requestBody({ text, conversationId = "", sectionId = "" }) {
  const now = Date.now();
  return {
    client_meta: {
      // 每轮必须全新：服务器按 client_meta.local_conversation_id /
      // messages[0].local_message_id / option.unique_key 去重，任何一项复用
      // 都只回一个空的 is_finish 块（正文永远为空）。实测：真机请求原样重放
      // 得 0 chunk，换这三个 ID 后同 body 立即返回正文。
      local_conversation_id: newConversationId(),
      conversation_id: "",
      bot_id: BOT_ID,
      last_section_id: "",
      last_message_index: null,
      local_permissions: [
        { permission_name: "ACCESS_COARSE_LOCATION", status: 3 },
        { permission_name: "ACCESS_FINE_LOCATION", status: 3 },
        { permission_name: "ACCESS_BACKGROUND_LOCATION", status: 3 },
      ],
    },
    messages: [
      {
        local_message_id: randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: { text_block: { text, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
            block_id: randomUUID(),
            parent_id: "",
            meta_info: [],
            extra_info: {},
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: now,
      collect_id: "",
      is_audio: false,
      answer_with_suggest: false,
      agent_mode: 2,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: "",
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: "0", reasoning_effort: "3", mode_id: "1" },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: "",
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: "",
      shared_app_id: "",
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: { server_do_compare: true },
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      // 真机抓包对比出来的两个必需字段（缺了服务器只回空壳 is_finish 块）：
      model_config: { model_item_key: "0", model_extra_params: {}, reasoning_effort: 3 },
      conversation_mode: 1,
      aggregate_params: {
        mention_skill_list: "[]",
        mention_plugin_list: "[]",
        mention_ext: "[{}]",
        conversation_mode: "1",
        mode_id: "1",
        model_item_key: "0",
        agent_mode: "2",
        reasoning_effort: "3",
        provider_id: "",
      },
    },
  };
}

export function clientHeaders() {
  return {
    Accept: "text/event-stream",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://www.doubao.com",
    Referer: "https://www.doubao.com/chat/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
  };
}

export function modelRows() {
  return { doubao: { name: "豆包", tool_call: true } };
}

export function stripModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.startsWith("doubao/") ? id.slice("doubao/".length) : id;
}
