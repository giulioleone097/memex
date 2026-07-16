import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { loadEmbedder, loadVendorManifest, verifyAllVendorAssets } from "../../dist/embedder.js";

const roots = [];
async function temporaryVendorRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memex-vendor-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeAsset(root, relative, content) {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return { path: relative, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, license: "MIT", upstream: "test", revision: "test-1" };
}

test("embedder: MODEL_ASSET_MISSING when the vendor manifest itself is absent", async () => {
  const root = await temporaryVendorRoot();
  await assert.rejects(loadVendorManifest(root), { code: "MODEL_ASSET_MISSING" });
  await assert.rejects(loadEmbedder(root), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: MODEL_ASSET_MISSING when a manifest-listed asset file is absent from disk", async () => {
  const root = await temporaryVendorRoot();
  const entry = { path: "model/multilingual-e5-small-int8/model.onnx", sha256: "a".repeat(64), bytes: 10, license: "MIT", upstream: "test", revision: "test-1" };
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: MODEL_ASSET_CORRUPT on a checksum mismatch", async () => {
  const root = await temporaryVendorRoot();
  const asset = await writeAsset(root, "model/multilingual-e5-small-int8/model.onnx", Buffer.from("fake-model-bytes"));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [{ ...asset, sha256: "0".repeat(64) }] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: MODEL_ASSET_CORRUPT on a byte-size mismatch", async () => {
  const root = await temporaryVendorRoot();
  const asset = await writeAsset(root, "model/multilingual-e5-small-int8/model.onnx", Buffer.from("fake-model-bytes"));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [{ ...asset, bytes: asset.bytes + 1 }] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: verifyAllVendorAssets passes when every listed asset matches its checksum", async () => {
  const root = await temporaryVendorRoot();
  const modelAsset = await writeAsset(root, "model/multilingual-e5-small-int8/model.onnx", Buffer.from("fake-model-bytes"));
  const tokenizerAsset = await writeAsset(root, "model/multilingual-e5-small-int8/tokenizer.json", Buffer.from(JSON.stringify({ model: { type: "Unigram", vocab: [] } })));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [modelAsset, tokenizerAsset] }));
  const manifest = await verifyAllVendorAssets(root);
  assert.equal(manifest.assets.length, 2);
});

// Builds one nested split-asset manifest entry matching TV.1's real MANIFEST.json
// shape: the logical path carries assembled_sha256 + bytes (assembled total) +
// an ordered parts[] array; there is no sibling top-level entry for each part.
async function writeSplitAsset(root, logicalPath, partsContent) {
  const partAssets = await Promise.all(partsContent.map((content, index) => writeAsset(root, `${logicalPath}.part${String(index)}`, content)));
  const assembled = Buffer.concat(partsContent);
  return {
    path: logicalPath,
    assembled_sha256: createHash("sha256").update(assembled).digest("hex"),
    bytes: partAssets.reduce((sum, part) => sum + part.bytes, 0),
    parts: partAssets.map((part) => ({ path: part.path, sha256: part.sha256, bytes: part.bytes })),
    license: "MIT", upstream: "test", revision: "test-1",
  };
}

test("embedder: loadModelBuffer assembles sequential model parts in memory and verifies the assembled checksum", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const part0 = Buffer.from("first-half-of-the-model-");
  const part1 = Buffer.from("second-half-of-the-model");
  const entry = await writeSplitAsset(root, logicalPath, [part0, part1]);
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  const manifest = await verifyAllVendorAssets(root);
  const buffer = await loadModelBuffer(root, manifest, logicalPath);
  assert.ok(buffer instanceof Uint8Array);
  assert.deepEqual(Buffer.from(buffer), Buffer.concat([part0, part1]));
  const onDisk = await import("node:fs/promises");
  await assert.rejects(onDisk.stat(path.join(root, logicalPath)), { code: "ENOENT" }, "the assembled model must never be written back to disk");
});

test("embedder: loadModelBuffer reports MODEL_ASSET_CORRUPT when the assembled checksum does not match, even though every individual part matches", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const entry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a"), Buffer.from("part-b")]);
  entry.assembled_sha256 = "0".repeat(64);
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  const manifest = await verifyAllVendorAssets(root);
  await assert.rejects(loadModelBuffer(root, manifest, logicalPath), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: verifyAllVendorAssets verifies each part file of a split asset individually, without requiring the (never-written) assembled file on disk", async () => {
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const entry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a"), Buffer.from("part-b")]);
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  const manifest = await verifyAllVendorAssets(root);
  assert.equal(manifest.assets.length, 1);
  const onDisk = await import("node:fs/promises");
  await assert.rejects(onDisk.stat(path.join(root, logicalPath)), { code: "ENOENT" }, "verification must never require or create the assembled file");
});

test("embedder: MODEL_ASSET_MISSING when one part of a split asset is absent from disk", async () => {
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const entry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a"), Buffer.from("part-b")]);
  await rm(path.join(root, entry.parts[1].path));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: MODEL_ASSET_CORRUPT when a manifest entry declares both sha256 and parts, or neither", async () => {
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const splitEntry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a")]);
  const bothEntry = { ...splitEntry, sha256: "a".repeat(64) };
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [bothEntry] }));
  await assert.rejects(loadVendorManifest(root), { code: "MODEL_ASSET_CORRUPT" });
  const neitherEntry = { path: logicalPath, bytes: 1, license: "MIT", upstream: "test", revision: "test-1" };
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [neitherEntry] }));
  await assert.rejects(loadVendorManifest(root), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: loadModelBuffer reports MODEL_ASSET_MISSING when neither a single file nor any parts are listed", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [] }));
  const manifest = await verifyAllVendorAssets(root);
  await assert.rejects(loadModelBuffer(root, manifest, "model/multilingual-e5-small-int8/model.onnx"), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: loadModelBuffer still supports a single unsplit file for the logical path", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const asset = await writeAsset(root, logicalPath, Buffer.from("a-small-unsplit-model"));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [asset] }));
  const manifest = await verifyAllVendorAssets(root);
  const buffer = await loadModelBuffer(root, manifest, logicalPath);
  assert.deepEqual(Buffer.from(buffer), Buffer.from("a-small-unsplit-model"));
});

// TP.2 review finding C1: the ORT loader's path-resolution logic must be
// unit-testable in isolation, without real vendored assets, so a broken
// entry-path resolution can never silently pass every unit test and only
// surface during T9.1's real-asset dogfooding re-run (which is exactly what
// happened before this fix — see tp2-review.md).
test("embedder: resolveOrtEntryPath resolves to the real vendored ONNX Runtime entry file, not a bare directory specifier", async () => {
  const { resolveOrtEntryPath } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const resolved = resolveOrtEntryPath(root);
  assert.equal(resolved, path.join(root, "ort", "ort.node.min.mjs"));
});
