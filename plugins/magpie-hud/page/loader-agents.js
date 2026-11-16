// 面板入口（magpie.panels 的 agents 槽）：把窗口交给本地服务，并带上 #focus
// 让服务页知道该把哪一段排在前面（agents 槽看会话，usage 槽看额度）。
// hash 跨 location.replace 保留，服务页 app.js 读它。
(async () => {
  await magpie.ready;
  const base = magpie.service ? new URL(magpie.service, location.href) : new URL("http://127.0.0.1:3477/");
  base.hash = "focus=agents";
  location.replace(base.href);
})();
