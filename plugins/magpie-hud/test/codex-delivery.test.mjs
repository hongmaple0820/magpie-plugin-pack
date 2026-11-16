import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createMessaging } = await import("../lib/messaging.mjs");
const { listSessions } = await import("../lib/sessions.mjs");

test("send_message to codex queues and get_message reads the answer", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-agents-codex-"));
  const day = join(home, ".codex", "sessions", "2026", "11", "11");
  mkdirSync(day, { recursive: true });
  const file = join(day, "rollout-2026-11-11T10-00-00-abc.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "codex-to", cwd: "F:/maple/other" } }) + "\n"
  );
  process.env.MAGPIE_AGENTS_HOME = home;
  process.env.MAGPIE_AGENTS_CODEX_CMD = "node " + new URL("./fake-codex.mjs", import.meta.url).pathname.replace(/^\/[A-Za-z]:/, (m) => m[1] + ":");
  try {
    const listing = await listSessions();
    const target = listing.sessions.find((s) => s.client === "codex" && s.id === "codex-to");
    assert.ok(target, "codex session listed");
    const m = createMessaging();
    const out = await m.send({ to: "codex-to", text: "please do the thing" }, { allSessions: listing.sessions });
    assert.equal(out.state, "queued");
    assert.ok(out.id, "message id");
    writeFileSync(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "codex-to", cwd: "F:/maple/other" } }) + "\n" +
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[magpie-agents · 来自 Claude Code · " + out.id + "]\n\nplease do the thing\n\nReply with ..." }] } }) + "\n" +
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done, here it is" }] } }) + "\n"
    );
    const got = m.get(out.id);
    assert.equal(got.state, "done");
    assert.equal(got.answer, "done, here it is");
  } finally {
    delete process.env.MAGPIE_AGENTS_HOME;
    delete process.env.MAGPIE_AGENTS_CODEX_CMD;
    rmSync(home, { recursive: true, force: true });
  }
});

test("start_session codex starts a thread, queues the first text, and returns the id", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-agents-codex-start-"));
  process.env.MAGPIE_AGENTS_HOME = home;
  process.env.MAGPIE_AGENTS_CODEX_CMD = "node " + new URL("./fake-codex.mjs", import.meta.url).pathname.replace(/^\/[A-Za-z]:/, (m) => m[1] + ":");
  try {
    const m = createMessaging();
    const out = await m.start({ client: "codex", text: "first prompt" }, { allSessions: [] });
    assert.equal(out.state, "started");
    assert.equal(out.session, "11111111-2222-3333-4444-555555555555");
    assert.ok(out.id, "message id");
  } finally {
    delete process.env.MAGPIE_AGENTS_HOME;
    delete process.env.MAGPIE_AGENTS_CODEX_CMD;
    rmSync(home, { recursive: true, force: true });
  }
});
