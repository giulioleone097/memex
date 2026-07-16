import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { resolveWikiLocation } from "../../dist/paths.js";
import { runDoctor } from "../../dist/doctor.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-doctor-vendor-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeValidVendor(vendorRoot) {
  const modelPath = "model/multilingual-e5-small-int8/model.onnx";
  const tokenizerPath = "model/multilingual-e5-small-int8/tokenizer.json";
  await mkdir(path.join(vendorRoot, "model", "multilingual-e5-small-int8"), { recursive: true });
  const model = Buffer.from("fake-model-bytes");
  const tokenizer = Buffer.from(JSON.stringify({ model: { type: "Unigram", vocab: [] } }));
  await writeFile(path.join(vendorRoot, modelPath), model);
  await writeFile(path.join(vendorRoot, tokenizerPath), tokenizer);
  const entry = (relativePath, content) => ({ path: relativePath, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, license: "MIT", upstream: "test", revision: "test-1" });
  await writeFile(path.join(vendorRoot, "MANIFEST.json"), JSON.stringify({ assets: [entry(modelPath, model), entry(tokenizerPath, tokenizer)] }));
}

test("doctor: reports vendor-assets pass when the manifest and every checksum verify", async () => {
  const home = await temporaryRoot("home");
  const root = await temporaryRoot("repo");
  await mkdir(root, { recursive: true });
  const vendorRoot = await temporaryRoot("vendor");
  await writeValidVendor(vendorRoot);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const result = await runDoctor({ location, homeDir: home, vendorRoot });
  const check = result.checks.find((entry) => entry.id === "vendor-assets");
  assert.equal(check?.status, "pass");
});

test("doctor: reports vendor-assets fail with an actionable message when the manifest is missing", async () => {
  const home = await temporaryRoot("home");
  const root = await temporaryRoot("repo");
  await mkdir(root, { recursive: true });
  const vendorRoot = await temporaryRoot("vendor-missing");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const result = await runDoctor({ location, homeDir: home, vendorRoot });
  const check = result.checks.find((entry) => entry.id === "vendor-assets");
  assert.equal(check?.status, "fail");
  assert.match(check.message, /write|graph build/iu);
  assert.equal(result.ok, false);
});

test("doctor: reports vendor-assets fail on a checksum mismatch", async () => {
  const home = await temporaryRoot("home");
  const root = await temporaryRoot("repo");
  await mkdir(root, { recursive: true });
  const vendorRoot = await temporaryRoot("vendor-corrupt");
  await writeValidVendor(vendorRoot);
  await writeFile(path.join(vendorRoot, "model", "multilingual-e5-small-int8", "model.onnx"), Buffer.from("tampered"));
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const result = await runDoctor({ location, homeDir: home, vendorRoot });
  const check = result.checks.find((entry) => entry.id === "vendor-assets");
  assert.equal(check?.status, "fail");
});
