import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// TV.1 smoke proof: the vendored WASM inference engine
// (plugins/memex/vendor/ort/) and the vendored int8-quantized
// multilingual-e5-small model (plugins/memex/vendor/model/) actually
// run real inference in plain Node >= 20, with zero npm install - every
// import below resolves to a file committed under vendor/, never to a
// package.json dependency.
//
// CHUNKED MODEL LOADING CONTRACT (orchestrator decision, 2026-07-14):
// model.onnx is stored as sequential raw byte parts (model.onnx.part0,
// model.onnx.part1, ...) because the whole file exceeds GitHub's hard
// per-file push limit and Git LFS was rejected. This test exercises the
// exact loading contract every future consumer MUST follow: read the parts
// in the order listed in MANIFEST.json, concatenate them into a single
// in-memory Uint8Array, verify the manifest's assembled_sha256 over that
// buffer, and pass the buffer to InferenceSession.create. The monolithic
// model.onnx never exists on disk and must never be reassembled on disk.
//
// The tokenizer implemented here is a deliberately minimal inline Unigram
// (SentencePiece) encoder built directly from tokenizer.json: Metaspace
// pre-tokenization + a Viterbi best-path segmentation over the model's
// vocab/score table, plus the <s> ... </s> template the model was trained
// with. It does NOT implement the tokenizer's `Precompiled` charsmap
// normalizer (used by SentencePiece for NFKC-style normalization of
// arbitrary Unicode) - for the plain-ASCII smoke input this is a no-op in
// practice, but it means this is not a general-purpose tokenizer. A real,
// complete tokenizer module (charsmap-aware, reusable) is a later task;
// this one intentionally stays local to this test file.

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, "../../vendor");
const ortDir = path.join(vendorRoot, "ort");
const modelDir = path.join(vendorRoot, "model/multilingual-e5-small-int8");

const ortEntryPath = path.join(ortDir, "ort.node.min.mjs");
const tokenizerPath = path.join(modelDir, "tokenizer.json");
const manifestPath = path.join(vendorRoot, "MANIFEST.json");
const MODEL_LOGICAL_PATH = "model/multilingual-e5-small-int8/model.onnx";

/** Finds the chunked model entry and confirms all of its parts are on disk. */
function locateChunkedModel() {
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const asset = manifest.assets.find((entry) => entry.path === MODEL_LOGICAL_PATH);
  if (!asset || !Array.isArray(asset.parts) || asset.parts.length === 0) return null;
  const allPartsPresent = asset.parts.every((part) => existsSync(path.join(vendorRoot, part.path)));
  return allPartsPresent ? asset : null;
}

/**
 * The canonical chunked-model loader contract: read parts in manifest
 * order, concatenate into one in-memory Uint8Array, verify the assembled
 * sha256, and return the buffer. Never touches the disk with the
 * reassembled bytes.
 */
function assembleModelBuffer(asset) {
  const assembled = new Uint8Array(asset.bytes);
  let offset = 0;
  for (const part of asset.parts) {
    const chunk = readFileSync(path.join(vendorRoot, part.path));
    assembled.set(chunk, offset);
    offset += chunk.length;
  }
  assert.equal(offset, asset.bytes, "concatenated part bytes must equal the manifest's whole-file bytes");
  const digest = createHash("sha256").update(assembled).digest("hex");
  assert.equal(
    digest,
    asset.assembled_sha256,
    "assembled model buffer failed sha256 verification - refusing to run inference on corrupt bytes",
  );
  return assembled;
}

const modelAsset = locateChunkedModel();
const assetsPresent = existsSync(ortEntryPath) && existsSync(tokenizerPath) && modelAsset !== null;

test(
  "vendored WASM engine + chunked multilingual-e5-small embed 'query: ciao mondo' into a real 384-dim vector",
  { skip: assetsPresent ? false : "vendored assets are absent (run TV.1 asset acquisition first)" },
  async () => {
    // Import the vendored engine directly by file path - no bare "onnxruntime-web"
    // specifier, no node_modules entry outside vendor/ort/.
    const ort = await import(ortEntryPath);

    // Force single-threaded WASM: avoids spawning worker_threads, keeps the
    // smoke test deterministic and dependency-free (no SharedArrayBuffer /
    // cross-origin-isolation concerns, which don't apply in plain Node anyway).
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    const tokenizer = JSON.parse(readFileSync(tokenizerPath, "utf8"));
    assert.equal(tokenizer.model.type, "Unigram", "expected a SentencePiece Unigram tokenizer model");

    const encode = buildUnigramEncoder(tokenizer);
    const inputText = "query: ciao mondo"; // e5 query prefix discipline: "query: " for queries
    const ids = encode(inputText);
    assert.ok(ids.length > 2, "expected at least <s>, one piece, </s>");
    assert.equal(ids[0], 0, "expected <s> at position 0");
    assert.equal(ids[ids.length - 1], 2, "expected </s> at the last position");

    // Chunked loading contract: parts -> in-memory Uint8Array -> sha256
    // verification -> InferenceSession.create(buffer). Never a disk path,
    // never an on-disk reassembly.
    const modelBuffer = assembleModelBuffer(modelAsset);
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
    });
    assert.deepEqual(
      [...session.inputNames].sort(),
      ["attention_mask", "input_ids", "token_type_ids"],
      "unexpected ONNX graph input names - vendored model.onnx may not match the pinned revision",
    );

    const seqLen = ids.length;
    const inputIds = new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, seqLen]);
    const attentionMask = new ort.Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, seqLen]);
    const tokenTypeIds = new ort.Tensor("int64", BigInt64Array.from(ids.map(() => 0n)), [1, seqLen]);

    const outputs = await session.run({
      input_ids: inputIds,
      attention_mask: attentionMask,
      token_type_ids: tokenTypeIds,
    });

    const hidden = outputs.last_hidden_state;
    const [batch, seq, dim] = hidden.dims;
    assert.equal(batch, 1);
    assert.equal(seq, seqLen);
    assert.equal(dim, 384, "multilingual-e5-small must produce 384-dim hidden states");

    // E5 uses mean pooling over token embeddings (all positions attended,
    // since attention_mask is all-1s here), not the <s> token embedding.
    const embedding = meanPool(hidden.data, seq, dim);
    assert.ok(embedding instanceof Float32Array, "pooled embedding must be a Float32Array");
    assert.equal(embedding.length, 384);

    let sumSquares = 0;
    for (let i = 0; i < embedding.length; i += 1) sumSquares += embedding[i] * embedding[i];
    const l2Norm = Math.sqrt(sumSquares);

    assert.ok(Number.isFinite(l2Norm), "L2 norm must be finite");
    assert.ok(l2Norm > 0, `expected a non-zero L2 norm, got ${l2Norm}`);

    await session.release();
  },
);

function meanPool(hiddenStateData, seqLen, dim) {
  const pooled = new Float32Array(dim);
  for (let t = 0; t < seqLen; t += 1) {
    for (let d = 0; d < dim; d += 1) {
      pooled[d] += hiddenStateData[t * dim + d];
    }
  }
  for (let d = 0; d < dim; d += 1) pooled[d] /= seqLen;
  return pooled;
}

/**
 * Builds a minimal Unigram (SentencePiece) encoder from a Hugging Face
 * tokenizer.json object. Supports exactly what multilingual-e5-small's
 * tokenizer.json declares: a Metaspace pre-tokenizer (add_prefix_space) and
 * a TemplateProcessing post-processor of the form <s> $A </s>. Does not
 * implement the Precompiled normalizer's charsmap (see module doc comment).
 */
function buildUnigramEncoder(tokenizerJson) {
  const { vocab, unk_id: unkId } = tokenizerJson.model;
  const vocabMap = new Map(vocab.map((entry, id) => [entry[0], [id, entry[1]]]));
  let maxPieceLength = 0;
  for (const [piece] of vocab) if (piece.length > maxPieceLength) maxPieceLength = piece.length;

  const metaspaceReplacement = tokenizerJson.pre_tokenizer?.replacement ?? "▁";
  const addPrefixSpace = tokenizerJson.pre_tokenizer?.add_prefix_space ?? true;

  const template = tokenizerJson.post_processor?.single ?? [];
  const specialTokenIds = tokenizerJson.post_processor?.special_tokens ?? {};

  function toMetaspace(text) {
    const withPrefix = addPrefixSpace ? ` ${text}` : text;
    return withPrefix.split(" ").join(metaspaceReplacement);
  }

  function viterbiSegment(text) {
    const chars = Array.from(text);
    const n = chars.length;
    const best = new Array(n + 1).fill(-Infinity);
    const backPos = new Array(n + 1).fill(-1);
    const backId = new Array(n + 1).fill(null);
    best[0] = 0;
    for (let i = 0; i < n; i += 1) {
      if (best[i] === -Infinity) continue;
      const maxJ = Math.min(n, i + maxPieceLength);
      for (let j = i + 1; j <= maxJ; j += 1) {
        const piece = chars.slice(i, j).join("");
        const entry = vocabMap.get(piece);
        if (!entry) continue;
        const [id, score] = entry;
        const candidate = best[i] + score;
        if (candidate > best[j]) {
          best[j] = candidate;
          backPos[j] = i;
          backId[j] = id;
        }
      }
    }
    if (best[n] === -Infinity) {
      throw new Error(
        `unigram tokenization found no path for ${JSON.stringify(text)} - ` +
          "this minimal smoke-test encoder has no byte-fallback for out-of-vocab spans",
      );
    }
    const ids = [];
    let i = n;
    while (i > 0) {
      ids.push(backId[i]);
      i = backPos[i];
    }
    ids.reverse();
    return ids;
  }

  return function encode(text) {
    const pieceIds = viterbiSegment(toMetaspace(text));
    const ids = [];
    for (const step of template) {
      if (step.SpecialToken) {
        const special = specialTokenIds[step.SpecialToken.id];
        const id = special?.ids?.[0] ?? (step.SpecialToken.id === "<s>" ? 0 : step.SpecialToken.id === "</s>" ? 2 : unkId);
        ids.push(id);
      } else if (step.Sequence) {
        ids.push(...pieceIds);
      }
    }
    return ids;
  };
}
