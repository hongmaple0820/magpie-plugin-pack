
import fs from "node:fs";
const { webLoginMethod } = await import("./lib/weblogin/index.mjs");
const out = [];
const log = (s) => { out.push(s); fs.writeFileSync("kimi-login-result.txt", out.join("\n")); };
const t0 = Date.now();
try {
  const m = webLoginMethod({ channel: "kimi", label: "验证" });
  const a = await m.authorize({}, {});
  log("阶段: 浏览器已拉起，等待你在窗口里登录并打开一个对话…");
  const res = await a.callback("", {});
  const el = Math.round((Date.now() - t0) / 1000);
  if (res.type === "success") {
    const tk = String(res.access || "");
    log("RESULT=success  用时 " + el + "s");
    log("token 长度=" + tk.length + "  前 8 位=" + tk.slice(0, 8) + "…  via=" + (res.via ?? "-"));
  } else {
    log("RESULT=failed  用时 " + el + "s");
    log("error=" + res.error);
  }
} catch (e) {
  log("THREW=" + (e?.message || e));
}
