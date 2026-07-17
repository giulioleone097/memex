import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // tests/integration
const vendorRoot = path.join(here, "..", "..", "vendor");

async function sha256(abs) {
  return createHash("sha256").update(await readFile(abs)).digest("hex");
}
async function readManifest() {
  return JSON.parse(await readFile(path.join(vendorRoot, "MANIFEST.json"), "utf8"));
}

test("shared manifest pins the vendored Ladybug nodejs entry and wasm binary", async () => {
  const manifest = await readManifest();
  const paths = new Set(manifest.assets.map((a) => a.path));
  assert.ok(paths.has("ladybug-wasm/nodejs/index.js"), "CJS entry manifested");
  assert.ok(paths.has("ladybug-wasm/nodejs/lbug/lbug_wasm.wasm"), "wasm binary manifested");
  assert.ok(paths.has("ladybug-wasm/nodejs/package.json"), "commonjs marker manifested");
  const lbug = manifest.assets.filter((a) => a.path.startsWith("ladybug-wasm/"));
  assert.ok(lbug.length >= 20, "ladybug core + runtime deps are manifested");
  assert.ok(lbug.every((a) => a.license === "MIT"), "all ladybug assets are MIT");
});

test("every vendored Ladybug file matches its manifest sha256 and size", async () => {
  const manifest = await readManifest();
  const lbug = manifest.assets.filter((a) => a.path.startsWith("ladybug-wasm/"));
  for (const entry of lbug) {
    const abs = path.join(vendorRoot, entry.path);
    assert.equal((await stat(abs)).size, entry.bytes, `size mismatch: ${entry.path}`);
    assert.equal(await sha256(abs), entry.sha256, `sha mismatch: ${entry.path}`);
  }
});

test("the wasm binary is under the GitHub limit (no chunking) and the license is present", async () => {
  const manifest = await readManifest();
  const wasm = manifest.assets.find((a) => a.path === "ladybug-wasm/nodejs/lbug/lbug_wasm.wasm");
  assert.ok(wasm.bytes > 1_000_000 && wasm.bytes < 95 * 1024 * 1024, "wasm under the 95MB chunk limit");
  await stat(path.join(vendorRoot, "licenses", "ladybug-wasm.txt"));
});

test("runtime dependencies are vendored so the wasm module resolves offline", async () => {
  const manifest = await readManifest();
  const deps = manifest.assets.filter((a) => a.path.startsWith("ladybug-wasm/nodejs/node_modules/"));
  const packages = new Set(deps.map((a) => a.path.split("/")[3]));
  for (const required of ["threads", "uuid", "tiny-worker"]) {
    assert.ok(packages.has(required), `vendored dep present: ${required}`);
  }
});
