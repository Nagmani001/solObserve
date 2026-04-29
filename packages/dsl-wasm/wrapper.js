import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgJs = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "pkg",
  "solobserve_dsl.js",
);
const wasm = /** @type {any} */ (require(pkgJs));

/**
 * @param {string} dsl
 * @param {{program_id: string, cluster: string, from_ms: number, to_ms: number, step_ms: number}} ctx
 */
export function compile(dsl, ctx) {
  return wasm.compile(dsl, ctx);
}

/**
 * @param {string} dsl
 */
export function parse(dsl) {
  return wasm.parse(dsl);
}
