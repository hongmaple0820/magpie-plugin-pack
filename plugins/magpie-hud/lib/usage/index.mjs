// list_quotas 的数据源：各客户端读取器按 client 过滤后并行读。
import { readClaudeQuota } from "./claude.mjs";
import { readCodexQuota } from "./codex.mjs";

export async function listQuotas({ client } = {}) {
  const wanted = client ? [client] : ["claude", "codex"];
  const jobs = [];
  if (wanted.includes("claude")) jobs.push(["claude", readClaudeQuota()]);
  if (wanted.includes("codex")) jobs.push(["codex", readCodexQuota()]);
  const settled = await Promise.all(jobs.map(async ([name, job]) => [name, await job.catch((error) => ({ client: name, status: "failed", notice: String(error?.message ?? error) }))]));
  return { clients: settled.map(([, value]) => value) };
}
