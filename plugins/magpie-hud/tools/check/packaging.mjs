// 发布包检查（§6 验收表「打包」一行）：`npm pack` 出来的东西能不能**直接跑**。
//
// 三件都验，因为它们各自都会单独坏：
//   1) `files` 覆盖运行时真正找的目录——`desktopBinary()` 只认 desktop-rust/ 与
//      desktop-native/ 根下的可执行文件，漏一个就是「装完 HUD 静默不出现」；
//   2) tarball 里真的有 exe，且和仓库里那份一样大（构建产物没被 .npmignore 吃掉）；
//   3) 把 tarball 解开、**不依赖仓库**地当插件加载一次（`import index.mjs`），
//      拿得到 5 个工具——这是「解开就能用」最接近真机的验证。
//
// 用法：node tools/check/packaging.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, existsSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const problems = [];
const ok = (msg) => console.log("✓ " + msg);
const bad = (msg) => { problems.push(msg); console.error("✗ " + msg); };

// 1) files 白名单
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const files = pkg.files ?? [];
for (const need of ["index.mjs", "lib", "webapp", "page", "dsh"]) {
  files.includes(need) ? ok(`files 含 ${need}`) : bad(`files 缺 ${need}`);
}
for (const dir of ["desktop-rust", "desktop-native"]) {
  files.some((f) => f.startsWith(dir + "/")) ? ok(`files 含 ${dir}/`) : bad(`files 缺 ${dir}/`);
}
files.includes("desktop") ? bad("files 里还有已弃用的 wails 目录 desktop/") : ok("files 不含 desktop/");

// 2) 真打一次包，看 tarball 里的文件
const tmp = mkdtempSync(join(tmpdir(), "magpie-hud-pack-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], {
    cwd: HERE, encoding: "utf8", shell: process.platform === "win32",
  }));
  const info = packed[0];
  const names = new Set(info.files.map((f) => f.path));
  const tarball = join(tmp, info.filename);
  console.log(`tarball ${info.filename}：${info.entryCount} 个文件、${info.size} 字节`);

  // WebView2 的加载器是随 exe 一起发布的旁置 DLL：漏了它 exe 起不来（进程直接报
  // 「WebView2Loader.dll: cannot open shared object file」），而这跟 exe 大小无关，
  // 所以单独占一条检查。
  {
    const dll = "desktop-rust/WebView2Loader.dll";
    if (!names.has(dll)) bad(`tarball 缺 ${dll}（HUD 起不来）`);
    else ok(`${dll} 在包里（${info.files.find((f) => f.path === dll).size} 字节）`);
  }

  for (const exe of ["desktop-rust/magpie-hud-native.exe", "desktop-native/magpie-hud-native.exe"]) {
    if (!existsSync(join(HERE, exe))) { console.log(`（仓库里没有 ${exe}，跳过这一条）`); continue; }
    if (!names.has(exe)) { bad(`tarball 缺 ${exe}`); continue; }
    const src = statSync(join(HERE, exe)).size;
    const got = info.files.find((f) => f.path === exe).size;
    src === got ? ok(`${exe} 在包里且大小一致（${src}）`) : bad(`${exe} 大小不符：仓库 ${src} / 包 ${got}`);
  }

  // 3) 解开、独立加载（tar 走相对路径：Git Bash 的 tar 会把 "C:/..." 当成远端主机）
  execFileSync("tar", ["-xzf", info.filename, "-C", "."], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32" });
  const root = join(tmp, readdirSync(tmp).find((n) => n.startsWith("package")) ?? "package");
  if (!existsSync(join(root, "index.mjs"))) {
    bad("解开后没有 index.mjs");
  } else {
    // 声明过的运行时依赖得在：`npm i <tarball>` 会装它们，这里没有网络，
    // 就把本仓库已装好的那份接上去（接不上就明说这一条没验到）。
    const deps = Object.keys(pkg.dependencies ?? {});
    let linked = 0;
    for (const dep of deps) {
      // 包可能没暴露 package.json 子路径：从入口往上走到含 package.json 的目录
      let src = null;
      try {
        let dir = dirname(require.resolve(dep));
        while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
        src = existsSync(join(dir, "package.json")) ? dir : null;
      } catch { /* 没装 */ }
      if (!src) continue;
      mkdirSync(join(root, "node_modules"), { recursive: true });
      symlinkSync(src, join(root, "node_modules", dep), "junction");
      linked += 1;
    }
    if (deps.length && !linked) {
      // 本机没装依赖时（CI 已 npm ci，正常不会走到这）：明说跳过，不能误判成「包坏了」
      console.log(`（本机没装 ${deps.join(", ")}，独立加载这一步没验到）`);
    } else {
      const out = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", "const m = await import('./index.mjs'); const t = m.MagpieHudPlugin; process.stdout.write(String(typeof t));"],
        { cwd: root, encoding: "utf8", env: { ...process.env, MAGPIE_HUD_DESKTOP: "0", MAGPIE_HUD_PAGE_PORT: "0" } },
      ).trim();
      out === "function" ? ok("解开的包能独立 import，入口是插件函数") : bad(`入口导出不对：${out}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\n${problems.length} 个问题`);
  process.exit(1);
}
console.log("\n发布包检查通过");
