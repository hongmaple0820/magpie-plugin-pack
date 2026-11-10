// 豆包渠道身份与协议事实索引。真实协议（端点/请求体/SSE 语义/指纹 query）
// 在 protocol.mjs——2026-11-10 抓包实测重写；旧 /samantha/ 端点已废弃。

export const ID = "doubao";
export const NAME = "豆包";
export const NPM = "@ai-sdk/openai-compatible";
export const API_BASE = "https://www.doubao.com";
export const CHAT_PATH = "/chat/completion";

export { modelRows, stripModel } from "./protocol.mjs";
