// Browser discovery, launch and teardown for the web-login engine. The user
// signs in inside a real, visible Chrome/Edge window on a profile kept per
// channel (so a repeat login usually sees the remembered session and needs
// no click at all); the engine attaches over the DevTools port and watches
// until the channel's token shows up. The window closes itself afterwards.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser(override) {
  const candidates = [];
  const push = (p) => {
    if (p) candidates.push(p);
  };
  push(override ?? process.env.MAGPIE_NEST_BROWSER);
  push("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  push("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
  if (process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
  }
  push("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  push("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
  for (const exe of candidates) {
    try {
      fs.accessSync(exe, fs.constants.X_OK);
      return exe;
    } catch {}
  }
  return null;
}

export function profileDirFor(channelId) {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "magpie-nest-weblogin", channelId);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export function launchBrowser({ exe, profileDir, port, startUrl, launchArgs = [] }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    ...launchArgs,
    "--user-data-dir=" + profileDir,
    "--remote-debugging-port=" + port,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    startUrl,
  ];
  return spawn(exe, args, { stdio: "ignore" });
}

/**
 * 每次探测都带自己的超时：只靠 deadline 检查是不够的——fetch 本身若挂住
 * （Chrome 起了但 DevTools 端点不答），循环永远走不到那行检查。
 */
export async function waitCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/version", {
        signal: AbortSignal.timeout(Math.max(500, Math.min(2000, deadline - Date.now()))),
      });
      if (res.ok) return await res.json();
    } catch {}
    if (Date.now() > deadline) {
      throw new Error("browser: CDP 端口 " + port + " 在 " + Math.round(timeoutMs / 1000) + " 秒内没有响应");
    }
    await sleep(200);
  }
}

export async function listTargets(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list", {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error("browser: /json/list " + res.status);
  return await res.json();
}

export async function killBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      const done = () => resolve();
      tk.on("close", done);
      tk.on("error", done);
      setTimeout(done, 3000).unref?.();
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 3000).unref?.();
  });
}
