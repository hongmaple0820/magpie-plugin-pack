/**
 * 跨平台遍历 plugins/* 跑每个插件的 npm test。
 * 用法: node scripts/test-all.mjs   （Windows / macOS / Linux 均可）
 * 不依赖任何 npm 包；插件目录只需有 package.json 且声明了 test 脚本。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "plugins");

const dirs = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(pluginsDir, entry.name))
  .filter((dir) => existsSync(join(dir, "package.json")));

if (dirs.length === 0) {
  console.error("plugins/ 下没有含 package.json 的插件目录");
  process.exit(1);
}

let failed = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const name = pkg.name || dir.split(/[\\/]/).pop();
  if (!pkg.scripts || !pkg.scripts.test) {
    console.log(`==> ${name}: 跳过（没有 test 脚本）`);
    continue;
  }
  console.log(`\n==> ${name}`);
  // shell:true 让 Windows 下也能解析 npm.cmd；命令是固定字符串，无注入风险。
  const run = spawnSync("npm test", { cwd: dir, stdio: "inherit", shell: true });
  if (run.status !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} 个插件测试失败`);
  process.exit(1);
}
console.log("\n全部插件测试通过");
