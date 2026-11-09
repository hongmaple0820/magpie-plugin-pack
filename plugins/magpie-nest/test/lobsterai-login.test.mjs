import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loginUrl,
  parseCallback,
  startLoginSession,
  takeSession,
  clearSessions,
  exchangeAuthCode,
} from "../lib/lobsterai/login.mjs";

beforeEach(() => clearSessions());

test("the login url keeps its hash route and encodes the redirect", () => {
  const url = loginUrl("state-1", 58123);
  assert.ok(url.startsWith("https://lobsterai.youdao.com/portal#/login?"));
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.equal(query.get("source"), "electron");
  assert.equal(query.get("state"), "state-1");
  assert.equal(query.get("redirect_uri"), "http://127.0.0.1:58123/auth/callback");
});

test("a pasted address yields its code and state", () => {
  assert.deepEqual(parseCallback("http://127.0.0.1:58123/auth/callback?code=abc&state=s1"), {
    code: "abc",
    state: "s1",
  });
});

test("a bare code is taken as the code", () => {
  assert.deepEqual(parseCallback("abc123"), { code: "abc123" });
  assert.deepEqual(parseCallback(""), {});
});

test("the state names the sign-in it belongs to, once", () => {
  const session = startLoginSession();
  assert.match(session.firstKeyfrom, /^\d{13}$/);
  const taken = takeSession(session.state);
  assert.equal(taken.uuid, session.uuid);
  // spent once
  assert.equal(takeSession(session.state), undefined);
});

test("a bare code falls back to the only sign-in in flight", () => {
  const session = startLoginSession();
  const taken = takeSession("");
  assert.equal(taken.uuid, session.uuid);
});

test("an expired sign-in is not taken", () => {
  const session = startLoginSession(Date.now() - 16 * 60 * 1000);
  assert.equal(takeSession(session.state), undefined);
});

const exchangeOk = async () =>
  Response.json({
    code: 0,
    data: { accessToken: "AT", refreshToken: "RT", expiresIn: 3600, user: { id: "u1", nickname: "阿枫" } },
  });

test("the exchange sends the five fields the endpoint takes", async () => {
  let seen;
  const fetcher = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), headers: init.headers };
    return exchangeOk();
  };
  const credential = await exchangeAuthCode("CODE", { uuid: "U", firstKeyfrom: "1000" }, fetcher);
  assert.equal(seen.url, "https://lobsterai-server.youdao.com/api/auth/exchange");
  assert.equal(seen.body.authCode, "CODE");
  assert.equal(seen.body.uuid, "U");
  assert.equal(seen.body.firstKeyfrom, "1000");
  assert.equal(seen.body.version, "2026.9.4");
  assert.ok(seen.body.latestKeyfrom);
  // no Authorization: this call is how a token is obtained
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(credential.accessToken, "AT");
  assert.equal(credential.refreshToken, "RT");
  assert.equal(credential.nickname, "阿枫");
  assert.equal(credential.expiresIn, 3600);
});

test("a failure envelope is refused rather than stored", async () => {
  const fetcher = async () => Response.json({ code: 40001, msg: "code expired" });
  await assert.rejects(() => exchangeAuthCode("C", { uuid: "U", firstKeyfrom: "1" }, fetcher), /code expired/);
});

test("an envelope without an accessToken is refused", async () => {
  const fetcher = async () => Response.json({ code: 0, data: { refreshToken: "RT" } });
  await assert.rejects(() => exchangeAuthCode("C", { uuid: "U", firstKeyfrom: "1" }, fetcher), /accessToken/);
});
