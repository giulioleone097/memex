import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Task TV.1 (Memex vendor assets): plugins/openwiki/vendor/ ships the WASM
// embedding runtime (onnxruntime-web, Node entry) and the quantized
// multilingual-e5-small model as checksummed, licensed, offline assets.
//
// CHUNKED STORAGE CONTRACT (orchestrator decision, 2026-07-14): Git LFS is
// rejected because it adds an external tool dependency for every cloner.
// Any vendored file whose whole-file size would exceed GitHub's hard
// per-file push limit is stored as sequential raw byte parts
// (<name>.part0, <name>.part1, ...) in the same directory, each strictly
// under PART_LIMIT_BYTES, with no compression. The manifest entry keeps the
// LOGICAL path (e.g. .../model.onnx) and carries:
//   assembled_sha256  - sha256 of the whole reassembled file
//   bytes             - whole-file byte count
//   parts             - ordered [{ path, sha256, bytes }] physical chunks
// The logical file MUST NOT exist on disk. Consumers MUST read the parts in
// order, concatenate into a single in-memory Uint8Array, verify
// assembled_sha256, and pass the buffer to InferenceSession.create - never
// reassemble on disk.
//
// KNOWN, EVIDENCE-BACKED DEVIATION FROM THE ORIGINAL SDD BUDGET (accepted
// by the orchestrator on 2026-07-14): tv1-brief.md specified "total < 60 MB"
// as a planning estimate. Empirical verification against seven independent
// hosts of int8-quantized multilingual-e5-small (the official intfloat/onnx
// export, Xenova, georgechang8, nixiesearch, WiseIntelligence, hotchpotch,
// and efederici) all converge on ~117-120 MB for model.onnx alone, because
// the model's 250k-token multilingual SentencePiece vocabulary dominates
// the parameter count even after int8 quantization (the embedding matrix
// alone is ~96 MB at int8). tokenizer.json, which serializes that same
// 250k-entry vocabulary, is inherently ~17 MB in every export. Multilingual
// coverage is a hard product requirement, so the ~142 MiB real footprint is
// accepted; VENDOR_BUDGET_BYTES below is the enforced ceiling. See
// tv1-report.md for full sourcing evidence.
const VENDOR_BUDGET_BYTES = 160 * 1024 * 1024; // 160 MB total ceiling
const PART_LIMIT_BYTES = 95 * 1024 * 1024; // every chunk strictly < 95 MB
const SINGLE_FILE_LIMIT_BYTES = 100 * 1024 * 1024; // GitHub hard per-file limit

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, "../../vendor");
const manifestPath = path.join(vendorRoot, "MANIFEST.json");

/**
 * @typedef {{ path: string, sha256: string, bytes: number }} ManifestPart
 * @typedef {{ path: string, bytes: number, license: string, upstream: string, revision: string, sha256?: string, assembled_sha256?: string, parts?: ManifestPart[] }} ManifestAsset
 * @returns {{ assets: ManifestAsset[] }}
 */
function readManifest() {
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw);
}

function isChunked(asset) {
  return Array.isArray(asset.parts);
}

/** Physical on-disk files an asset entry accounts for. */
function physicalFilesOf(asset) {
  if (isChunked(asset)) {
    return asset.parts.map((part) => ({ path: part.path, sha256: part.sha256, bytes: part.bytes }));
  }
  return [{ path: asset.path, sha256: asset.sha256, bytes: asset.bytes }];
}

function sha256Of(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function listAllFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test("vendor MANIFEST.json exists and parses", () => {
  assert.ok(existsSync(manifestPath), `expected MANIFEST at ${manifestPath}`);
  const manifest = readManifest();
  assert.ok(Array.isArray(manifest.assets), "manifest.assets must be an array");
  assert.ok(manifest.assets.length > 0, "manifest.assets must not be empty");
});

test("every manifest entry has the required fields with correct types", () => {
  const manifest = readManifest();
  for (const asset of manifest.assets) {
    assert.equal(typeof asset.path, "string", `path must be a string (${JSON.stringify(asset)})`);
    assert.equal(typeof asset.bytes, "number", `bytes must be a number (${asset.path})`);
    assert.ok(asset.bytes > 0, `bytes must be positive (${asset.path})`);
    assert.equal(typeof asset.license, "string", `license must be a string (${asset.path})`);
    assert.ok(asset.license.length > 0, `license must be non-empty (${asset.path})`);
    assert.equal(typeof asset.upstream, "string", `upstream must be a string (${asset.path})`);
    assert.ok(asset.upstream.length > 0, `upstream must be non-empty (${asset.path})`);
    assert.equal(typeof asset.revision, "string", `revision must be a string (${asset.path})`);
    assert.ok(asset.revision.length > 0, `revision must be non-empty (${asset.path})`);
    if (isChunked(asset)) {
      assert.match(
        asset.assembled_sha256 ?? "",
        /^[0-9a-f]{64}$/,
        `chunked asset must carry a 64-hex-char assembled_sha256 (${asset.path})`,
      );
      assert.equal(asset.sha256, undefined, `chunked asset must not also carry sha256 (${asset.path})`);
      assert.ok(asset.parts.length > 0, `parts must be non-empty (${asset.path})`);
      let partSum = 0;
      for (const [index, part] of asset.parts.entries()) {
        assert.equal(typeof part.path, "string", `part path must be a string (${asset.path}#${index})`);
        assert.ok(
          part.path.endsWith(`.part${index}`),
          `parts must be listed in sequential .partN order (${asset.path}#${index} is ${part.path})`,
        );
        assert.match(part.sha256, /^[0-9a-f]{64}$/, `part sha256 must be 64 hex chars (${part.path})`);
        assert.equal(typeof part.bytes, "number", `part bytes must be a number (${part.path})`);
        assert.ok(part.bytes > 0, `part bytes must be positive (${part.path})`);
        partSum += part.bytes;
      }
      assert.equal(
        partSum,
        asset.bytes,
        `sum of part bytes (${partSum}) must equal whole-file bytes (${asset.bytes}) for ${asset.path}`,
      );
    } else {
      assert.match(asset.sha256 ?? "", /^[0-9a-f]{64}$/, `sha256 must be a 64-hex-char string (${asset.path})`);
      assert.equal(
        asset.assembled_sha256,
        undefined,
        `plain asset must not carry assembled_sha256 (${asset.path})`,
      );
    }
  }
});

test("the vendored model.onnx is stored chunked, never as a monolithic file", () => {
  const manifest = readManifest();
  const modelAsset = manifest.assets.find(
    (asset) => asset.path === "model/multilingual-e5-small-int8/model.onnx",
  );
  assert.ok(modelAsset, "manifest must contain the model.onnx logical entry");
  assert.ok(
    isChunked(modelAsset),
    "model.onnx exceeds GitHub's per-file limit and must be a chunked entry with parts",
  );
});

test("every manifest-listed physical file exists; chunked logical files must NOT exist on disk", () => {
  const manifest = readManifest();
  for (const asset of manifest.assets) {
    for (const file of physicalFilesOf(asset)) {
      const full = path.join(vendorRoot, file.path);
      assert.ok(existsSync(full), `missing vendored file: ${file.path}`);
    }
    if (isChunked(asset)) {
      const logicalFull = path.join(vendorRoot, asset.path);
      assert.ok(
        !existsSync(logicalFull),
        `chunked asset's monolithic file must not exist on disk: ${asset.path}`,
      );
    }
  }
});

test("every manifest-listed physical file's byte size matches disk", () => {
  const manifest = readManifest();
  for (const asset of manifest.assets) {
    for (const file of physicalFilesOf(asset)) {
      const full = path.join(vendorRoot, file.path);
      const actual = statSync(full).size;
      assert.equal(actual, file.bytes, `byte size mismatch for ${file.path}: manifest=${file.bytes} disk=${actual}`);
    }
  }
});

test("every physical file's sha256 matches, and chunked assets reassemble to assembled_sha256", () => {
  const manifest = readManifest();
  for (const asset of manifest.assets) {
    for (const file of physicalFilesOf(asset)) {
      const full = path.join(vendorRoot, file.path);
      const actual = sha256Of(full);
      assert.equal(actual, file.sha256, `sha256 mismatch for ${file.path}`);
    }
    if (isChunked(asset)) {
      const assembled = createHash("sha256");
      for (const part of asset.parts) {
        assembled.update(readFileSync(path.join(vendorRoot, part.path)));
      }
      assert.equal(
        assembled.digest("hex"),
        asset.assembled_sha256,
        `assembled sha256 mismatch for ${asset.path} - parts do not reconstruct the original file`,
      );
    }
  }
});

test("every chunk part stays strictly under the 95 MB part limit", () => {
  const manifest = readManifest();
  for (const asset of manifest.assets.filter(isChunked)) {
    for (const part of asset.parts) {
      assert.ok(
        part.bytes < PART_LIMIT_BYTES,
        `part ${part.path} is ${part.bytes} bytes, must be < ${PART_LIMIT_BYTES}`,
      );
    }
  }
});

test("no single manifested physical file reaches GitHub's 100 MB per-file limit", () => {
  const manifest = readManifest();
  for (const asset of manifest.assets) {
    for (const file of physicalFilesOf(asset)) {
      assert.ok(
        file.bytes < SINGLE_FILE_LIMIT_BYTES,
        `physical file ${file.path} is ${file.bytes} bytes, which GitHub would reject (limit ${SINGLE_FILE_LIMIT_BYTES})`,
      );
    }
  }
});

test("total vendored bytes stay within the documented budget", () => {
  const manifest = readManifest();
  const total = manifest.assets.reduce(
    (sum, asset) => sum + physicalFilesOf(asset).reduce((s, file) => s + file.bytes, 0),
    0,
  );
  assert.ok(
    total < VENDOR_BUDGET_BYTES,
    `total vendored bytes ${total} exceeds budget ${VENDOR_BUDGET_BYTES}`,
  );
});

test("license texts are present and non-empty for every distinct license", () => {
  const manifest = readManifest();
  const licensesDir = path.join(vendorRoot, "licenses");
  assert.ok(existsSync(licensesDir), "vendor/licenses/ must exist");
  const licenseFiles = readdirSync(licensesDir).filter((name) => name.endsWith(".txt"));
  assert.ok(licenseFiles.length > 0, "vendor/licenses/ must contain at least one license file");
  for (const name of licenseFiles) {
    const full = path.join(licensesDir, name);
    const text = readFileSync(full, "utf8");
    assert.ok(text.trim().length > 200, `license file ${name} looks too short to be a real license text`);
  }
  const distinctLicenses = new Set(manifest.assets.map((asset) => asset.license));
  assert.ok(distinctLicenses.size > 0, "manifest must declare at least one license");
});

test("no stray, un-manifested files exist under vendor/ (excluding MANIFEST.json and licenses/)", () => {
  const manifest = readManifest();
  const manifestPaths = new Set(
    manifest.assets.flatMap((asset) => physicalFilesOf(asset).map((file) => path.normalize(file.path))),
  );
  const licensesDir = path.join(vendorRoot, "licenses");
  const allFiles = listAllFiles(vendorRoot);
  for (const full of allFiles) {
    if (full === manifestPath) continue;
    if (full.startsWith(licensesDir + path.sep)) continue;
    const rel = path.normalize(path.relative(vendorRoot, full));
    assert.ok(manifestPaths.has(rel), `un-manifested file found under vendor/: ${rel}`);
  }
});

test("vendor/ort/node_modules contains ONLY the vendored onnxruntime-common shim", () => {
  const shimRoot = path.join(vendorRoot, "ort", "node_modules");
  assert.ok(existsSync(shimRoot), "vendor/ort/node_modules must exist (required by ort.node.min.mjs)");
  const entries = readdirSync(shimRoot).filter((name) => name !== ".DS_Store");
  assert.deepEqual(
    entries,
    ["onnxruntime-common"],
    "vendor/ort/node_modules must contain exactly one package: onnxruntime-common - " +
      "no other package may ever be vendored here",
  );
});
