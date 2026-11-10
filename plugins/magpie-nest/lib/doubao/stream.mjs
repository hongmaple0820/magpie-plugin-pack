// 豆包新版 SSE 投影：STREAM_CHUNK 的 patch 语义 -> OpenAI chunk。
//
// 事件形态（实测）：id/event/data 三行一组，块间空行。
//   STREAM_CHUNK.data.patch_op[].patch_value.content_block[]：
//     block_type 10000 + patch_type 1 -> 正文追加（text_block.text）
//     block_type 10040 -> 思考 UI 元数据（thinking_block，文本字段无常驻）
//     block_type 10091 -> 计时块
//   SSE_REPLY_END 收尾（end_type 1 正常、3 会话冲突需换新会话重试）。
// 旧版 2001/2003 事件已不存在，本文件只做新协议。

export function newState() {
  return { text: "", finished: false, error: undefined, endType: 0 };
}

/** 一个 SSE 块贡献的正文文本（block_type 10000 + patch_type 1 追加）。 */
export function textOfChunkData(data) {
  let out = "";
  for (const op of Array.isArray(data?.patch_op) ? data.patch_op : []) {
    for (const block of Array.isArray(op?.patch_value?.content_block) ? op.patch_value.content_block : []) {
      if (block?.block_type === 10000 && op?.patch_type === 1) {
        const text = block?.content?.text_block?.text;
        if (typeof text === "string") out += text;
      }
    }
  }
  return out;
}

/** 逐行喂入，产出该行贡献的正文增量；null 表示无增量。 */
export function foldEvent(state, line) {
  const trimmed = String(line ?? "").trim();
  if (trimmed.startsWith("data:")) {
    const payload = trimmed.slice(5).trim();
    if (!payload || payload.startsWith("{")) {
    }
    try {
      const data = JSON.parse(payload);
      if (typeof data?.end_type === "number") {
        state.endType = data.end_type;
        state.finished = true;
        return null;
      }
      if (data?.error_code) {
        state.error = data.error_msg || String(data.error_code);
        state.finished = true;
        return null;
      }
      const text = textOfChunkData(data);
      if (text) {
        state.text += text;
        return text;
      }
    } catch {
      /* 非整行 JSON：SSE data 跨行的情况按无增量处理 */
    }
  }
  return null;
}
