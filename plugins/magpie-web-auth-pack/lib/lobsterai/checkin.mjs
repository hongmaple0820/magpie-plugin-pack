// The daily check-in: four reads, one claim, and a client that must decide
// whether claiming is even allowed before it claims.
//
// The idempotency is ours, not the server's: the claim carries a fresh
// idempotency key, so claiming blindly every run is how an account gets
// noticed. The context read says whether today is claimed and whether
// check_in is among the actions available now -- both, not one: an activity can
// exist and be unclaimable today.

import { randomUUID } from "node:crypto";
import { ACTIVITY_BASE, API_BASE, CLIENT_VERSION, CLIENT_VERSION_API } from "./constants.mjs";
import { unwrapEnvelope, readString, readNumber, requestJson } from "./http.mjs";

const SLOT_QUERY = { placement: "desktop_sidebar", containerApiVersion: "2", platform: "win32" };

/**
 * The client version is a required slot parameter, but the server does not
 * hard-validate it: a failed lookup falls back rather than failing the whole
 * check-in.
 */
export async function resolveClientVersion(fetcher = fetch, timeoutMs = 5000) {
  try {
    const response = await fetcher(CLIENT_VERSION_API, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return CLIENT_VERSION;
    const data = unwrapEnvelope(await response.json());
    return readString(data, "value") || CLIENT_VERSION;
  } catch {
    return CLIENT_VERSION;
  }
}

export async function fetchSlot(creds, clientVersion, fetcher = fetch) {
  const query = new URLSearchParams({ ...SLOT_QUERY, clientVersion });
  const result = await requestJson(fetcher, API_BASE + ACTIVITY_BASE + "/slot?" + query.toString(), {
    token: creds.token,
  });
  const data = unwrapEnvelope(result.body);
  if (data === undefined) return undefined;
  const activity = typeof data.activity === "object" && data.activity !== null ? data.activity : {};
  return {
    slotState: readString(data, "slotState"),
    activityCode: readString(activity, "activityCode"),
    configRevision: readNumber(activity, "configRevision") ?? 0,
  };
}

export async function fetchContext(creds, slot, fetcher = fetch) {
  const query = new URLSearchParams({ configRevision: String(slot.configRevision) });
  const url = API_BASE + ACTIVITY_BASE + "/" + encodeURIComponent(slot.activityCode) + "/context?" + query.toString();
  const result = await requestJson(fetcher, url, { token: creds.token });
  const data = unwrapEnvelope(result.body);
  if (data === undefined) return undefined;
  const state = typeof data.state === "object" && data.state !== null ? data.state : {};
  return {
    claimedToday: state.claimedToday === true,
    actions: Array.isArray(data.actions) ? data.actions.filter((item) => typeof item === "string") : [],
  };
}

export async function claim(creds, slot, fetcher = fetch) {
  const url = API_BASE + ACTIVITY_BASE + "/" + encodeURIComponent(slot.activityCode) + "/actions/check_in";
  const result = await requestJson(fetcher, url, {
    method: "POST",
    token: creds.token,
    body: { configRevision: slot.configRevision, idempotencyKey: randomUUID(), payload: {} },
  });
  const data = unwrapEnvelope(result.body);
  if (data === undefined) return undefined;
  const claimed = typeof data.result === "object" && data.result !== null ? data.result : {};
  // Activity versions disagree on the field that carries the amount.
  for (const key of ["creditsGranted", "rewardCredits", "credits"]) {
    const value = readNumber(claimed, key);
    if (value !== undefined) return value;
  }
  return 0;
}

/**
 * Run one account's check-in and answer magpie's outcome vocabulary:
 * claimed / done / ineligible / inactive / captcha / failed.
 */
export async function checkinOf(creds, fetcher = fetch) {
  if (!creds?.token) return { outcome: "failed", message: "lobsterai: not signed in" };
  try {
    return await runCheckin(creds, fetcher);
  } catch (error) {
    // A read that fails is a failed check-in, not a broken plugin: magpie
    // retries a failure on its own schedule.
    return { outcome: "failed", message: String(error?.message ?? error) };
  }
}

async function runCheckin(creds, fetcher) {
  const clientVersion = await resolveClientVersion(fetcher);
  const slot = await fetchSlot(creds, clientVersion, fetcher);
  if (slot === undefined) return { outcome: "failed", message: "the activity slot could not be read" };
  if (!slot.activityCode) return { outcome: "inactive", message: "no check-in activity is running" };
  if (slot.slotState && slot.slotState !== "available") {
    return { outcome: "inactive", message: "the check-in slot is not available now (" + slot.slotState + ")" };
  }

  const context = await fetchContext(creds, slot, fetcher);
  if (context === undefined) return { outcome: "failed", message: "the activity context could not be read" };
  if (context.claimedToday) return { outcome: "done", message: "already checked in today" };
  if (!context.actions.includes("check_in")) {
    return { outcome: "ineligible", message: "this activity cannot be claimed now" };
  }

  const credit = await claim(creds, slot, fetcher);
  if (credit === undefined) return { outcome: "failed", message: "the claim was refused" };
  return { outcome: "claimed", credit, message: credit > 0 ? "checked in, +" + credit : "checked in" };
}
