// 状态诚实性检查（§6 验收表第一行）：
//   - 每一行都要有 `source.kind`（没有来源的状态一律算违例）；
//   - `source.kind === "mtime"` 的行，`phase` 必须是 `unknown`（写入时间证不了在跑）；
//   - `phase === "unknown"` 且来源是事件/注册表的行，必须带 `unknown.reason` 代码；
//   - reason 必须是**代码**（闭集根 + 可选参数），不能是给人看的散文——
//     散文进不了断言，也没法在面板上做分类。
//
// 为什么用脚本而不是只靠测试：测试跑夹具，这个跑这台机器上**真实的**会话目录。
// 夹具再全，也证不了「用户机器上不会冒出无来源的状态」。
//
// 用法：node tools/check/honesty.mjs
import { listSessions } from "../../lib/sessions.mjs";

// 闭集根：新增一种「不知道」必须来这里登记
const ROOTS = new Set([
  "no-truth-source", // 这个客户端没有真值源（只有 mtime）
  "no-evidence",     // 事件源在，但窗口里没有可用事件
  "unread",          // 转录读不动
  "tap-mismatch",    // tap 与转录对不上
  "decode",          // 解码失败（decode:<reason>）
  "seq-gap",         // 序号断档（seq-gap:expected:N:got:M）
]);

const isCode = (reason) => {
  if (typeof reason !== "string" || !reason) return false;
  if (/\s/.test(reason)) return false;         // 有空格 = 散文
  const root = reason.split(":")[0];
  return ROOTS.has(root);
};

const violations = [];
const violate = (row, code, detail) => violations.push({ row, code, detail });

const listing = await listSessions();
const rows = listing?.sessions ?? [];
console.log(`会话 ${rows.length} 条`);

for (const row of rows) {
  const kind = row?.source?.kind;
  const id = `${row?.client ?? "?"}/${row?.id ?? "?"}`;
  if (!kind) violate(row, "no-source", `${id} 没有 source.kind`);
  if (kind === "mtime" && row?.phase && row.phase !== "unknown") {
    violate(row, "mtime-claims-phase", `${id} 是 mtime 源却给了 phase=${row.phase}`);
  }
  if (row?.phase === "unknown") {
    const reason = row?.truth?.unknown?.reason ?? row?.unknown?.reason ?? null;
    if (!reason) {
      // 只有「来源本身就说不了状态」的两种才允许没有 reason：没有源、只有写入时间。
      if (!["none", "mtime"].includes(kind)) {
        violate(row, "unknown-without-reason", `${id} phase=unknown、source=${kind}，却没写 unknown.reason`);
      }
    } else if (!isCode(reason)) {
      violate(row, "reason-not-a-code", `${id} unknown.reason=${JSON.stringify(reason)}`);
    }
  }
}

if (!rows.length) console.log("没有会话可查（空环境或本机没装客户端）——不算违例，但这次没验到东西");

if (violations.length) {
  console.error(`违例 ${violations.length} 条：`);
  for (const v of violations.slice(0, 40)) console.error(`  - [${v.code}] ${v.detail}`);
  if (violations.length > 40) console.error(`  …还有 ${violations.length - 40} 条`);
  process.exit(1);
}
console.log("违例 0");
