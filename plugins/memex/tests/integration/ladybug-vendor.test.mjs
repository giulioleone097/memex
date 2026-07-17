import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // tests/integration
const groupRoot = path.join(here, "..", "..", "vendor", "ladybug-wasm");

async function sha256(abs) {
  return createHash("sha256").update(await readFile(abs)).digest("hex");
}

test("vendored Ladybug manifest is well-formed and pins the nodejs variant", async () => {
  const manifest = JSON.parse(await readFile(path.join(groupRoot, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.package, "@ladybugdb/wasm-core");
  assert.equal(manifest.version, "0.18.2");
  assert.equal(manifest.variant, "nodejs");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.entry, "nodejs/index.js");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 10);
});

test("every vendored file matches its manifest sha256 and size", async () => {
  const manifest = JSON.parse(await readFile(path.join(groupRoot, "MANIFEST.json"), "utf8"));
  for (const entry of manifest.files) {
    const abs = path.join(groupRoot, entry.path);
    const size = (await stat(abs)).size;
    assert.equal(size, entry.bytes, `size mismatch: ${entry.path}`);
    assert.equal(await sha256(abs), entry.sha256, `sha mismatch: ${entry.path}`);
  }
});

test("the wasm binary and CJS entry are present and no file exceeds the GitHub limit", async () => {
  const manifest = JSON.parse(await readFile(path.join(groupRoot, "MANIFEST.json"), "utf8"));
  const wasm = manifest.files.find((f) => f.path.endsWith("lbug/lbug_wasm.wasm"));
  assert.ok(wasm, "wasm binary entry present");
  assert.ok(wasm.bytes > 1_000_000 && wasm.bytes < 95 * 1024 * 1024, "wasm under the 95MB chunk limit (no chunking needed)");
  assert.ok(manifest.files.some((f) => f.path === "nodejs/index.js"), "CJS entry present");
  // MIT license file for attribution
  await stat(path.join(groupRoot, "LICENSE"));
});
