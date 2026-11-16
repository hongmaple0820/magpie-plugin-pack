// 消息日志：谁发给谁、链与来回数、答复在哪。绝不存原文，只存指纹。
// 保留一周（照 messaging/journal.rs 的 KEPT_MS）。原子整文件写。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsRoot, atomicWriteJson } from "./delivery/claude.mjs";

const KEPT_MS = 7 * 86_400_000;

function journalPath() {
  return process.env.MAGPIE_AGENTS_JOURNAL || join(agentsRoot(), "journal.json");
}

// 一条消息的记录（照 journal.rs 的 Message，camelCase）：
//   id          m-<12位>
//   kind        send | start
//   chain       链首消息 id（无用户介入的来回）
//   count       本条是链里第几棒（从 1）
//   from/to     {client, sessionId, title}
//   form        labelled | own
//   replyTo     回复的那条消息 id
//   requestId   投递身份（send 用消息 id）
//   sentAtMs    发出时刻
//   fingerprint 送达文字 trim 后的 SHA-256（在对方转录里认出它）
//   state       queued|taken|started|done|replied|refused|expired|uncertain
//   reason      拒绝原因
//   answered    答复已回送（或太老/回合无内容）
//   repliedBy   对方用 send_message reply_to 答复它的那条消息 id
export function newMessage(fields) {
  return {
    id: fields.id,
    kind: fields.kind ?? "send",
    chain: fields.chain,
    count: fields.count,
    from: fields.from,
    to: fields.to,
    form: fields.form,
    replyTo: fields.replyTo ?? null,
    requestId: fields.requestId,
    sentAtMs: fields.sentAtMs,
    fingerprint: fields.fingerprint,
    state: fields.state,
    reason: fields.reason ?? null,
    answered: false,
    repliedBy: null,
  };
}

export class Journal {
  constructor() {
    this.path = journalPath();
    this.messages = [];
    try {
      if (existsSync(this.path)) {
        this.messages = JSON.parse(readFileSync(this.path, "utf8")).messages ?? [];
      }
    } catch {
      this.messages = []; // 读不动就当空的：宁可少算来回也不误拒
    }
    this.prune();
  }

  save() {
    atomicWriteJson(this.path, { messages: this.messages });
  }

  // 忘掉一周前的消息。
  prune(now = Date.now()) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => now - m.sentAtMs < KEPT_MS);
    if (this.messages.length !== before) this.save();
  }

  add(message) {
    this.messages.push(message);
    this.save();
  }

  replace(message) {
    const slot = this.messages.find((row) => row.id === message.id);
    if (slot) {
      Object.assign(slot, message);
      this.save();
    }
  }

  find(id) {
    return this.messages.find((message) => message.id === id) ?? null;
  }

  // 这个会话收到过、且没被拒绝的消息，新在前（照 received）。
  received(client, session) {
    return this.messages
      .filter(
        (m) =>
          m.to.client === client &&
          m.to.sessionId === session &&
          m.state !== "refused",
      )
      .reverse();
  }

  // 回复的 id 集：reply_to 指回原发件方的那些（照 replies）。
  replies() {
    const out = new Set();
    for (const message of this.messages) {
      if (!message.replyTo) continue;
      const parent = this.find(message.replyTo);
      if (parent && parent.from.sessionId === message.to.sessionId) out.add(message.id);
    }
    return out;
  }
}
