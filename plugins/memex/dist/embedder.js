import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemexError } from "./errors.js";
import { loadTokenizer } from "./tokenizer.js";
const MODEL_ID = "multilingual-e5-small-int8";
const DIMS = 384;
const MODEL_RELATIVE = path.join("model", MODEL_ID, "model.onnx");
const TOKENIZER_RELATIVE = path.join("model", MODEL_ID, "tokenizer.json");
const ORT_ENTRY_RELATIVE = path.join("ort", "ort.node.min.mjs");
export function defaultVendorRoot() {
    return path.join(fileURLToPath(new URL("..", import.meta.url)), "vendor");
}
export async function loadVendorManifest(vendorRoot) {
    let raw;
    try {
        raw = await readFile(path.join(vendorRoot, "MANIFEST.json"), "utf8");
    }
    catch {
        throw new MemexError("MODEL_ASSET_MISSING", "Vendor asset manifest is missing.");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new MemexError("MODEL_ASSET_CORRUPT", "Vendor asset manifest is not valid JSON.");
    }
    return parseManifest(parsed);
}
export async function verifyAllVendorAssets(vendorRoot) {
    const manifest = await loadVendorManifest(vendorRoot);
    for (const entry of manifest.assets)
        await verifyVendorEntry(vendorRoot, entry);
    return manifest;
}
// A split entry's logical path (e.g. "model/.../model.onnx") never exists as a
// real file on disk — only its parts do, and the assembled bytes only ever
// exist transiently in memory (see loadModelBuffer) — so verification here
// checks every part file individually against its own sha256/bytes. The
// assembled_sha256 is checked lazily inside loadModelBuffer instead, since
// verifying it here would require reading and concatenating the whole model
// into memory on every doctor/startup check, not just when it is actually used.
async function verifyVendorEntry(vendorRoot, entry) {
    if (entry.parts === undefined) {
        if (entry.sha256 === undefined)
            throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${entry.path} declares neither sha256 nor parts.`);
        await verifyVendorFile(vendorRoot, entry.path, entry.sha256, entry.bytes);
        return;
    }
    for (const part of entry.parts)
        await verifyVendorFile(vendorRoot, part.path, part.sha256, part.bytes);
}
async function verifyVendorFile(vendorRoot, relativePath, expectedSha256, expectedBytes) {
    const absolute = path.join(vendorRoot, relativePath);
    let size;
    try {
        size = (await stat(absolute)).size;
    }
    catch {
        throw new MemexError("MODEL_ASSET_MISSING", `Vendor asset is missing: ${relativePath}.`);
    }
    if (size !== expectedBytes)
        throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset size mismatch: ${relativePath}.`);
    const digest = await sha256File(absolute);
    if (digest !== expectedSha256.toLowerCase())
        throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset checksum mismatch: ${relativePath}.`);
}
// Assembles a (possibly part-split) vendored asset entirely in memory: every
// individual part's sha256/bytes is already verified by verifyAllVendorAssets;
// this only concatenates them in manifest-declared order and additionally
// verifies the *assembled* checksum, since a bug in part order or a truncated
// part would otherwise pass per-part verification silently. The assembled
// buffer is never written back to disk.
export async function loadModelBuffer(vendorRoot, manifest, logicalPath) {
    const entry = manifest.assets.find((candidate) => candidate.path === logicalPath);
    if (entry === undefined)
        throw new MemexError("MODEL_ASSET_MISSING", `Vendor manifest has no entry for ${logicalPath}.`);
    if (entry.parts === undefined) {
        if (entry.sha256 === undefined)
            throw new MemexError("MODEL_ASSET_MISSING", `Vendor manifest entry for ${logicalPath} declares neither a single file nor parts.`);
        return readFile(path.join(vendorRoot, entry.path));
    }
    const buffers = await Promise.all(entry.parts.map((part) => readFile(path.join(vendorRoot, part.path))));
    const assembled = Buffer.concat(buffers);
    if (entry.assembledSha256 === undefined)
        throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor manifest is missing the assembled checksum for ${logicalPath}.`);
    const actual = createHash("sha256").update(assembled).digest("hex");
    if (actual !== entry.assembledSha256.toLowerCase())
        throw new MemexError("MODEL_ASSET_CORRUPT", `Assembled checksum mismatch for ${logicalPath}.`);
    return assembled;
}
export async function loadEmbedder(vendorRoot) {
    const manifest = await verifyAllVendorAssets(vendorRoot);
    const tokenizer = await loadTokenizer(path.join(vendorRoot, TOKENIZER_RELATIVE));
    const runtime = await loadOrtRuntime(vendorRoot);
    const modelBuffer = await loadModelBuffer(vendorRoot, manifest, MODEL_RELATIVE);
    const session = await runtime.createSession(modelBuffer);
    return {
        modelId: MODEL_ID,
        dims: DIMS,
        async embedQuery(text) {
            return runInference(runtime, session, tokenizer, `query: ${text}`);
        },
        async embedPassages(texts) {
            const results = [];
            for (const text of texts)
                results.push(await runInference(runtime, session, tokenizer, `passage: ${text}`));
            return results;
        },
    };
}
async function sha256File(absolute) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(absolute), hash);
    return hash.digest("hex");
}
// Exported (not just an inline expression inside loadOrtRuntime below) so
// TP.2 review finding C1's path-resolution logic is independently
// unit-testable without any real vendored assets on disk (Task 5 Step 1) —
// the actual dynamic import() only ever runs in a real-asset context
// (Step 5's skip-if-absent integration test).
export function resolveOrtEntryPath(vendorRoot) {
    return path.join(vendorRoot, ORT_ENTRY_RELATIVE);
}
async function loadOrtRuntime(vendorRoot) {
    let imported;
    try {
        imported = (await import(pathToFileURL(resolveOrtEntryPath(vendorRoot)).href));
    }
    catch {
        throw new MemexError("MODEL_ASSET_MISSING", "Vendored ONNX Runtime entry module is missing or could not be imported.");
    }
    const namespace = asRecord(imported);
    const moduleRecord = isRecord(namespace.default) ? namespace.default : namespace;
    const inferenceSession = moduleRecord.InferenceSession;
    const tensorConstructor = moduleRecord.Tensor;
    // The real vendored onnxruntime package exports InferenceSession as a
    // class with a static async create() (typeof "function", not "object") —
    // the canonical, documented ORT JS API shape (`ort.InferenceSession.create(...)`).
    // isRecord() alone would wrongly reject it, since classes report typeof
    // "function"; accept either shape (object or function) as long as it
    // actually carries a callable `.create`. The callable is captured into its
    // own local const (createSessionFunction) rather than re-read as a
    // property off `inferenceSession` later, since TS narrowing of a property
    // access does not persist into the nested createSession() closure below —
    // only a narrowed local variable's does.
    if (!isCallableRecord(inferenceSession) || typeof tensorConstructor !== "function") {
        throw new MemexError("MODEL_ASSET_CORRUPT", "Vendored ONNX Runtime package does not export the expected API.");
    }
    const createSessionFunction = inferenceSession.create;
    if (typeof createSessionFunction !== "function") {
        throw new MemexError("MODEL_ASSET_CORRUPT", "Vendored ONNX Runtime package does not export the expected API.");
    }
    return {
        async createSession(modelPathOrBuffer) {
            const result = await Reflect.apply(createSessionFunction, inferenceSession, [modelPathOrBuffer]);
            const record = asRecord(result);
            if (typeof record.run !== "function")
                throw new MemexError("MODEL_ASSET_CORRUPT", "ONNX Runtime session is missing run().");
            const runFunction = record.run;
            const rawInputNames = record.inputNames;
            const inputNames = Array.isArray(rawInputNames) && rawInputNames.every((name) => typeof name === "string")
                ? rawInputNames
                : ["input_ids", "attention_mask"];
            return {
                inputNames,
                async run(feeds) {
                    const output = await Reflect.apply(runFunction, record, [feeds]);
                    return asTensorRecord(output);
                },
            };
        },
        createTensor(type, data, dims) {
            const constructed = Reflect.construct(tensorConstructor, [type, data, dims]);
            // Validate the shape but return the *original* constructed instance,
            // not a reconstructed {dims,data} copy (asTensor(), used for reading
            // session.run() outputs, intentionally does that unwrap). The real
            // vendored onnxruntime Tensor carries internal state beyond dims/data
            // (e.g. its data location) that the actual session.run() requires on
            // feed tensors — confirmed empirically: feeding a reconstructed plain
            // {dims,data} object throws "invalid data location: undefined" from
            // the real ORT runtime, even though it structurally satisfies
            // OrtTensorLike. Output tensors are only ever read from, never fed
            // back into another run(), so asTensor()'s reconstruction remains
            // correct and sufficient for that path.
            assertTensorShape(constructed);
            return constructed;
        },
    };
}
async function runInference(runtime, session, tokenizer, text) {
    const ids = tokenizer.encode(text);
    if (ids.length === 0)
        throw new MemexError("EMBEDDING_FAILURE", "Tokenizer produced an empty sequence.");
    const seqLen = ids.length;
    const feeds = {
        // Single-sequence-per-call design (no batching/padding): the attention
        // mask is always all-ones, so mean pooling below needs no masking.
        input_ids: runtime.createTensor("int64", BigInt64Array.from(ids, (value) => BigInt(value)), [1, seqLen]),
        attention_mask: runtime.createTensor("int64", BigInt64Array.from({ length: seqLen }, () => 1n), [1, seqLen]),
    };
    if (session.inputNames.includes("token_type_ids")) {
        feeds.token_type_ids = runtime.createTensor("int64", BigInt64Array.from({ length: seqLen }, () => 0n), [1, seqLen]);
    }
    let output;
    try {
        output = await session.run(feeds);
    }
    catch {
        throw new MemexError("EMBEDDING_FAILURE", "ONNX Runtime inference failed.");
    }
    const hiddenTensor = output.last_hidden_state ?? Object.values(output)[0];
    if (hiddenTensor === undefined)
        throw new MemexError("EMBEDDING_FAILURE", "ONNX Runtime returned no output tensor.");
    const [batch, tensorSeqLen, dims] = hiddenTensor.dims;
    if (batch !== 1 || tensorSeqLen !== seqLen || dims !== DIMS)
        throw new MemexError("EMBEDDING_FAILURE", "ONNX Runtime output tensor has an unexpected shape.");
    return l2Normalize(meanPool(toFloat32(hiddenTensor.data), seqLen, DIMS));
}
function toFloat32(data) {
    const output = new Float32Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
        const value = data[index];
        output[index] = typeof value === "bigint" ? Number(value) : (value ?? 0);
    }
    return output;
}
function meanPool(hidden, seqLen, dims) {
    const pooled = new Float32Array(dims);
    for (let t = 0; t < seqLen; t += 1)
        for (let d = 0; d < dims; d += 1)
            pooled[d] = (pooled[d] ?? 0) + (hidden[t * dims + d] ?? 0);
    const denom = seqLen > 0 ? seqLen : 1;
    for (let d = 0; d < dims; d += 1)
        pooled[d] = (pooled[d] ?? 0) / denom;
    return pooled;
}
function l2Normalize(vector) {
    let sumSquares = 0;
    for (const value of vector)
        sumSquares += value * value;
    const norm = Math.sqrt(sumSquares) || 1;
    const output = new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index += 1)
        output[index] = (vector[index] ?? 0) / norm;
    return output;
}
function parseManifest(value) {
    if (!isRecord(value) || !Array.isArray(value.assets))
        throw new MemexError("MODEL_ASSET_CORRUPT", "Vendor asset manifest is invalid.");
    return { assets: value.assets.map(parseManifestEntry) };
}
function parseManifestEntry(value) {
    if (!isRecord(value) ||
        typeof value.path !== "string" || value.path.length === 0 ||
        !isNonNegativeInteger(value.bytes) ||
        typeof value.license !== "string" || typeof value.upstream !== "string" || typeof value.revision !== "string") {
        throw new MemexError("MODEL_ASSET_CORRUPT", "Vendor asset manifest entry is invalid.");
    }
    const hasSingleHash = typeof value.sha256 === "string";
    const hasSplitParts = Array.isArray(value.parts);
    if (hasSingleHash === hasSplitParts) {
        // A manifest entry describes either one unsplit file (sha256) or a
        // split asset (assembled_sha256 + parts) — never both, never neither.
        throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${value.path} must declare exactly one of sha256 or parts.`);
    }
    const base = { path: value.path, bytes: value.bytes, license: value.license, upstream: value.upstream, revision: value.revision };
    if (hasSingleHash) {
        const sha256 = value.sha256;
        if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256))
            throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${value.path} has an invalid sha256.`);
        return { ...base, sha256 };
    }
    const assembledSha256 = value.assembled_sha256;
    if (typeof assembledSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(assembledSha256))
        throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${value.path} has an invalid assembled_sha256.`);
    // Captured into a local const: TS narrowing of a property access
    // (value.path) does not persist inside a nested closure, only a narrowed
    // local variable's does.
    const entryPath = value.path;
    const parts = value.parts.map((part) => parseManifestPart(part, entryPath));
    parts.forEach((part, index) => {
        if (!part.path.endsWith(`.part${String(index)}`))
            throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset manifest parts for ${entryPath} must be declared in order part0, part1, ....`);
    });
    return { ...base, assembledSha256, parts };
}
function parseManifestPart(value, parentPath) {
    if (!isRecord(value) ||
        typeof value.path !== "string" || value.path.length === 0 ||
        typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sha256) ||
        !isNonNegativeInteger(value.bytes)) {
        throw new MemexError("MODEL_ASSET_CORRUPT", `Vendor asset manifest part entry for ${parentPath} is invalid.`);
    }
    return { path: value.path, sha256: value.sha256, bytes: value.bytes };
}
function asRecord(value) {
    if (!isRecord(value))
        throw new MemexError("MODEL_ASSET_CORRUPT", "Vendored ONNX Runtime Web module returned an invalid value.");
    return value;
}
function asTensor(value) {
    const record = asRecord(value);
    if (!Array.isArray(record.dims) || record.data === undefined || record.data === null)
        throw new MemexError("MODEL_ASSET_CORRUPT", "ONNX Runtime Tensor has an unexpected shape.");
    return { dims: record.dims, data: record.data };
}
// Validates shape only, without reconstructing a copy — see createTensor()'s
// comment for why the original constructed Tensor instance must be preserved
// for feed tensors.
function assertTensorShape(value) {
    const record = asRecord(value);
    if (!Array.isArray(record.dims) || record.data === undefined || record.data === null)
        throw new MemexError("MODEL_ASSET_CORRUPT", "ONNX Runtime Tensor has an unexpected shape.");
}
function asTensorRecord(value) {
    const record = asRecord(value);
    const result = {};
    for (const [key, entry] of Object.entries(record))
        result[key] = asTensor(entry);
    return result;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
// Broader than isRecord(): also accepts a function/class (typeof "function"),
// since the real vendored ONNX Runtime exports InferenceSession as a class
// with a static create() method, not a plain object literal. Property access
// works identically on both at runtime; this only widens the type-level check.
function isCallableRecord(value) {
    return value !== null && (typeof value === "object" || typeof value === "function") && !Array.isArray(value);
}
// Matches the `nonNegativeInteger`/`positiveLine`-style type-predicate helpers
// already used in graph-store.ts/chunk.ts: Number.isSafeInteger itself is not
// a TS type predicate, so a bare `!Number.isSafeInteger(value.bytes)` guard
// leaves value.bytes typed unknown afterward (TS18046/TS2322 at build time).
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
