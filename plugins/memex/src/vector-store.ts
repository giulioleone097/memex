import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteBinaryFile, atomicWriteFile, withFileWriteLock } from "./atomic.js";
import { parseChunkRef, type ChunkRef } from "./chunk.js";
import { MemexError } from "./errors.js";

export interface VectorStore {
  upsert(entries: ReadonlyArray<{ ref: ChunkRef; vector: Float32Array }>): Promise<{ written: number; reused: number }>;
  search(vector: Float32Array, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>;
  status(): Promise<{ modelId: string; dims: number; chunks: number; compatible: boolean; embeddingsAvailable: boolean; unavailableReason?: string }>;
}

interface VectorModel { modelId: string; modelRevision: string; dims: number; }
interface VectorManifest extends VectorModel {
  schemaVersion: 1;
  dtype: "int8";
  chunks: Array<{ ref: ChunkRef; bucket: string }>;
  segments: Array<{ bucket: string; file: string; contentHash: string; count: number }>;
  embeddingsAvailable: boolean;
  unavailableReason?: string;
}

const SEGMENT_MAGIC = "MXVS";
const HEADER_BYTES = 16;
const ID_BYTES = 64;
const WRITE_LOCK_WAIT_MS = 50;
const STALE_LOCK_MS = 5 * 60 * 1000;

export async function openVectorStore(storageRoot: string, model: VectorModel): Promise<VectorStore> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(storageRoot, "manifest.json");
  const lockPath = path.join(storageRoot, "writer.lock");

  const readManifest = async (): Promise<VectorManifest | undefined> => {
    try {
      return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    } catch {
      return undefined;
    }
  };

  return {
    async upsert(entries) {
      return withFileWriteLock(lockPath, async () => {
        const manifest = (await readManifest()) ?? emptyManifest(model);
        if (manifest.modelId !== model.modelId || manifest.dims !== model.dims) throw new MemexError("INDEX_INCOMPATIBLE", "Vector store manifest does not match the active embedding model.");
        const chunksById = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry]));
        let written = 0;
        let reused = 0;
        const touchedBuckets = new Set<string>();
        const freshById = new Map(entries.map((entry) => [entry.ref.id, entry]));
        for (const entry of entries) {
          const existing = chunksById.get(entry.ref.id);
          if (existing !== undefined && existing.ref.contentHash === entry.ref.contentHash) {
            reused += 1;
            continue;
          }
          if (existing !== undefined) touchedBuckets.add(existing.bucket);
          const bucket = bucketFor(entry.ref.contentHash);
          touchedBuckets.add(bucket);
          chunksById.set(entry.ref.id, { ref: entry.ref, bucket });
          written += 1;
        }
        // Content-addresses each segment file (TP.2 review I1): buckets left
        // untouched this round carry forward their previous contentHash;
        // touched buckets get a freshly computed one from the bytes just
        // written. Every bucket that ends up in segmentCounts below is
        // guaranteed to have an entry here by construction (see the throw
        // in the segments map below if that invariant is ever violated).
        const bucketContentHashes = new Map(manifest.segments.map((segment) => [segment.bucket, segment.contentHash]));
        for (const bucket of touchedBuckets) {
          const rows: Array<{ ref: ChunkRef; vector: Int8Array }> = [];
          for (const entry of chunksById.values()) {
            if (entry.bucket !== bucket) continue;
            const fresh = freshById.get(entry.ref.id);
            if (fresh !== undefined) {
              rows.push({ ref: entry.ref, vector: quantize(fresh.vector) });
              continue;
            }
            const preserved = await readBucketRow(storageRoot, bucket, entry.ref.id, model.dims);
            if (preserved !== undefined) rows.push({ ref: entry.ref, vector: preserved });
          }
          const encoded = encodeBucket(rows, model.dims);
          await atomicWriteBinaryFile(path.join(storageRoot, "segments", `${bucket}.bin`), encoded);
          bucketContentHashes.set(bucket, createHash("sha256").update(encoded).digest("hex"));
        }
        const chunks = [...chunksById.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
        const segmentCounts = new Map<string, number>();
        for (const entry of chunks) segmentCounts.set(entry.bucket, (segmentCounts.get(entry.bucket) ?? 0) + 1);
        const segments = [...segmentCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, count]) => {
          const contentHash = bucketContentHashes.get(bucket);
          if (contentHash === undefined) throw new MemexError("INVALID_STATE", `Vector segment ${bucket} is missing a content hash.`);
          return { bucket, file: `${bucket}.bin`, contentHash, count };
        });
        const nextManifest: VectorManifest = {
          schemaVersion: 1,
          modelId: model.modelId,
          modelRevision: model.modelRevision,
          dims: model.dims,
          dtype: "int8",
          chunks,
          segments,
          // A successful upsert always proves embeddings are currently
          // available — this clears any earlier markEmbeddingsUnavailable
          // flag (TP.2 review C2) rather than requiring a separate reset call.
          embeddingsAvailable: true,
        };
        await atomicWriteFile(manifestPath, `${JSON.stringify(nextManifest)}\n`);
        return { written, reused };
      }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
    },
    async search(vector, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MemexError("INVALID_ARGUMENT", "Vector search limit must be between 1 and 200.");
      const manifest = await readManifest();
      if (manifest === undefined || manifest.chunks.length === 0) return [];
      if (manifest.modelId !== model.modelId || manifest.dims !== model.dims) throw new MemexError("INDEX_INCOMPATIBLE", "Vector store manifest does not match the active embedding model.");
      const byId = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref]));
      const scored: Array<{ ref: ChunkRef; score: number }> = [];
      for (const segment of manifest.segments) {
        for (const row of await readBucketFile(storageRoot, segment.bucket, model.dims)) {
          const ref = byId.get(row.id);
          if (ref === undefined) continue;
          scored.push({ ref, score: dotProduct(vector, dequantize(row.vector)) });
        }
      }
      return scored.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
    },
    async status() {
      const manifest = await readManifest();
      if (manifest === undefined) return { modelId: model.modelId, dims: model.dims, chunks: 0, compatible: true, embeddingsAvailable: true };
      return {
        modelId: manifest.modelId,
        dims: manifest.dims,
        chunks: manifest.chunks.length,
        compatible: manifest.modelId === model.modelId && manifest.dims === model.dims,
        embeddingsAvailable: manifest.embeddingsAvailable,
        ...(manifest.unavailableReason === undefined ? {} : { unavailableReason: manifest.unavailableReason }),
      };
    },
  };
}

// Read-only, model-agnostic digest of the manifest's current chunk set. Used
// by reindex.ts to decide which chunks need re-embedding before it ever loads
// the (heavy) Embedder — deliberately independent of the model-compatibility
// checks the VectorStore interface enforces, since a digest read must work
// even when the store predates the currently active model.
export async function readVectorChunkDigest(storageRoot: string): Promise<ReadonlyMap<string, string>> {
  let manifest: VectorManifest;
  try {
    manifest = parseManifest(JSON.parse(await readFile(path.join(storageRoot, "manifest.json"), "utf8")) as unknown);
  } catch {
    return new Map();
  }
  return new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref.contentHash]));
}

// Called by reindex.ts's write paths (writePage/buildGraph, via
// reindexWikiPage/reindexCodeSymbols) when the vendor-asset error is caught
// and embedding is soft-skipped rather than failing the write (TP.2 review
// finding C2 / orchestrator adjudication: write paths never hard-fail on
// missing/corrupt vendor assets — only search/ask do). Records the skip
// non-silently in this store's own manifest so status()/doctor surface it,
// rather than the write silently under-indexing forever with no trace.
// Never touches chunks/segments — only the flag.
export async function markEmbeddingsUnavailable(storageRoot: string, model: VectorModel, reason: string): Promise<void> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(storageRoot, "manifest.json");
  const lockPath = path.join(storageRoot, "writer.lock");
  await withFileWriteLock(lockPath, async () => {
    let manifest: VectorManifest;
    try {
      manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    } catch {
      manifest = emptyManifest(model);
    }
    const flagged: VectorManifest = { ...manifest, embeddingsAvailable: false, unavailableReason: reason };
    await atomicWriteFile(manifestPath, `${JSON.stringify(flagged)}\n`);
  }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
}

function emptyManifest(model: VectorModel): VectorManifest {
  return { schemaVersion: 1, modelId: model.modelId, modelRevision: model.modelRevision, dims: model.dims, dtype: "int8", chunks: [], segments: [], embeddingsAvailable: true };
}

function quantize(vector: Float32Array): Int8Array {
  const output = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) output[index] = Math.max(-127, Math.min(127, Math.round((vector[index] ?? 0) * 127)));
  return output;
}

function dequantize(row: Int8Array): Float32Array {
  const output = new Float32Array(row.length);
  for (let index = 0; index < row.length; index += 1) output[index] = (row[index] ?? 0) / 127;
  return output;
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum;
}

function bucketFor(contentHash: string): string {
  const first = contentHash[0]?.toLowerCase();
  if (first === undefined || !/^[0-9a-f]$/u.test(first)) throw new MemexError("INVALID_STATE", "Chunk contentHash must be a lowercase hex hash.");
  return first;
}

function encodeId(id: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new MemexError("INVALID_STATE", "Chunk id must be a 64-character lowercase hex hash.");
  return Buffer.from(id, "ascii");
}

function encodeBucket(rows: ReadonlyArray<{ ref: ChunkRef; vector: Int8Array }>, dims: number): Buffer {
  const sorted = [...rows].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(SEGMENT_MAGIC, 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt16LE(dims, 5);
  header.writeUInt32LE(sorted.length, 7);
  const vectors = Buffer.concat(sorted.map((row) => Buffer.from(row.vector.buffer, row.vector.byteOffset, dims)));
  const ids = Buffer.concat(sorted.map((row) => encodeId(row.ref.id)));
  return Buffer.concat([header, vectors, ids]);
}

async function readBucketFile(storageRoot: string, bucket: string, dims: number): Promise<Array<{ id: string; vector: Int8Array }>> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path.join(storageRoot, "segments", `${bucket}.bin`));
  } catch {
    return [];
  }
  return decodeBucket(buffer, dims);
}

async function readBucketRow(storageRoot: string, bucket: string, id: string, dims: number): Promise<Int8Array | undefined> {
  return (await readBucketFile(storageRoot, bucket, dims)).find((row) => row.id === id)?.vector;
}

function decodeBucket(buffer: Buffer, dims: number): Array<{ id: string; vector: Int8Array }> {
  if (buffer.length < HEADER_BYTES || buffer.toString("ascii", 0, 4) !== SEGMENT_MAGIC) throw new MemexError("MODEL_ASSET_CORRUPT", "Vector segment header is invalid.");
  const dtype = buffer.readUInt8(4);
  const storedDims = buffer.readUInt16LE(5);
  const count = buffer.readUInt32LE(7);
  if (dtype !== 1 || storedDims !== dims) throw new MemexError("INDEX_INCOMPATIBLE", "Vector segment dimensions do not match the active embedding model.");
  const vectorsStart = HEADER_BYTES;
  const idsStart = vectorsStart + count * dims;
  if (buffer.length < idsStart + count * ID_BYTES) throw new MemexError("MODEL_ASSET_CORRUPT", "Vector segment is truncated.");
  const rows: Array<{ id: string; vector: Int8Array }> = [];
  for (let index = 0; index < count; index += 1) {
    const slice = buffer.subarray(vectorsStart + index * dims, vectorsStart + (index + 1) * dims);
    const vector = new Int8Array(dims);
    for (let byteIndex = 0; byteIndex < dims; byteIndex += 1) vector[byteIndex] = slice.readInt8(byteIndex);
    rows.push({ id: buffer.toString("ascii", idsStart + index * ID_BYTES, idsStart + (index + 1) * ID_BYTES), vector });
  }
  return rows;
}

function parseManifest(value: unknown): VectorManifest {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || typeof value.modelId !== "string" || typeof value.modelRevision !== "string" ||
    !isNonNegativeInteger(value.dims) || value.dtype !== "int8" || !Array.isArray(value.chunks) || !Array.isArray(value.segments) ||
    typeof value.embeddingsAvailable !== "boolean" || (value.unavailableReason !== undefined && typeof value.unavailableReason !== "string")
  ) {
    throw new MemexError("MODEL_ASSET_CORRUPT", "Vector store manifest is invalid.");
  }
  return {
    schemaVersion: 1,
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    dims: value.dims,
    dtype: "int8",
    chunks: value.chunks.map(parseManifestChunk).sort((left, right) => left.ref.id.localeCompare(right.ref.id)),
    segments: value.segments.map(parseManifestSegment).sort((left, right) => left.bucket.localeCompare(right.bucket)),
    embeddingsAvailable: value.embeddingsAvailable,
    ...(value.unavailableReason === undefined ? {} : { unavailableReason: value.unavailableReason }),
  };
}

function parseManifestChunk(value: unknown): VectorManifest["chunks"][number] {
  if (!isRecord(value) || !isBucket(value.bucket)) throw new MemexError("MODEL_ASSET_CORRUPT", "Vector store manifest chunk is invalid.");
  return { ref: parseChunkRef(value.ref), bucket: value.bucket };
}

function parseManifestSegment(value: unknown): VectorManifest["segments"][number] {
  if (
    !isRecord(value) || !isBucket(value.bucket) || typeof value.file !== "string" || value.file.length === 0 ||
    typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentHash) || !isNonNegativeInteger(value.count)
  ) {
    throw new MemexError("MODEL_ASSET_CORRUPT", "Vector store manifest segment is invalid.");
  }
  return { bucket: value.bucket, file: value.file, contentHash: value.contentHash, count: value.count };
}

function isBucket(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]$/u.test(value);
}

// Number.isSafeInteger is not itself a TS type predicate, so a bare
// !Number.isSafeInteger(x) guard leaves x typed unknown afterward — matches
// the nonNegativeInteger/positiveLine convention in graph-store.ts/chunk.ts.
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
