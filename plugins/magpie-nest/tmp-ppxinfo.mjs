import { findBrowser, freePort, launchBrowser, killBrowser, profileDirFor, waitCdp, killProfileHolders } from "./lib/weblogin/browser.mjs";
import { wsConnect } from "./lib/weblogin/ws.mjs";
const exe = findBrowser();
const pd = profileDirFor("perplexity");
await killProfileHolders(pd);
const port = await freePort();
const child = launchBrowser({ exe, profileDir: pd, port, startUrl: "https://www.perplexity.ai" });
await waitCdp(port, 25000);
await new Promise((r) => setTimeout(r, 9000));
const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
const t = targets.find((x) => x.type === "page");
const ws = await wsConnect({ host: "127.0.0.1", port, path: t.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, "") });
let id = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onMessage((raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const info = await send("Runtime.evaluate", {
  expression: "JSON.stringify({ loggedIn: !!document.cookie.match(/session-token/), buttons: [...document.querySelectorAll('button,a')].map(b=>(b.innerText||b.getAttribute('aria-label')||'').trim()).filter(Boolean).slice(0,20) })",
  returnByValue: true,
});
console.log(info.result?.value?.slice(0, 500));
ws.close();
await killBrowser(child);
