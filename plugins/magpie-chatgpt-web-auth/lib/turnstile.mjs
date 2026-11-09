// ChatGPT's turnstile token, computed locally.
//
// This is not a captcha service. The upstream sends an obfuscated program
// (base64, xor-ed with the requirements token); it is parsed into a token list
// and executed here by a tiny stack machine. The opcodes below are its whole
// vocabulary, and op 3 hands back the answer.

const SPECIAL = {
  "window.Math": "[object Math]",
  "window.Reflect": "[object Reflect]",
  "window.performance": "[object Performance]",
  "window.localStorage": "[object Storage]",
  "window.Object": "function Object() { [native code] }",
  "window.Reflect.set": "function set() { [native code] }",
  "window.performance.now": "function () { [native code] }",
  "window.Object.create": "function create() { [native code] }",
  "window.Object.keys": "function keys() { [native code] }",
  "window.Math.random": "function random() { [native code] }",
};

const LOCAL_STORAGE_KEYS = [
  "STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
  "STATSIG_LOCAL_STORAGE_STABLE_ID",
  "client-correlated-secret",
  "oai/apps/capExpiresAt",
  "oai-did",
  "STATSIG_LOCAL_STORAGE_LOGGING_REQUEST",
  "UiState.isNavigationCollapsed.1",
];

/** Python renders a whole float with ".0"; JavaScript does not. */
function floatString(value) {
  return Number.isInteger(value) ? value + ".0" : String(value);
}

function toStr(value) {
  if (value === null || value === undefined) return "undefined";
  if (typeof value === "number") return floatString(value);
  if (typeof value === "string") return SPECIAL[value] ?? value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(",");
  return String(value);
}

/** Character-wise xor by code point, as the reference does. */
export function xorString(text, key) {
  if (!key) return text;
  const chars = Array.from(text);
  const keyChars = Array.from(key);
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    out += String.fromCharCode(chars[i].codePointAt(0) ^ keyChars[i % keyChars.length].codePointAt(0));
  }
  return out;
}

/** Keeps insertion order, which the program relies on for Object.keys. */
class Ordered {
  constructor() {
    this.keys = [];
    this.values = new Map();
  }
  add(key, value) {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }
}

/** Answer the turnstile token, or null when the program cannot be read. */
export function solveTurnstile(dx, p) {
  let program;
  try {
    program = JSON.parse(xorString(Buffer.from(dx, "base64").toString("utf8"), p));
  } catch {
    return null;
  }
  if (!Array.isArray(program)) return null;

  const slots = new Map();
  const started = process.hrtime.bigint();
  let result = "";

  // 1: xor two slots into the first
  slots.set(1, (a, b) => slots.set(a, xorString(toStr(slots.get(a)), toStr(slots.get(b)))));
  // 2: assign
  slots.set(2, (a, value) => slots.set(a, value));
  // 3: done -- the slot becomes the token, base64ed
  slots.set(3, (a) => {
    result = Buffer.from(toStr(slots.get(a)), "utf8").toString("base64");
  });
  // 5: append to an array, or concatenate
  slots.set(5, (a, b) => {
    const current = slots.get(a);
    const incoming = slots.get(b);
    if (Array.isArray(current)) return slots.set(a, [...current, incoming]);
    if (["string", "number"].includes(typeof current) || ["string", "number"].includes(typeof incoming)) {
      return slots.set(a, toStr(current) + toStr(incoming));
    }
    slots.set(a, "NaN");
  });
  // 6: dotted name, with the one rewrite the program depends on
  slots.set(6, (a, b, c) => {
    const left = slots.get(b);
    const right = slots.get(c);
    if (typeof left === "string" && typeof right === "string") {
      const value = left + "." + right;
      slots.set(a, value === "window.document.location" ? "https://chatgpt.com/" : value);
    }
  });
  // 7: call a registered function; Reflect.set lands in the ordered map
  slots.set(7, (a, ...args) => {
    const target = slots.get(a);
    const values = args.map((arg) => slots.get(arg));
    if (target === "window.Reflect.set") {
      const [object, key, value] = values;
      if (object instanceof Ordered) object.add(toStr(key), value);
      return;
    }
    if (typeof target === "function") target(...values);
  });
  // 8: copy
  slots.set(8, (a, b) => slots.set(a, slots.get(b)));
  // 14/15: JSON in and out
  slots.set(14, (a, b) => slots.set(a, JSON.parse(toStr(slots.get(b)))));
  slots.set(15, (a, b) => slots.set(a, JSON.stringify(slots.get(b))));
  // 17: the host APIs the program probes
  slots.set(17, (a, b, ...args) => {
    const target = slots.get(b);
    const values = args.map((arg) => slots.get(arg));
    if (target === "window.performance.now") {
      return slots.set(a, Number(process.hrtime.bigint() - started) / 1e6 + Math.random());
    }
    if (target === "window.Object.create") return slots.set(a, new Ordered());
    if (target === "window.Object.keys") {
      if (values[0] === "window.localStorage") slots.set(a, [...LOCAL_STORAGE_KEYS]);
      return;
    }
    if (target === "window.Math.random") return slots.set(a, Math.random());
    if (typeof target === "function") slots.set(a, target(...values));
  });
  // 18/19: base64
  slots.set(18, (a) => slots.set(a, Buffer.from(toStr(slots.get(a)), "base64").toString("utf8")));
  slots.set(19, (a) => slots.set(a, Buffer.from(toStr(slots.get(a)), "utf8").toString("base64")));
  // 20: conditional call
  slots.set(20, (a, b, c, ...args) => {
    if (slots.get(a) === slots.get(b)) {
      const target = slots.get(c);
      if (typeof target === "function") target(...args.map((arg) => slots.get(arg)));
    }
  });
  // 21: no-op
  slots.set(21, () => undefined);
  // 23: call the slot's function when a condition is not empty
  slots.set(23, (a, b, ...args) => {
    const target = slots.get(b);
    const condition = slots.get(a);
    if (condition !== null && condition !== undefined && typeof target === "function") {
      target(...args.map((arg) => slots.get(arg)));
    }
  });
  // 24: dotted name, no rewrite
  slots.set(24, (a, b, c) => {
    const left = slots.get(b);
    const right = slots.get(c);
    if (typeof left === "string" && typeof right === "string") slots.set(a, left + "." + right);
  });

  slots.set(9, program);
  slots.set(10, "window");
  slots.set(16, p);

  for (const token of program) {
    if (!Array.isArray(token) || token.length === 0) continue;
    const fn = slots.get(Number(token[0]));
    if (typeof fn !== "function") continue;
    try {
      fn(...token.slice(1));
    } catch {
      /* one bad step does not stop the program */
    }
  }

  return result || null;
}
