// 设置页入口（magpie.panels 的 settings 槽）：只显示设置分区。
(async () => {
  await magpie.ready;
  const base = magpie.service ? new URL(magpie.service, location.href) : new URL("http://127.0.0.1:3477/");
  base.hash = "focus=settings";
  location.replace(base.href);
})();
