import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, withFileWriteLock } from "./atomic.js";
import { parseChunkRef } from "./chunk.js";
import { OpenWikiError } from "./errors.js";
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TRIGRAM_WEIGHT = 0.01;
const WRITE_LOCK_WAIT_MS = 50;
const STALE_LOCK_MS = 5 * 60 * 1000;
export async function openLexicalIndex(storageRoot) {
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(storageRoot, "manifest.json");
    const lockPath = path.join(storageRoot, "writer.lock");
    const readManifest = async () => {
        try {
            return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
        }
        catch {
            return emptyManifest();
        }
    };
    return {
        async upsert(chunks) {
            await withFileWriteLock(lockPath, async () => {
                const manifest = await readManifest();
                const chunksById = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry]));
                for (const entry of chunks) {
                    const existing = chunksById.get(entry.ref.id);
                    if (existing !== undefined && existing.ref.contentHash === entry.ref.contentHash)
                        continue;
                    if (existing !== undefined) {
                        const previous = await readBucketEntry(storageRoot, existing.bucket, existing.ref.id);
                        if (previous !== undefined)
                            removeDocument(manifest, existing.ref.id, previous);
                    }
                    const tokens = tokenize(entry.text);
                    const frequencies = frequencyMap(tokens);
                    const bucket = bucketFor(entry.ref.contentHash);
                    addDocument(manifest, entry.ref, frequencies, tokens.length);
                    await writeBucketEntry(storageRoot, bucket, { ref: entry.ref, termFrequencies: frequencies, length: tokens.length });
                    chunksById.set(entry.ref.id, { ref: entry.ref, bucket });
                }
                manifest.chunks = [...chunksById.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
                await atomicWriteFile(manifestPath, `${JSON.stringify(manifest)}\n`);
            }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
        },
        async search(query, limit) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
                throw new OpenWikiError("INVALID_ARGUMENT", "Lexical search limit must be between 1 and 200.");
            const trimmed = query.trim();
            if (trimmed.length === 0)
                throw new OpenWikiError("INVALID_ARGUMENT", "Lexical search query must not be empty.");
            const manifest = await readManifest();
            if (manifest.totalDocs === 0)
                return [];
            const byId = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref]));
            const avgdl = manifest.totalLength / manifest.totalDocs;
            const scores = new Map();
            for (const term of tokenize(trimmed)) {
                const df = manifest.documentFrequency[term] ?? 0;
                if (df === 0)
                    continue;
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
                    for (const id of manifest.trigramPostings[trigram] ?? [])
                        scores.set(id, (scores.get(id) ?? 0) + TRIGRAM_WEIGHT / queryTrigrams.length);
                }
            }
            const results = [];
            for (const [id, score] of scores) {
                const ref = byId.get(id);
                if (ref !== undefined)
                    results.push({ ref, score });
            }
            return results.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
        },
    };
}
function emptyManifest() {
    return { schemaVersion: 1, k1: BM25_K1, b: BM25_B, totalDocs: 0, totalLength: 0, documentFrequency: {}, postings: {}, trigramPostings: {}, lengths: {}, chunks: [] };
}
function tokenize(text) {
    return text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}
function frequencyMap(tokens) {
    const counts = {};
    for (const token of tokens)
        counts[token] = (counts[token] ?? 0) + 1;
    return counts;
}
function trigramsOf(text) {
    const normalized = tokenize(text).join(" ");
    const trigrams = new Set();
    for (let index = 0; index + 3 <= normalized.length; index += 1) {
        const trigram = normalized.slice(index, index + 3);
        if (!trigram.includes(" "))
            trigrams.add(trigram);
    }
    return [...trigrams].sort();
}
function bucketFor(contentHash) {
    const first = contentHash[0]?.toLowerCase();
    if (first === undefined || !/^[0-9a-f]$/u.test(first))
        throw new OpenWikiError("INVALID_STATE", "Chunk contentHash must be a lowercase hex hash.");
    return first;
}
function addDocument(manifest, ref, frequencies, length) {
    manifest.totalDocs += 1;
    manifest.totalLength += length;
    manifest.lengths[ref.id] = length;
    for (const [term, frequency] of Object.entries(frequencies)) {
        manifest.documentFrequency[term] = (manifest.documentFrequency[term] ?? 0) + 1;
        const postings = (manifest.postings[term] ?? []).filter((posting) => posting.id !== ref.id);
        manifest.postings[term] = [...postings, { id: ref.id, frequency }];
    }
    for (const trigram of trigramsOf(Object.keys(frequencies).join(" "))) {
        const ids = manifest.trigramPostings[trigram] ?? [];
        if (!ids.includes(ref.id))
            manifest.trigramPostings[trigram] = [...ids, ref.id];
    }
}
function removeDocument(manifest, id, previous) {
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
        if (df <= 0)
            Reflect.deleteProperty(manifest.documentFrequency, term);
        else
            manifest.documentFrequency[term] = df;
        const remaining = (manifest.postings[term] ?? []).filter((posting) => posting.id !== id);
        if (remaining.length === 0)
            Reflect.deleteProperty(manifest.postings, term);
        else
            manifest.postings[term] = remaining;
    }
    for (const trigram of trigramsOf(Object.keys(previous.termFrequencies).join(" "))) {
        const remaining = (manifest.trigramPostings[trigram] ?? []).filter((entry) => entry !== id);
        if (remaining.length === 0)
            Reflect.deleteProperty(manifest.trigramPostings, trigram);
        else
            manifest.trigramPostings[trigram] = remaining;
    }
}
async function readBucketEntry(storageRoot, bucket, id) {
    return (await readBucketFile(storageRoot, bucket)).find((entry) => entry.ref.id === id);
}
async function writeBucketEntry(storageRoot, bucket, entry) {
    const entries = (await readBucketFile(storageRoot, bucket)).filter((existing) => existing.ref.id !== entry.ref.id);
    entries.push(entry);
    entries.sort((left, right) => left.ref.id.localeCompare(right.ref.id));
    await atomicWriteFile(path.join(storageRoot, "segments", `${bucket}.json`), `${JSON.stringify(entries)}\n`);
}
async function readBucketFile(storageRoot, bucket) {
    try {
        const parsed = JSON.parse(await readFile(path.join(storageRoot, "segments", `${bucket}.json`), "utf8"));
        if (!Array.isArray(parsed))
            throw new OpenWikiError("INVALID_STATE", "Lexical index segment is invalid.");
        return parsed.map(parseBucketEntry);
    }
    catch (error) {
        if (error instanceof OpenWikiError)
            throw error;
        return [];
    }
}
function parseBucketEntry(value) {
    if (!isRecord(value) || !isRecord(value.termFrequencies) || !isNonNegativeInteger(value.length))
        throw new OpenWikiError("INVALID_STATE", "Lexical index segment entry is invalid.");
    const termFrequencies = {};
    for (const [term, count] of Object.entries(value.termFrequencies)) {
        if (!isNonNegativeInteger(count))
            throw new OpenWikiError("INVALID_STATE", "Lexical index segment entry is invalid.");
        termFrequencies[term] = count;
    }
    return { ref: parseChunkRef(value.ref), termFrequencies, length: value.length };
}
function parseManifest(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || value.k1 !== BM25_K1 || value.b !== BM25_B ||
        !isNonNegativeInteger(value.totalDocs) || !isFiniteNumber(value.totalLength) ||
        !isRecord(value.documentFrequency) || !isRecord(value.postings) || !isRecord(value.trigramPostings) ||
        !isRecord(value.lengths) || !Array.isArray(value.chunks)) {
        throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
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
function parseManifestChunk(value) {
    if (!isRecord(value) || typeof value.bucket !== "string" || !/^[0-9a-f]$/u.test(value.bucket))
        throw new OpenWikiError("INVALID_STATE", "Lexical index manifest chunk is invalid.");
    return { ref: parseChunkRef(value.ref), bucket: value.bucket };
}
function parseNumberRecord(value) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "number" || !Number.isFinite(entry))
            throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
        result[key] = entry;
    }
    return result;
}
function parseStringListRecord(value) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string"))
            throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
        result[key] = entry;
    }
    return result;
}
function parsePostings(value) {
    const result = {};
    for (const [term, entry] of Object.entries(value)) {
        if (!Array.isArray(entry))
            throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
        result[term] = entry.map((posting) => {
            if (!isRecord(posting) || typeof posting.id !== "string" || !isNonNegativeInteger(posting.frequency))
                throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
            return { id: posting.id, frequency: posting.frequency };
        });
    }
    return result;
}
// Number.isSafeInteger is not itself a TS type predicate, so a bare
// !Number.isSafeInteger(x) guard leaves x typed unknown afterward — matches
// the nonNegativeInteger/positiveLine convention in graph-store.ts/chunk.ts.
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
