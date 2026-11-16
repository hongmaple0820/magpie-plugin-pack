// 页面本体不画 UI，只把窗口交给本地服务（webapp/app.html）。
// 服务就是 pageservice.mjs 的 createPageService；地址取法照 page-chat：
// magpie.service（magpie web 经反代）优先，否则桌面窗口直连 127.0.0.1。
// 走 location.replace 而非 iframe 嵌服务：CSP 允许的只有沙箱脚本导航，
// 子 iframe 会被 connect-src / frame-src 卡住（服务自身 CSP 也写明了）。
(async () => {
  await magpie.ready;
  const named = magpie.service ? new URL(magpie.service, location.href) : null;
  const target = named ?? new URL("http://127.0.0.1:3477/");
  if (target.hash === "#") target.hash = "";
  location.replace(target.href);
})();
