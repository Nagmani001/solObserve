import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "pkg", "idl_parser.js");
/** @typedef {{ parseIdl: (js: string) => unknown }} IdlWasm */
/** @type {IdlWasm} */
const wasm = /** @type {any} */ (require(pkgJs));

export function parseIdl(js) {
  return wasm.parseIdl(js);
}
