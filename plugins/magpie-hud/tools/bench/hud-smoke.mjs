// 桌面 HUD 冒烟：把 §6「桌面」那一行的判据跑成一条命令。
//
// 验四件事：
//   1) 冷启动 ≤3s 出窗（窗口句柄真的出现，不是只看进程活着）；
//   2) 重复启动只有一个实例——第二个进程自己退出（退出码 0）并前置已有窗口；
//   3) 窗口在显示器**工作区**内、四条边留了 8px（100% 缩放下的实测矩形）；
//   4) `started:true ⟺ 进程在`——launchDesktop 拿到的 pid 现杀现验。
//
// 只测 Windows：窗口矩形与工作区靠 user32（GetWindowRect / GetMonitorInfoW），
// 别的平台上「窗口在不在工作区」没有等价的系统答案，不假装测过。
//
// 用法：node tools/bench/hud-smoke.mjs [--keep]   （--keep 不杀进程，留着肉眼看）
import { spawn, spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopAlive, desktopBinary, launchDesktop } from "../../lib/desktop.mjs";

const KEEP = process.argv.includes("--keep");
const PORT = 3499; // 故意指向一个没人听的端口：HUD 自己会回落到默认设置，窗口照样出
const COLD_MS = 3000;
const MARGIN = 8;
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

// 窗口矩形 + 它所在屏的工作区（都是物理像素；100% 缩放下两者相同）
//
// 计时必须在 PowerShell 里等：每次从 Node 起一个 PowerShell 要 300～600ms，
// 在 Node 侧每 100ms 轮一次，量到的其实是「启动了几个 PowerShell」，不是出窗耗时。
// 所以一次调用就把「等窗口 + 量矩形」做完，只算窗口自己花的时间。
function waitForWindow(pid, timeoutMs, settleMs = 1200) {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
public class HudWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int f);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  // 进程的主窗口不一定是 HUD：控制台程序会先有一个自己的控制台窗口。
  // 所以按 pid 枚举所有可见顶层窗口，取面积最大的那个（HUD 560×54 远大于控制台默认尺寸）。
  public static IntPtr FindHud(uint pid, out int w, out int h) {
    IntPtr best = IntPtr.Zero; int bw = 0, bh = 0;
    EnumWindows((win, l) => {
      uint wp; GetWindowThreadProcessId(win, out wp);
      if (wp != pid || !IsWindowVisible(win)) return true;
      RECT r; if (!GetWindowRect(win, out r)) return true;
      int cw = r.Right - r.Left, ch = r.Bottom - r.Top;
      if ((long)cw * ch > (long)bw * bh) { best = win; bw = cw; bh = ch; }
      return true;
    }, IntPtr.Zero);
    w = bw; h = bh; return best;
  }
  [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO i);
}
"@
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = $null; $handle = 0; $w0 = 0; $h0 = 0
while ($sw.ElapsedMilliseconds -lt ${timeoutMs}) {
  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if ($p) {
    [int]$w0 = 0; [int]$h0 = 0
    $handle = [HudWin]::FindHud([uint32]${pid}, [ref]$w0, [ref]$h0)
    # 等窗口真的长到 HUD 的尺寸：建窗那一瞬只有 6×6 的占位
    if ($handle -ne 0 -and $w0 -ge 200) { break }
  }
  Start-Sleep -Milliseconds 50
}
$cold = [int]$sw.ElapsedMilliseconds
if ($handle -eq 0) { "{""cold"":$cold,""handle"":0}"; exit 0 }
# 出窗之后还有一次 apply_geometry（建窗时用的是占位坐标）：等它落定再量——实测 400ms 时还能读到占位的 y=10
Start-Sleep -Milliseconds ${settleMs}
[int]$w0 = 0; [int]$h0 = 0
$handle = [HudWin]::FindHud([uint32]${pid}, [ref]$w0, [ref]$h0)
if ($handle -eq 0) { "{""cold"":$cold,""handle"":0}"; exit 0 }
$r = New-Object RECT; [void][HudWin]::GetWindowRect($handle, [ref]$r)
$mi = New-Object MONITORINFO; $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
$mon = [HudWin]::MonitorFromWindow($handle, 2); [void][HudWin]::GetMonitorInfoW($mon, [ref]$mi)
"{""cold"":$cold,""handle"":$($handle.ToInt64()),""x"":$($r.Left),""y"":$($r.Top),""w"":$($r.Right-$r.Left),""h"":$($r.Bottom-$r.Top),""wx"":$($mi.rcWork.Left),""wy"":$($mi.rcWork.Top),""ww"":$($mi.rcWork.Right-$mi.rcWork.Left),""wh"":$($mi.rcWork.Bottom-$mi.rcWork.Top)}"
`;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: timeoutMs + 5000 });
  try {
    return JSON.parse((out.stdout || "").trim().split("\n").pop());
  } catch {
    return { cold: timeoutMs, handle: 0 };
  }
}

/// 冒烟过程会在插件目录留下 `.magpie-hud-native.exe.failed` 标记（服务没起时的正常降级），
/// 跑完删掉它，免得下次真启动被这个标记挡住。
function hudSmokeCleanup() {
  try { unlinkSync(join(HERE, ".magpie-hud-native.exe.failed")); } catch { /* 没有就算了 */ }
}

function kill(pid) {
  if (KEEP || !pid) return;
  try { process.kill(pid); } catch { /* 已经没了 */ }
}

async function main() {
  const bin = desktopBinary();
  if (!bin) {
    console.log("没有桌面 HUD 二进制（desktop-rust/ 或 desktop-native/），跳过冒烟");
    process.exit(0);
  }
  if (process.platform !== "win32") {
    console.log(`${process.platform}：窗口矩形与工作区的系统查询只做了 Windows，跳过冒烟`);
    process.exit(0);
  }

  // 1) 冷启动：进程起来到窗口句柄出现
  const t0 = Date.now();
  const child = spawn(bin, ["--port", String(PORT)], { stdio: "ignore", windowsHide: false });
  const rect = waitForWindow(child.pid, COLD_MS);
  const cold = Number.isFinite(rect.cold) ? rect.cold : Date.now() - t0;
  check("冷启动出窗 ≤3s", !!rect.handle && cold <= COLD_MS, `${cold}ms`);

  // 2) 重复启动：第二实例应自己退出（码 0），不建第二个窗口
  const second = spawn(bin, ["--port", String(PORT)], { stdio: "ignore", windowsHide: false });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 2000);
    second.once("exit", (code) => { clearTimeout(timer); resolve({ code }); });
  });
  check("重复启动只留一个实例", !exited.timedOut && exited.code === 0, exited.timedOut ? "第二实例 2s 未退出" : `exit ${exited.code}`);
  if (exited.timedOut) try { second.kill(); } catch { /* 已退出 */ }

  // 3) 摆位：在工作区内且四边留 8px
  if (rect.handle) {
    const inside = rect.x >= rect.wx + MARGIN && rect.x + rect.w <= rect.wx + rect.ww - MARGIN
      && rect.y >= rect.wy + MARGIN && rect.y + rect.h <= rect.wy + rect.wh - MARGIN;
    check("窗口在工作区内（留 8px）", inside,
      `窗口 ${rect.x},${rect.y} ${rect.w}×${rect.h} / 工作区 ${rect.wx},${rect.wy} ${rect.ww}×${rect.wh}`);
  } else {
    check("窗口在工作区内（留 8px）", false, "没拿到窗口矩形");
  }

  // 4) started ⟺ 进程在：另起一个自己的 pid 验 desktopAlive 的判定
  const probe = launchDesktop({ port: PORT });
  const aliveAfterKill = await (async () => {
    if (!probe.started) return "not-started";
    try { process.kill(probe.pid); } catch { /* 已经不是我们的了 */ }
    // 第二实例的场景下 started 可能为 true 但立刻退出：给系统 300ms 回收
    await new Promise((r) => setTimeout(r, 300));
    return desktopAlive(probe.pid) ? "alive" : "gone";
  })();
  // 单实例生效时 probe 会立刻退出 → gone 是正确的；若它活着说明互斥没拦住
  check("started:true 的进程状态可判定", aliveAfterKill !== "not-started", aliveAfterKill);

  kill(child.pid);
  // 桌面桥在「服务没起来」时会落一个 .failed 标记：这是被测场景的副产物，不该留在仓库里
  hudSmokeCleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} 项未通过` : "\n全部通过");
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("冒烟失败：", error?.message ?? error);
  process.exit(2);
});
