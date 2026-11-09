// ChatGPT's sentinel proof of work.
//
// The proof token is a pure local hash -- the upstream sdk.js is never needed.
// A 25-element browser fingerprint is built, cut into three pieces, and an
// index is searched until sha3-512(seed + candidate) sorts at or below the
// difficulty. Note what the comparison is: the first N bytes compared
// bytewise, NOT a count of leading zeroes. Mining intuition solves nothing
// here.

import { createHash, randomUUID } from "node:crypto";

export const REQUIREMENTS_PREFIX = "gAAAAAC";
export const PROOF_PREFIX = "gAAAAAB";
export const DEFAULT_POW_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js";

const CORES = [8, 16, 24, 32];
const DOCUMENT_KEYS = ["__reactContainer$fzelfjyxej8", "_reactListening5dehydibo78", "location"];
const SCREENS = [
  [1920, 1080],
  [1440, 900],
  [2560, 1440],
  [3840, 2160],
];

const NAVIGATOR_KEYS = [
  "registerProtocolHandler\u2212function registerProtocolHandler() { [native code] }",
  "storage\u2212[object StorageManager]",
  "locks\u2212[object LockManager]",
  "appCodeName\u2212Mozilla",
  "permissions\u2212[object Permissions]",
  "share\u2212function share() { [native code] }",
  "webdriver\u2212false",
  "managed\u2212[object NavigatorManagedData]",
  "canShare\u2212function canShare() { [native code] }",
  "vendor\u2212Google Inc.",
  "mediaDevices\u2212[object MediaDevices]",
  "vibrate\u2212function vibrate() { [native code] }",
  "storageBuckets\u2212[object StorageBucketManager]",
  "mediaCapabilities\u2212[object MediaCapabilities]",
  "cookieEnabled\u2212true",
  "virtualKeyboard\u2212[object VirtualKeyboard]",
  "product\u2212Gecko",
  "presentation\u2212[object Presentation]",
  "onLine\u2212true",
  "mimeTypes\u2212[object MimeTypeArray]",
  "credentials\u2212[object CredentialsContainer]",
  "serviceWorker\u2212[object ServiceWorkerContainer]",
  "keyboard\u2212[object Keyboard]",
  "gpu\u2212[object GPU]",
  "doNotTrack",
  "serial\u2212[object Serial]",
  "pdfViewerEnabled\u2212true",
  "language\u2212zh-CN",
  "geolocation\u2212[object Geolocation]",
  "userAgentData\u2212[object NavigatorUAData]",
  "getUserMedia\u2212function getUserMedia() { [native code] }",
  "sendBeacon\u2212function sendBeacon() { [native code] }",
  "hardwareConcurrency\u221232",
  "windowControlsOverlay\u2212[object WindowControlsOverlay]",
];

const WINDOW_KEYS = [
  "0", "window", "self", "document", "name", "location", "customElements", "history",
  "navigation", "innerWidth", "innerHeight", "scrollX", "scrollY", "visualViewport",
  "screenX", "screenY", "outerWidth", "outerHeight", "devicePixelRatio", "screen",
  "chrome", "navigator", "onresize", "performance", "crypto", "indexedDB",
  "sessionStorage", "localStorage", "scheduler", "alert", "atob", "btoa", "fetch",
  "matchMedia", "postMessage", "queueMicrotask", "requestAnimationFrame",
  "setInterval", "setTimeout", "caches", "__NEXT_DATA__", "__BUILD_MANIFEST",
  "__NEXT_PRELOADREADY",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The upstream stamps a fixed -05:00 clock; daylight saving is not followed. */
export function legacyTime(epochMs) {
  const d = new Date(epochMs - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    WEEKDAYS[d.getUTCDay()] + " " + MONTHS[d.getUTCMonth()] + " " + pad(d.getUTCDate()) + " " +
    d.getUTCFullYear() + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds())
  );
}

/** Python's float repr differs from JavaScript only in exponent padding. */
export function pyNumber(value) {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
  const s = String(value);
  const match = /^([^eE]+)[eE]([+-])(\d+)$/.exec(s);
  if (!match) return s;
  return match[1] + "e" + match[2] + (match[3].length < 2 ? match[3].padStart(2, "0") : match[3]);
}

/** Equivalent to Python's json.dumps(v, separators=(",", ":"), ensure_ascii=False). */
export function pyJson(values) {
  return "[" + values.map((item) => (typeof item === "number" ? pyNumber(item) : JSON.stringify(item))).join(",") + "]";
}

const pick = (items, random) => items[Math.min(items.length - 1, Math.floor(random() * items.length))];

/** The 25-element fingerprint. Its order and length are part of the protocol. */
export function buildConfig(userAgent, resources = {}, deps = {}) {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => performance.now());
  const epoch = deps.epoch ?? (() => Date.now());
  const uuid = deps.uuid ?? (() => randomUUID());

  const scripts = resources.scriptSources?.length ? resources.scriptSources : [DEFAULT_POW_SCRIPT];
  const script = pick(scripts, random);
  const screen = pick(SCREENS, random);
  const perf = now();

  return [
    screen[0] + screen[1],
    legacyTime(epoch()),
    4294705152,
    1,
    userAgent,
    script,
    resources.dataBuild ?? "",
    "en-US",
    "en-US,es-US,en,es",
    random(),
    pick(NAVIGATOR_KEYS, random),
    pick(DOCUMENT_KEYS, random),
    pick(WINDOW_KEYS, random),
    perf,
    uuid(),
    "",
    pick(CORES, random),
    epoch() - perf,
    0, 0, 0, 0, 0, 0, 0,
  ];
}

/** The "p" the prepare step takes: the fingerprint, base64ed. No solving yet. */
export function requirementsToken(userAgent, resources = {}, deps = {}) {
  return REQUIREMENTS_PREFIX + Buffer.from(pyJson(buildConfig(userAgent, resources, deps)), "utf8").toString("base64");
}

/**
 * Solve the proof. The middle of the config is split so an index and its half
 * can be spliced in without re-serializing the array each round.
 */
export async function solveProof(seed, difficulty, userAgent, resources = {}, deps = {}, limit = 500000) {
  const config = buildConfig(userAgent, resources, deps);
  const seedBuf = Buffer.from(seed, "utf8");

  const head = pyJson(config.slice(0, 3));
  const mid = pyJson(config.slice(4, 9));
  const tail = pyJson(config.slice(10));
  const piece1 = Buffer.from(head.slice(0, -1) + ",", "utf8");
  const piece2 = Buffer.from("," + mid.slice(1, -1) + ",", "utf8");
  const piece3 = Buffer.from("," + tail.slice(1), "utf8");

  if (!/^[0-9a-fA-F]*$/.test(difficulty) || difficulty.length % 2 !== 0) {
    throw new Error("chatgpt: the difficulty is not a hexadecimal string");
  }
  const target = Buffer.from(difficulty, "hex");
  const width = target.length;

  for (let i = 0; i < limit; i += 1) {
    const answer = Buffer.concat([
      piece1,
      Buffer.from(String(i), "utf8"),
      piece2,
      Buffer.from(String(i >> 1), "utf8"),
      piece3,
    ]).toString("base64");

    const digest = createHash("sha3-512").update(Buffer.concat([seedBuf, Buffer.from(answer, "utf8")])).digest();
    if (Buffer.compare(digest.subarray(0, width), target) <= 0) {
      return { token: PROOF_PREFIX + answer, iterations: i + 1 };
    }
    if (i > 0 && i % 5000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("chatgpt: the proof did not solve within " + limit + " rounds (difficulty " + difficulty + ")");
}

/** Page HTML to the script list and data-build the fingerprint wants. */
export function parseResources(html) {
  const scriptSources = [];
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) scriptSources.push(match[1]);

  let dataBuild = "";
  for (const src of scriptSources) {
    const build = /c\/[^/]*\/_/.exec(src);
    if (build) {
      dataBuild = build[0];
      break;
    }
  }
  if (!dataBuild) {
    const attr = /<html[^>]*data-build=["']([^"']*)["']/i.exec(html);
    if (attr) dataBuild = attr[1];
  }
  return { scriptSources: scriptSources.length ? scriptSources : [DEFAULT_POW_SCRIPT], dataBuild };
}
