import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, withFileWriteLock } from "./atomic.js";
import { parseChunkRef, type ChunkRef } from "./chunk.js";
import { MemexError } from "./errors.js";

export interface LexicalIndex {
  upsert(chunks: ReadonlyArray<{ ref: ChunkRef; text: string }>): Promise<void>;
  search(query: string, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TRIGRAM_WEIGHT = 0.01;
const WRITE_LOCK_WAIT_MS = 50;
const STALE_LOCK_MS = 5 * 60 * 1000;

interface Posting { id: string; frequency: number; }
interface BucketEntry { ref: ChunkRef; termFrequencies: Record<string, number>; length: number; }
interface LexicalManifest {
  schemaVersion: 1;
  k1: number;
  b: number;
  totalDocs: number;
  totalLength: number;
  documentFrequency: Record<string, number>;
  postings: Record<string, Posting[]>;
  trigramPostings: Record<string, string[]>;
  lengths: Record<string, number>;
  chunks: Array<{ ref: ChunkRef; bucket: string }>;
}

export async function openLexicalIndex(storageRoot: string): Promise<LexicalIndex> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(storageRoot, "manifest.json");
  const lockPath = path.join(storageRoot, "writer.lock");

  const readManifest = async (): Promise<LexicalManifest> => {
    try {
      return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    } catch {
      return emptyManifest();
    }
  };

  return {
    async upsert(chunks) {
      await withFileWriteLock(lockPath, async () => {
        const manifest = await readManifest();
        const chunksById = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry]));
        // Bucket contents are cached and mutated in memory for the whole
        // batch, then each touched bucket is written to disk exactly once at
        // the end — mirroring vector-store.ts's touchedBuckets pattern. The
        // previous per-document read-modify-write (readBucketFile + filter +
        // atomicWriteFile per chunk) made every single upsert() call in a
        // large batch re-read and rewrite its entire, growing bucket file —
        // an O(n^2) I/O cost at real corpus scale. Measured building this
        // repository's own ~4.3k symbols: this dominated the reindex, taking
        // longer than the real embedding step itself. Loading each bucket
        // once and writing once bounds bucket I/O to O(distinct touched
        // buckets) regardless of batch size.
        const bucketCache = new Map<string, Map<string, BucketEntry>>();
        const loadBucket = async (bucket: string): Promise<Map<string, BucketEntry>> => {
          const cached = bucketCache.get(bucket);
          if (cached !== undefined) return cached;
          const entries = new Map((await readBucketFile(storageRoot, bucket)).map((entry) => [entry.ref.id, entry]));
          bucketCache.set(bucket, entries);
          return entries;
        };
        for (const entry of chunks) {
          const existing = chunksById.get(entry.ref.id);
          if (existing !== undefined && existing.ref.contentHash === entry.ref.contentHash) continue;
          if (existing !== undefined) {
            const existingBucketEntries = await loadBucket(existing.bucket);
            const previous = existingBucketEntries.get(existing.ref.id);
            if (previous !== undefined) {
              removeDocument(manifest, existing.ref.id, previous);
              existingBucketEntries.delete(existing.ref.id);
            }
          }
          const tokens = tokenize(entry.text);
          const frequencies = frequencyMap(tokens);
          const bucket = bucketFor(entry.ref.contentHash);
          addDocument(manifest, entry.ref, frequencies, tokens.length);
          const bucketEntries = await loadBucket(bucket);
          bucketEntries.set(entry.ref.id, { ref: entry.ref, termFrequencies: frequencies, length: tokens.length });
          chunksById.set(entry.ref.id, { ref: entry.ref, bucket });
        }
        for (const [bucket, entries] of bucketCache) {
          const sorted = [...entries.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
          await atomicWriteFile(path.join(storageRoot, "segments", `${bucket}.json`), `${JSON.stringify(sorted)}\n`);
        }
        manifest.chunks = [...chunksById.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
        await atomicWriteFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
    },
    async search(query, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MemexError("INVALID_ARGUMENT", "Lexical search limit must be between 1 and 200.");
      const trimmed = query.trim();
      if (trimmed.length === 0) throw new MemexError("INVALID_ARGUMENT", "Lexical search query must not be empty.");
      const manifest = await readManifest();
      if (manifest.totalDocs === 0) return [];
      const byId = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref]));
      const avgdl = manifest.totalLength / manifest.totalDocs;
      const scores = new Map<string, number>();
      for (const term of tokenize(trimmed)) {
        const df = manifest.documentFrequency[term] ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (manifest.totalDocs - df + 0.5) / (df + 0.5));
        for (const posting of manifest.postings[term] ?? []) {
          const length = manifest.lengths[posting.id] ?? avgdl;
          const termScore = (idf * (posting.frequency * (BM25_K1 + 1))) / (posting.frequency + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgdl));
          scores.set(posting.id, (scores.get(posting.id) ?? 0) + termScore);
        }
      }
      const queryTrigrams = trigramsOf(trimmed);
      if (queryTrigrams.length > 0) {
        for (const trigram of queryTrigrams) {
          for (const id of manifest.trigramPostings[trigram] ?? []) scores.set(id, (scores.get(id) ?? 0) + TRIGRAM_WEIGHT / queryTrigrams.length);
        }
      }
      const results: Array<{ ref: ChunkRef; score: number }> = [];
      for (const [id, score] of scores) {
        const ref = byId.get(id);
        if (ref !== undefined) results.push({ ref, score });
      }
      return results.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
    },
  };
}

function emptyManifest(): LexicalManifest {
  return { schemaVersion: 1, k1: BM25_K1, b: BM25_B, totalDocs: 0, totalLength: 0, documentFrequency: emptyDict(), postings: emptyDict(), trigramPostings: emptyDict(), lengths: emptyDict(), chunks: [] };
}

// Object.create(null), not {}: every dictionary in this file is keyed by
// arbitrary real-world tokens extracted from indexed text (BM25 terms,
// trigrams) — not hashes — and a plain {} inherits Object.prototype members
// ("constructor", "toString", "valueOf", ...). Any indexed symbol literally
// named "constructor" (every class constructor method) tokenizes to that
// exact word, so `postings["constructor"] ?? []` would resolve to the
// inherited Object constructor function instead of the intended fallback
// array — confirmed to crash (`.filter is not a function`) and silently
// corrupt documentFrequency (string-concatenates instead of incrementing) in
// this exact codebase (graph-index.ts's own errors.ts has a constructor()).
// A null-prototype object has no inherited members, so every lookup for a
// key not yet explicitly set is genuinely undefined. Serializes identically
// to plain-object JSON (JSON.stringify/Object.entries only consider own
// enumerable properties), so the on-disk manifest format is unchanged.
function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function frequencyMap(tokens: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = emptyDict();
  for (const token of tokens) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}

function trigramsOf(text: string): string[] {
  const normalized = tokenize(text).join(" ");
  const trigrams = new Set<string>();
  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    const trigram = normalized.slice(index, index + 3);
    if (!trigram.includes(" ")) trigrams.add(trigram);
  }
  return [...trigrams].sort();
}

function bucketFor(contentHash: string): string {
  const first = contentHash[0]?.toLowerCase();
  if (first === undefined || !/^[0-9a-f]$/u.test(first)) throw new MemexError("INVALID_STATE", "Chunk contentHash must be a lowercase hex hash.");
  return first;
}

// Appends directly (no filter/includes-then-spread rebuild): upsert()'s loop
// (openLexicalIndex above) always calls removeDocument for any chunk id
// already present *before* calling addDocument, so by the time addDocument
// runs, no stale posting for this ref.id can already exist in any of these
// arrays — the append is always adding a genuinely new entry, never
// deduplicating one. The previous filter/includes-then-spread pattern
// reallocated and rescanned the entire (growing) postings/trigramPostings
// array on every single call — an O(n) cost per insert, O(n^2) total across
// a corpus — measured as the dominant cost (more than real embedding)
// reindexing this repository's own ~4.3k symbols. addDocument/removeDocument
// are private to this module and only ever called from upsert()'s loop, so
// this invariant is enforced locally, not by an external contract.
function addDocument(manifest: LexicalManifest, ref: ChunkRef, frequencies: Record<string, number>, length: number): void {
  manifest.totalDocs += 1;
  manifest.totalLength += length;
  manifest.lengths[ref.id] = length;
  for (const [term, frequency] of Object.entries(frequencies)) {
    manifest.documentFrequency[term] = (manifest.documentFrequency[term] ?? 0) + 1;
    const postings = manifest.postings[term];
    if (postings === undefined) manifest.postings[term] = [{ id: ref.id, frequency }];
    else postings.push({ id: ref.id, frequency });
  }
  for (const trigram of trigramsOf(Object.keys(frequencies).join(" "))) {
    const ids = manifest.trigramPostings[trigram];
    if (ids === undefined) manifest.trigramPostings[trigram] = [ref.id];
    else ids.push(ref.id);
  }
}

function removeDocument(manifest: LexicalManifest, id: string, previous: BucketEntry): void {
  manifest.totalDocs = Math.max(0, manifest.totalDocs - 1);
  manifest.totalLength = Math.max(0, manifest.totalLength - previous.length);
  // Reflect.deleteProperty instead of `delete obj[dynamicKey]`: the codebase's
  // existing `delete` usages (cli.ts) all target literal, statically-known
  // property names; @typescript-eslint/no-dynamic-delete flags a computed key
  // like these (id/term/trigram are variables), and Reflect.deleteProperty is
  // the behaviorally identical, assertion-free replacement.
  Reflect.deleteProperty(manifest.lengths, id);
  for (const term of Object.keys(previous.termFrequencies)) {
    const df = (manifest.documentFrequency[term] ?? 1) - 1;
    if (df <= 0) Reflect.deleteProperty(manifest.documentFrequency, term);
    else manifest.documentFrequency[term] = df;
    const remaining = (manifest.postings[term] ?? []).filter((posting) => posting.id !== id);
    if (remaining.length === 0) Reflect.deleteProperty(manifest.postings, term);
    else manifest.postings[term] = remaining;
  }
  for (const trigram of trigramsOf(Object.keys(previous.termFrequencies).join(" "))) {
    const remaining = (manifest.trigramPostings[trigram] ?? []).filter((entry) => entry !== id);
    if (remaining.length === 0) Reflect.deleteProperty(manifest.trigramPostings, trigram);
    else manifest.trigramPostings[trigram] = remaining;
  }
}

async function readBucketFile(storageRoot: string, bucket: string): Promise<BucketEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(storageRoot, "segments", `${bucket}.json`), "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new MemexError("INVALID_STATE", "Lexical index segment is invalid.");
    return parsed.map(parseBucketEntry);
  } catch (error) {
    if (error instanceof MemexError) throw error;
    return [];
  }
}

function parseBucketEntry(value: unknown): BucketEntry {
  if (!isRecord(value) || !isRecord(value.termFrequencies) || !isNonNegativeInteger(value.length)) throw new MemexError("INVALID_STATE", "Lexical index segment entry is invalid.");
  const termFrequencies: Record<string, number> = emptyDict();
  for (const [term, count] of Object.entries(value.termFrequencies)) {
    if (!isNonNegativeInteger(count)) throw new MemexError("INVALID_STATE", "Lexical index segment entry is invalid.");
    termFrequencies[term] = count;
  }
  return { ref: parseChunkRef(value.ref), termFrequencies, length: value.length };
}

function parseManifest(value: unknown): LexicalManifest {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || value.k1 !== BM25_K1 || value.b !== BM25_B ||
    !isNonNegativeInteger(value.totalDocs) || !isFiniteNumber(value.totalLength) ||
    !isRecord(value.documentFrequency) || !isRecord(value.postings) || !isRecord(value.trigramPostings) ||
    !isRecord(value.lengths) || !Array.isArray(value.chunks)
  ) {
    throw new MemexError("INVALID_STATE", "Lexical index manifest is invalid.");
  }
  return {
    schemaVersion: 1,
    k1: BM25_K1,
    b: BM25_B,
    totalDocs: value.totalDocs,
    totalLength: value.totalLength,
    documentFrequency: parseNumberRecord(value.documentFrequency),
    postings: parsePostings(value.postings),
    trigramPostings: parseStringListRecord(value.trigramPostings),
    lengths: parseNumberRecord(value.lengths),
    chunks: value.chunks.map(parseManifestChunk).sort((left, right) => left.ref.id.localeCompare(right.ref.id)),
  };
}

function parseManifestChunk(value: unknown): LexicalManifest["chunks"][number] {
  if (!isRecord(value) || typeof value.bucket !== "string" || !/^[0-9a-f]$/u.test(value.bucket)) throw new MemexError("INVALID_STATE", "Lexical index manifest chunk is invalid.");
  return { ref: parseChunkRef(value.ref), bucket: value.bucket };
}

function parseNumberRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = emptyDict();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw new MemexError("INVALID_STATE", "Lexical index manifest is invalid.");
    result[key] = entry;
  }
  return result;
}

function parseStringListRecord(value: Record<string, unknown>): Record<string, string[]> {
  const result: Record<string, string[]> = emptyDict();
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) throw new MemexError("INVALID_STATE", "Lexical index manifest is invalid.");
    result[key] = entry;
  }
  return result;
}

function parsePostings(value: Record<string, unknown>): Record<string, Posting[]> {
  const result: Record<string, Posting[]> = emptyDict();
  for (const [term, entry] of Object.entries(value)) {
    if (!Array.isArray(entry)) throw new MemexError("INVALID_STATE", "Lexical index manifest is invalid.");
    result[term] = entry.map((posting) => {
      if (!isRecord(posting) || typeof posting.id !== "string" || !isNonNegativeInteger(posting.frequency)) throw new MemexError("INVALID_STATE", "Lexical index manifest is invalid.");
      return { id: posting.id, frequency: posting.frequency };
    });
  }
  return result;
}

// Number.isSafeInteger is not itself a TS type predicate, so a bare
// !Number.isSafeInteger(x) guard leaves x typed unknown afterward — matches
// the nonNegativeInteger/positiveLine convention in graph-store.ts/chunk.ts.
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
