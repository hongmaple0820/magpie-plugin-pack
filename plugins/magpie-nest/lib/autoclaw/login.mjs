// Sign-in methods, ported from the verified community implementation
// @magpie-community/opencode-autoclaw-auth@0.2.21 index.mjs
// (phoneSmsMethod:1727, overseaOAuthMethod:1782, startLocalOAuth:1803,
// guidePageHtml:2035, callbackPageHtml:2154).
//
//   autoclaw     Google / z.ai web OAuth on the global host; a local
//                guide page on an official TokenServer callback port runs
//                the Aliyun captcha, then the browser jumps to the vendor
//                authorization page and the code lands back on that port.
//   autoclaw-cn  +86 phone SMS: agent-send-code then agent-login.

import * as http from "node:http";
import { CN_HOST, GLOBAL_HOST, PRODUCT } from "./constants.mjs";
import { callEnvelope, codeValue, newDeviceId, nonEmptyString, tokenFields } from "./headers.mjs";

const OAUTH_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
// Official TokenServer port pool: the OAuth client only accepts these
// callback ports (reference index.mjs:1830).
const FIXED_PORTS = [18432, 19654, 19723, 53699];

export function phoneSmsMethod() {
  return {
    type: "oauth",
    label: "AutoClaw 手机验证码登录（国内）",
    prompts: [
      {
        type: "text",
        key: "phone",
        message: "手机号（11 位，不带 +86）",
        placeholder: "13800138000",
        validate: (v) => (/^1\d{10}$/.test(String(v ?? "").trim()) ? undefined : "11 位手机号"),
      },
    ],
    async authorize(inputs) {
      const phone = String(inputs?.phone ?? "").trim();
      // authorize 失败必须 throw；返回 {type:"failed"} 会被宿主当 "auto" 分支处理。
      if (!/^1\d{10}$/.test(phone)) throw new Error("请输入 11 位手机号（不带 +86）");
      const deviceId = newDeviceId();
      const send = await callEnvelope("/userapi/v1/agent-send-code", {
        method: "POST",
        body: JSON.stringify({ source_id: PRODUCT, device_id: deviceId, phone }),
        base: CN_HOST,
      });
      if (send.code !== 0) {
        throw new Error("发送验证码失败: " + (send.msg ?? "code " + send.code));
      }
      return {
        url: "",
        instructions: "验证码已发送到 " + phone.slice(0, 3) + "****" + phone.slice(-4) + " 的短信，请输入收到的验证码。",
        method: "code",
        async callback(code) {
          const res = await callEnvelope("/userapi/v1/agent-login/", {
            method: "POST",
            body: JSON.stringify({ source_id: PRODUCT, device_id: deviceId, phone, code: codeValue(code) }),
            base: CN_HOST,
          });
          if (res.code !== 0 || !res.data?.access_token) {
            return { type: "failed", error: "登录失败: " + (res.msg ?? "code " + res.code) };
          }
          const t = tokenFields(res.data);
          return {
            type: "success",
            ...t,
            accountId: phone,
            email: phone,
            uid: nonEmptyString(res.data.user_id),
          };
        },
      };
    },
  };
}

export function overseaOAuthMethod() {
  return {
    type: "oauth",
    label: "AutoClaw 网页登录（Google / z.ai）",
    prompts: [
      {
        type: "select",
        key: "vendor",
        message: "登录方式",
        options: [
          { label: "Google 账号", value: "google" },
          { label: "z.ai 账号", value: "zai" },
        ],
      },
    ],
    async authorize(inputs) {
      const vendor = inputs?.vendor === "zai" ? "zai" : "google";
      return await startLocalOAuth(vendor);
    },
  };
}

/**
 * 启动本地 OAuth：立即返回 {url, method:"auto", callback}。
 * url = 本地引导页（滑块在内完成，之后自动跳授权页）；callback 挂起等 code，
 * 拿到后直连上游换 token。
 */
async function startLocalOAuth(vendor) {
  const deviceId = newDeviceId();
  const state = {
    captchaReceipt: null,
    oauthCode: null,
    oauthState: "",
    expectedOauthState: null,
    error: null,
  };
  const waiters = [];
  const notify = () => { while (waiters.length) waiters.shift()(); };
  const waitFor = (timeoutMs, what) => new Promise((resolve, reject) => {
    const check = () => {
      if (state.error) { cleanup(); reject(new Error(state.error)); return true; }
      if (state.oauthCode) { cleanup(); resolve(state.oauthCode); return true; }
      return false;
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(what + " 等待超时（" + Math.round(timeoutMs / 60000) + " 分钟）— 请重试登录")); }, timeoutMs);
    const w = () => { check(); };
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
    waiters.push(w);
    check();
  });

  let fixedPort = 0;
  const probe = http.createServer();
  for (const p of FIXED_PORTS) {
    const ok = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(p, "127.0.0.1", () => { probe.close(() => resolve(true)); });
    });
    if (ok) { fixedPort = p; break; }
  }
  if (!fixedPort) {
    throw new Error("本地端口 " + FIXED_PORTS.join("/") + " 均被占用——OAuth 回调需要其中之一（官方 client 白名单端口）。请关闭占用进程（可能是 AutoClaw 桌面端）后重试。");
  }

  const server = http.createServer((req, res) => {
    const base = "http://127.0.0.1:" + (server.address()?.port ?? 0);
    let url;
    try { url = new URL(req.url, base); } catch { res.writeHead(400); res.end(); return; }
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
      res.end(body);
    };
    // 写接口仅接受本机来源；无 Origin 的（curl 等）放行（reference index.mjs:1858）。
    const localOrigin = (req) => {
      const o = req.headers.origin;
      return !o || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o));
    };
    if (["/captcha", "/open-auth", "/abort"].includes(url.pathname) && !localOrigin(req)) {
      send(403, "application/json", JSON.stringify({ error: "forbidden origin" }));
      return;
    }
    if (req.method === "OPTIONS") {
      send(204, "text/plain", "", { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(200, "text/html; charset=utf-8", guidePageHtml(vendor));
      return;
    }
    if (url.pathname === "/captcha-config") {
      callEnvelope("/userapi/overseasv1/oauth-captcha-config", { method: "POST", body: "{}", base: GLOBAL_HOST })
        .then((r) => send(200, "application/json", JSON.stringify(r.data ?? { enabled: false })))
        .catch(() => send(502, "application/json", JSON.stringify({ enabled: false, error: "config fetch failed" })));
      return;
    }
    const readBody = () => new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    });
    if (url.pathname === "/captcha" && req.method === "POST") {
      readBody().then((j) => {
        const receipt = typeof j.receipt === "string" ? j.receipt
          : typeof j.captchaVerifyParam === "string" ? j.captchaVerifyParam : "";
        state.captchaReceipt = receipt.trim();
        send(200, "application/json", JSON.stringify({ ok: !!state.captchaReceipt }), { "Access-Control-Allow-Origin": "*" });
      });
      return;
    }
    if (url.pathname === "/open-auth" && req.method === "POST") {
      (async () => {
        // redirect_uri 必须是官方注册形态：http://localhost:<port>/auth/callback-<vendor>。
        const redirectUri = "http://localhost:" + fixedPort + "/auth/callback-" + vendor;
        const bodyObj = { source_id: PRODUCT, device_id: deviceId, navigate_uri: redirectUri };
        if (state.captchaReceipt) bodyObj.ali_captcha_verify_param = state.captchaReceipt;
        const r = await callEnvelope("/userapi/overseasv1/" + vendor + "-oauth-url", {
          method: "POST", body: JSON.stringify(bodyObj), base: GLOBAL_HOST,
        });
        if (r.code !== 0 || !r.data) {
          send(200, "application/json", JSON.stringify({ error: "获取授权页失败: " + (r.msg ?? "code " + r.code) }));
          return;
        }
        const authorizeUrl = String(r.data.oauth_url ?? r.data.url ?? r.data.login_url ?? r.data.auth_url ?? r.data.verify_url ?? "");
        if (!authorizeUrl) {
          send(200, "application/json", JSON.stringify({ error: "上游未返回授权页地址" }));
          return;
        }
        let handedOutState = "";
        try { handedOutState = new URL(authorizeUrl).searchParams.get("state") ?? ""; } catch {}
        if (!handedOutState) {
          send(200, "application/json", JSON.stringify({ error: "上游授权页地址缺少 state 参数，已取消登录（回调校验必需）" }));
          return;
        }
        state.expectedOauthState = handedOutState;
        send(200, "application/json", JSON.stringify({ url: authorizeUrl }));
      })().catch((e) => send(200, "application/json", JSON.stringify({ error: "获取授权页失败: " + (e?.message ?? e) })));
      return;
    }
    if (url.pathname === "/auth/callback-" + vendor) {
      const code = url.searchParams.get("code");
      const cbState = url.searchParams.get("state") ?? "";
      const accepted = !!code && state.expectedOauthState !== null && cbState === state.expectedOauthState;
      if (accepted) {
        state.oauthCode = code;
        state.oauthState = cbState;
        notify();
        send(200, "text/html; charset=utf-8", callbackPageHtml(true));
      } else {
        const note = !code ? undefined
          : state.expectedOauthState === null ? "授权尚未发起或已结束，请回引导页重试。"
          : "回调校验失败（state 不匹配），已拒绝——请回 magpie 重新登录。";
        send(200, "text/html; charset=utf-8", callbackPageHtml(false, note));
      }
      return;
    }
    if (url.pathname === "/abort" && req.method === "POST") {
      readBody().then((j) => {
        state.error = String(j.reason ?? "用户取消");
        notify();
        send(200, "application/json", JSON.stringify({ ok: true }));
      });
      return;
    }
    send(404, "text/plain", "not found");
  });

  const serverReady = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixedPort, "127.0.0.1", () => resolve(fixedPort));
  });
  await serverReady;

  let sessionDone = false;
  let sessionClosed = false;
  const closeServer = () => {
    if (sessionClosed) return;
    sessionClosed = true;
    clearTimeout(sessionTimer);
    if (!sessionDone) {
      state.error ??= "本地登录已超时，服务器已关闭——请重新发起登录";
      notify();
    }
    try { server.close(); } catch {}
    server.closeAllConnections?.();
  };
  const sessionTimer = setTimeout(closeServer, OAUTH_SESSION_TIMEOUT_MS);
  sessionTimer.unref?.();

  return {
    url: "http://127.0.0.1:" + fixedPort + "/",
    instructions: "本地登录页已就绪（未自动打开时手动访问 http://127.0.0.1:" + fixedPort + "/ ）：请完成滑块验证并登录授权，完成后自动返回 magpie。",
    method: "auto",
    async callback() {
      const port = await serverReady;
      const redirectUri = "http://localhost:" + port + "/auth/callback-" + vendor;
      try {
        const code = await waitFor(5 * 60 * 1000, "浏览器登录");
        const res = await callEnvelope("/userapi/overseasv1/" + vendor + "-oauth-login", {
          method: "POST",
          body: JSON.stringify({ source_id: PRODUCT, device_id: deviceId, code, state: state.oauthState, navigate_uri: redirectUri }),
          base: GLOBAL_HOST,
        });
        if (res.code !== 0 || !res.data?.access_token) {
          return { type: "failed", error: "登录失败: " + (res.msg ?? "code " + res.code) };
        }
        const t = tokenFields(res.data);
        return {
          type: "success",
          ...t,
          accountId: vendor + " 账号",
          email: vendor + " 账号",
          uid: nonEmptyString(res.data.user_id),
        };
      } finally {
        sessionDone = true;
        closeServer();
      }
    },
  };
}

/** 引导页：滑块（如启用）→ 继续授权 → 自动跳授权页。 */
function guidePageHtml(vendor) {
  const vendorName = vendor === "zai" ? "z.ai" : "Google";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AutoClaw ${vendorName} 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f5f6fa;display:flex;justify-content:center;padding:40px 16px;margin:0}
 .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:460px;width:100%;padding:32px}
 h1{font-size:20px;margin:0 0 8px}
 p.sub{color:#666;font-size:14px;margin:0 0 20px}
 .step{font-size:14px;color:#333;margin:10px 0;display:flex;gap:8px;align-items:flex-start}
 .step .n{background:#4f6ef7;color:#fff;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none}
 #captchaBox{margin:16px 0;padding:16px;border:1px dashed #ccc;border-radius:10px;display:none}
 #captchaEle{min-height:44px}
 button.primary{background:#4f6ef7;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-size:15px;cursor:pointer;width:100%;margin-top:16px}
 button.primary:disabled{background:#b9c0f4;cursor:not-allowed}
 .msg{font-size:13px;margin-top:10px;min-height:18px}
 .msg.ok{color:#1a9c5b}.msg.err{color:#d43c3c}.msg.warn{color:#c98a00}
 #done{display:none;text-align:center;padding:20px 0}
 .spin{display:inline-block;width:28px;height:28px;border:3px solid #e3e6f7;border-top-color:#4f6ef7;border-radius:50%;animation:r 0.8s linear infinite;margin-bottom:10px}
 @keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card">
 <h1>AutoClaw · ${vendorName} 登录</h1>
 <p class="sub">本页面由 magpie 插件本地生成，关闭本页即取消登录。</p>
 <div id="steps">
  <div class="step"><span class="n">1</span><span id="stepCaptcha">检查安全验证…</span></div>
  <div id="captchaBox"><div id="captchaEle"></div></div>
  <div class="step"><span class="n">2</span><span>跳转 ${vendorName} 授权页完成登录</span></div>
 </div>
 <button class="primary" id="goBtn" disabled>继续授权</button>
 <div class="msg" id="msg"></div>
 <div id="done"><div class="spin"></div><div>已完成授权，正在返回 magpie…</div></div>
</div>
<script>
const HIDDEN_TRIGGER_ID="__acHiddenTrigger";
(function ensureHiddenTrigger(){
  let b=document.getElementById(HIDDEN_TRIGGER_ID);
  if(!b){b=document.createElement("button");b.id=HIDDEN_TRIGGER_ID;b.type="button";b.tabIndex=-1;
    b.setAttribute("aria-hidden","true");b.style.cssText="position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    document.body.appendChild(b);}
})();
function msg(m,cls){const e=document.getElementById("msg");e.textContent=m;e.className="msg "+(cls||"");}
async function boot(){
  let cfg={enabled:false};
  try{
    const r=await fetch("/captcha-config");cfg=await r.json();
  }catch(e){}
  if(cfg&&cfg.enabled){
    document.getElementById("stepCaptcha").textContent="请点击下方按钮完成安全验证";
    const box=document.getElementById("captchaBox");box.style.display="block";
    window.__acRegion=cfg.region||"ga";window.__acPrefix=cfg.prefix||"sq51tr";
    window.AliyunCaptchaConfig=window.AliyunCaptchaConfig||{region:window.__acRegion,prefix:window.__acPrefix};
    msg("正在加载安全验证组件…","warn");
    await loadCaptchaLib();
    if(!window.initAliyunCaptcha){
      msg("验证组件加载失败（网络/广告拦截），请刷新重试","err");return;
    }
    // init → warmup ≥2.1s → 程序化 click 隐藏按钮 → 组件弹出验证窗；
    // click 太快组件未就绪 → 弹出空白框（reference 实测踩坑）。等待 2.3s。
    window.initAliyunCaptcha({
      SceneId:cfg.scene_id,mode:"popup",element:"#captchaEle",button:"#"+HIDDEN_TRIGGER_ID,
        captchaVerifyCallback:(params)=>{
          const receipt=typeof params==="string"?params:(params&&typeof params.captchaVerifyParam==="string"?params.captchaVerifyParam:JSON.stringify(params||{}));
          fetch("/captcha",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({receipt})})
            .then(()=>{window.__acReceiptSent=true;}).catch(()=>{window.__acReceiptSent=true;});
          return {captchaResult:true};
        },
      onBizResultCallback:()=>{},getInstance:()=>{},
      slideStyle:{width:320,height:40},language:"cn",
      onError:(err)=>{msg("安全验证出错: "+((err&&err.message)||"")+"，请点击重试","err");}
    });
    msg("验证组件已就绪，正在弹出验证窗…","warn");
    setTimeout(()=>{document.getElementById("__acHiddenTrigger").click();},2300);
    const t0=Date.now();
    await (function pollReceipt(){
      if(window.__acReceiptSent||Date.now()-t0>180000)return;
      return new Promise(r=>setTimeout(r,500)).then(pollReceipt);
    })();
    window.__acReceiptSent=false;
    msg("滑块验证通过 ✓","ok");
  }else{
    document.getElementById("stepCaptcha").textContent="无需安全验证 ✓";
  }
  const btn=document.getElementById("goBtn");btn.disabled=false;btn.textContent="继续授权";
}
function loadCaptchaLib(){
  return new Promise((resolve)=>{
    if(window.initAliyunCaptcha){resolve();return;}
    const s=document.createElement("script");
    s.src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
    s.async=true;s.onload=()=>resolve();s.onerror=()=>resolve();
    document.head.appendChild(s);
    setTimeout(()=>resolve(),10000);
  });
}
let leavingForAuthorization=false;
document.getElementById("goBtn").addEventListener("click",async()=>{
  const btn=document.getElementById("goBtn");btn.disabled=true;btn.textContent="正在获取授权页…";
  try{
    const r=await fetch("/open-auth",{method:"POST"});
    const j=await r.json();
    if(j.error){msg(j.error,"err");btn.disabled=false;btn.textContent="继续授权";return;}
    document.getElementById("steps").style.display="none";btn.style.display="none";
    document.getElementById("done").style.display="block";
    setTimeout(()=>{leavingForAuthorization=true;location.href=j.url;},600);
  }catch(e){msg("本地登录连接已断开或会话已结束，请回 magpie 重新发起登录："+e.message,"err");btn.disabled=false;btn.textContent="继续授权";}
});
window.addEventListener("beforeunload",()=>{
  if(leavingForAuthorization)return;
  try{navigator.sendBeacon("/abort",new Blob([JSON.stringify({reason:"页面关闭"})],{type:"application/json"}));}catch(_){}
});
boot().catch((e)=>msg("初始化失败："+e.message,"err"));
</script></body></html>`;
}

/** 授权回调落地页；note 覆盖默认文案。 */
function callbackPageHtml(ok, note) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AutoClaw 登录</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f6fa}
.c{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:40px 48px;text-align:center}
h1{font-size:18px;margin:0 0 8px;color:${ok ? "#1a9c5b" : "#d43c3c"}}</style></head>
<body><div class="c"><h1>${ok ? "✓ 授权成功" : "✗ 授权失败"}</h1>
<p style="color:#666;font-size:14px">${note ?? (ok ? "正在返回 magpie 完成登录，本页可以关闭。" : "回调缺少 code，请回 magpie 重试。")}</p></div></body></html>`;
}
