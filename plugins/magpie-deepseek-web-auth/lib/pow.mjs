// Solving DeepSeek's proof of work.
//
// The server hands out a challenge and checks the answer with DeepSeek's own
// sha3 wasm; nothing else computes a matching answer. The binary ships with
// this plugin (assets/sha3_wasm_bg.wasm) so the solve does not depend on
// fetching it at request time.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BASE, POW_CHALLENGE_PATH } from "./constants.mjs";

const WASM_PATH = fileURLToPath(new URL("../assets/sha3_wasm_bg.wasm", import.meta.url));

let modulePromise;

function wasmModule() {
  if (!modulePromise) {
    modulePromise = readFile(WASM_PATH).then((bytes) => WebAssembly.compile(bytes));
    modulePromise.catch(() => {
      modulePromise = undefined;
    });
  }
  return modulePromise;
}

/** Solve one challenge with the shipped wasm. prefix = salt_expire_at_. */
export async function solve(challenge) {
  const module = await wasmModule();
  const instance = await WebAssembly.instantiate(module, { wbg: {} });
  const exports = instance.exports;

  for (const name of ["wasm_solve", "__wbindgen_export_0", "__wbindgen_add_to_stack_pointer"]) {
    if (typeof exports[name] !== "function") throw new Error("deepseek: the PoW wasm lacks " + name);
  }
  if (!exports.memory) throw new Error("deepseek: the PoW wasm has no memory");

  const encoder = new TextEncoder();
  const challengeBytes = encoder.encode(String(challenge.challenge));
  const prefixBytes = encoder.encode(String(challenge.salt) + "_" + String(challenge.expire_at) + "_");

  const challengePtr = exports.__wbindgen_export_0(challengeBytes.length, 1) >>> 0;
  const prefixPtr = exports.__wbindgen_export_0(prefixBytes.length, 1) >>> 0;
  new Uint8Array(exports.memory.buffer).set(challengeBytes, challengePtr);
  new Uint8Array(exports.memory.buffer).set(prefixBytes, prefixPtr);

  const stack = exports.__wbindgen_add_to_stack_pointer(-16);
  exports.wasm_solve(
    stack,
    challengePtr,
    challengeBytes.length,
    prefixPtr,
    prefixBytes.length,
    Number(challenge.difficulty),
  );
  const view = new DataView(exports.memory.buffer);
  const code = view.getInt32(stack, true);
  const answer = view.getFloat64(stack + 8, true);
  exports.__wbindgen_add_to_stack_pointer(16);

  if (code === 0 || !Number.isFinite(answer) || answer <= 0) {
    throw Object.assign(new Error("deepseek: the PoW solver answered code " + code), { status: 502 });
  }
  return Math.floor(answer);
}

/** Fetch a challenge and answer it as the header value the endpoint wants. */
export async function powHeaderOf(headers, targetPath, fetcher = fetch) {
  const response = await fetcher(BASE + POW_CHALLENGE_PATH, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ target_path: targetPath }),
  });
  if (!response.ok) {
    throw Object.assign(new Error("deepseek: the challenge request was refused (HTTP " + response.status + ")"), {
      status: response.status === 401 || response.status === 403 ? 401 : 502,
      ...(response.status === 401 || response.status === 403 ? { signIn: "expired" } : {}),
    });
  }
  const body = await response.json().catch(() => undefined);
  const challenge = body?.data?.biz_data?.challenge;
  if (!challenge?.challenge || !challenge?.salt) {
    throw Object.assign(new Error("deepseek: the challenge answer carried no challenge"), { status: 502 });
  }
  const answer = await solve(challenge);
  // The value is base64 of the whole record, target_path included.
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    }),
  ).toString("base64");
}
