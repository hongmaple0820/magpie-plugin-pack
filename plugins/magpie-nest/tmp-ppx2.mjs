import fs from "node:fs";
import { findBrowser, freePort, launchBrowser, killBrowser, profileDirFor, waitCdp, killProfileHolders } from "./lib/weblogin/browser.mjs";
import { wsConnect } from "./lib/weblogin/ws.mjs";
const exe = findBrowser();
const pd = profileDirFor("perplexity");
await killProfileHolders(pd);
const port = await freePort();
const child = launchBrowser({ exe, profileDir: pd, port, startUrl: "https://www.perplexity.ai" });
await waitCdp(port, 25000);
const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
const t = targets.find((x) => x.type === "page");
const ws = await wsConnect({ host: "127.0.0.1", port, path: t.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, "") });
let id = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onMessage((raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
fs.writeFileSync("ppx-status.txt", "WATCHING");
const deadline = Date.now() + 280000;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const ck = await send("Network.getCookies", { urls: ["https://www.perplexity.ai"] }).catch(() => null);
  if (!ck) continue;
  const all = ck.cookies || [];
  const sess = all.find((c) => /next-auth\.session-token/i.test(c.name));
  const names = all.map((c) => c.name).sort().join(",");
  if (names !== last) { last = names; fs.writeFileSync("ppx-status.txt", "cookies: " + names.slice(0, 300)); }
  if (sess) {
    fs.writeFileSync("ppx-status.txt", "FOUND " + sess.name + " len=" + String(sess.value).length);
    console.log("FOUND", sess.name, String(sess.value).length);
    break;
  }
}
ws.close();
await killBrowser(child);
