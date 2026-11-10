// One-click web login, shared by the nest's browser-login channels: a real
// Chrome/Edge window opens on the channel's site, the user signs in there,
// and the engine (CDP over the DevTools port) watches until the channel's
// token appears, then closes the window and lands the sign-in.
//
// Wiring to magpie's host: an oauth method whose authorize returns a blank
// url (the host runs callback in the background, no page to paste into),
// same shape as inkstone's client import. The window is the whole UI.

import { findBrowser, freePort, killProfileHolders, launchBrowser, killBrowser, profileDirFor, waitCdp } from "./browser.mjs";
import { cdpWatch } from "./cdp.mjs";
import { webLoginChannel } from "./channels.mjs";

const INSTRUCTIONS = [
  "即将弹出浏览器窗口，请在里面正常完成登录（扫码 / 账号密码 / 手机验证码均可）。",
  "登录成功后插件会自动抓取登录令牌并关闭窗口，全程无需复制粘贴任何内容。",
  "每个渠道使用独立的浏览器配置目录：下次登录通常已记住会话，直接点登录即可。",
  "若窗口 4 分钟内没有完成登录，请检查网络或稍后重试。",
].join("\n");

export function webLoginMethod({ channel: channelId, label, fallbackToPaste = false }) {
  return {
    type: "oauth",
    label,
    async authorize(_inputs, context = {}) {
      const signal = context?.signal;
      return {
        url: "",
        instructions: INSTRUCTIONS,
        async callback(_value, ctx = {}) {
          const abortSignal = ctx?.signal ?? signal;
          return await runWebLogin(channelId, { signal: abortSignal });
        },
      };
    },
  };
}

async function runWebLogin(channelId, { signal } = {}) {
  const channel = webLoginChannel(channelId);
  if (!channel) {
    return { type: "failed", error: "browser login: 未知渠道 " + channelId };
  }

  const exe = findBrowser();
  if (!exe) {
    return {
      type: "failed",
      error: "browser login: 没找到 Chrome 或 Edge；安装其一，或设置 MAGPIE_NEST_BROWSER 指向浏览器可执行文件",
    };
  }

  let child = null;
  let port = null;
  // 总闸：任何一步挂住都不能让宿主永远等下去（登录是 background callback，
  // 没有宿主侧的时限兜底）。给抓取窗口留 30 秒启动余量。
  const budgetMs = (channel.timeoutMs ?? 240000) + 30000;
  try {
    port = await freePort();
    const profileDir = profileDirFor(channel.provider);
    // 同一 profile 的旧实例会把新实例变成空转发，端口永远不通。
    await killProfileHolders(profileDir);
    child = launchBrowser({
      exe,
      profileDir,
      port,
      startUrl: channel.loginUrl,
    });
    await withDeadline(waitCdp(port, 20000), 25000, "browser: 浏览器没有在 25 秒内就绪");
    const { token, cookieJar, fpQuery } = await withDeadline(cdpWatch({
      port,
      channelId,
      loginUrl: channel.loginUrl,
      targetDomains: channel.targetDomains,
      tokenSources: channel.tokenSources,
      timeoutMs: channel.timeoutMs ?? 240000,
      signal,
      extraCookies: channel.extraCookies,
      extraQuery: channel.extraQuery,
      triggerChat: channel.triggerChat,
    }), budgetMs, "browser login: " + channelId + " 登录超时（未检测到令牌）");
    return buildResult(token, channel, { cookieJar, fpQuery });
  } catch (error) {
    const message = error?.timeout
      ? "browser login: " + channelId + " 登录超时（4 分钟内未检测到令牌）；请重试或改用粘贴令牌"
      : "browser login: " + (error?.message || String(error));
    return { type: "failed", error: message };
  } finally {
    if (child) await killBrowser(child);
  }
}

function withDeadline(promise, ms, message) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { timeout: true })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function buildResult(token, channel, { cookieJar, fpQuery } = {}) {
  return {
    type: "success",
    access: token,
    refresh: token,
    key: token,
    expires: 0,
    accountId: "browser",
    label: channel.windowTitle || "浏览器一键登录",
    ...(cookieJar ? { cookieJar } : {}),
    ...(fpQuery && Object.keys(fpQuery).length ? { fpQuery: JSON.stringify(fpQuery) } : {}),
  };
}
