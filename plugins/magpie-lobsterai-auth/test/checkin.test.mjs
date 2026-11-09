import { test } from "node:test";
import assert from "node:assert/strict";
import { checkinOf, resolveClientVersion, fetchSlot, fetchContext, claim } from "../lib/checkin.mjs";

const CREDS = { token: "T" };

function fake({ slot, context, claimResult, version = "2026.9.4", slotStatus = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    if (String(url).includes("openapi/get")) return Response.json({ code: 0, data: { value: version } });
    if (String(url).includes("/slot")) {
      if (slotStatus !== 200) return new Response("nope", { status: slotStatus });
      return Response.json({ code: 0, data: slot });
    }
    if (String(url).includes("/context")) return Response.json({ code: 0, data: context });
    if (String(url).includes("/actions/check_in")) return Response.json({ code: 0, data: { result: claimResult } });
    return new Response("unexpected", { status: 500 });
  };
  return { fetcher, calls };
}

const SLOT = { slotState: "available", activity: { activityCode: "ACT1", configRevision: 7 } };

test("a claimable activity is claimed and its credits reported", async () => {
  const { fetcher, calls } = fake({
    slot: SLOT,
    context: { state: { claimedToday: false }, actions: ["check_in"] },
    claimResult: { creditsGranted: 10 },
  });
  const result = await checkinOf(CREDS, fetcher);
  assert.equal(result.outcome, "claimed");
  assert.equal(result.credit, 10);
  const posted = calls.find((c) => c.url.includes("/actions/check_in"));
  assert.equal(posted.method, "POST");
  const body = JSON.parse(posted.body);
  assert.equal(body.configRevision, 7);
  assert.ok(body.idempotencyKey);
});

test("the amount falls back through the three field names", async () => {
  for (const [field, value] of [["rewardCredits", 7], ["credits", 3]]) {
    const { fetcher } = fake({
      slot: SLOT,
      context: { state: { claimedToday: false }, actions: ["check_in"] },
      claimResult: { [field]: value },
    });
    assert.equal((await checkinOf(CREDS, fetcher)).credit, value);
  }
});

test("an already claimed day is done, never a second claim", async () => {
  const { fetcher, calls } = fake({
    slot: SLOT,
    context: { state: { claimedToday: true }, actions: ["check_in"] },
    claimResult: {},
  });
  assert.equal((await checkinOf(CREDS, fetcher)).outcome, "done");
  assert.equal(calls.some((c) => c.url.includes("/actions/check_in")), false);
});

test("an activity without the check_in action is ineligible", async () => {
  const { fetcher, calls } = fake({ slot: SLOT, context: { state: {}, actions: ["share"] }, claimResult: {} });
  assert.equal((await checkinOf(CREDS, fetcher)).outcome, "ineligible");
  assert.equal(calls.some((c) => c.url.includes("/actions/check_in")), false);
});

test("no running activity is inactive, not a failure", async () => {
  const { fetcher } = fake({ slot: { slotState: "closed" }, context: {}, claimResult: {} });
  assert.equal((await checkinOf(CREDS, fetcher)).outcome, "inactive");
});

test("an unreadable slot is a failure", async () => {
  const { fetcher } = fake({ slotStatus: 500 });
  assert.equal((await checkinOf(CREDS, fetcher)).outcome, "failed");
});

test("no credential is a failure, not a crash", async () => {
  assert.equal((await checkinOf(undefined)).outcome, "failed");
});

test("the client version falls back when the update endpoint is unreachable", async () => {
  const fetcher = async () => {
    throw new Error("offline");
  };
  assert.equal(await resolveClientVersion(fetcher), "2026.9.4");
});

test("the slot query carries the four fixed parameters", async () => {
  let seen = "";
  const fetcher = async (url) => {
    seen = String(url);
    return Response.json({ code: 0, data: SLOT });
  };
  await fetchSlot(CREDS, "2026.9.4", fetcher);
  const query = new URLSearchParams(seen.slice(seen.indexOf("?") + 1));
  assert.equal(query.get("placement"), "desktop_sidebar");
  assert.equal(query.get("containerApiVersion"), "2");
  assert.equal(query.get("platform"), "win32");
  assert.equal(query.get("clientVersion"), "2026.9.4");
});

test("the context carries the revision the slot reported", async () => {
  let seen = "";
  const fetcher = async (url) => {
    seen = String(url);
    return Response.json({ code: 0, data: { state: {}, actions: [] } });
  };
  await fetchContext(CREDS, { activityCode: "A 1", configRevision: 7 }, fetcher);
  assert.ok(seen.includes("/A%201/context"));
  assert.ok(seen.includes("configRevision=7"));
});
