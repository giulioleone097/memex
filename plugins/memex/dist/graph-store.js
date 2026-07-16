import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, withFileWriteLock } from "./atomic.js";
import { canonicalizeGraph, graphHash, parseCodeGraph, parseEnrichmentShard, GRAPH_SCANNER_VERSION } from "./graph-contracts.js";
import { MemexError } from "./errors.js";
import { GRAPH_STORE_SCHEMA_VERSION, openGraphIndexGeneration, writeGraphIndexGeneration, } from "./graph-index.js";
import { resolveWikiLocation } from "./paths.js";
import { detectLanguage } from "./graph-scan.js";
const GRAPH_WRITE_LOCK_WAIT_MS = 50;
const GRAPH_STALE_LOCK_MS = 5 * 60 * 1000;
export async function resolveGraphStorage(root, homeDir) {
    const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
    const graphRoot = path.join(location.dataRoot, "graph");
    await mkdir(graphRoot, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(graphRoot);
    return {
        workspaceId: location.workspaceId,
        repositoryRoot: location.workspaceRoot,
        storage: createStorage(graphRoot),
    };
}
export async function probeGraphStorage(root, homeDir) {
    const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
    const storage = createStorage(path.join(location.dataRoot, "graph"));
    const initialized = await isRegularFile(storage.manifestPath);
    return { initialized, storage, workspaceId: location.workspaceId, repositoryRoot: location.workspaceRoot };
}
export async function enumerateRepositoryMetadata(root, limits) {
    const listed = await runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const [indexed, status] = await Promise.all([runGit(root, ["ls-files", "-s", "-z", "--cached"]), runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])]);
    const blobIds = parseGitIndexBlobIds(indexed);
    const dirty = new Set(parsePorcelainPaths(status));
    const paths = [...new Set(listed.split("\0").filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (paths.length > limits.maxFiles)
        throw new MemexError("SOURCE_TOO_LARGE", "Repository exceeds the graph file limit.");
    let total = 0;
    const results = [];
    const diagnostics = [];
    for (const relative of paths) {
        if (excluded(relative))
            continue;
        const absolute = path.resolve(root, relative);
        assertInside(root, absolute);
        let details;
        try {
            details = await lstat(absolute);
        }
        catch (error) {
            if (isNotFound(error))
                continue;
            throw error;
        }
        if (details.isSymbolicLink())
            throw new MemexError("SYMLINK_ESCAPE", "Graph scanner refuses symbolic-link repository files.");
        if (!details.isFile()) {
            // Git reports a nested repository (its own `.git`, not a registered submodule)
            // as a single opaque directory boundary during ls-files/status enumeration
            // instead of descending into it. Recursively indexing it is out of scope (it
            // is a separate workspace), but silently dropping it would leave a real gap
            // in the graph with no signal, so record an explicit diagnostic instead.
            if (details.isDirectory() && (await isEmbeddedGitRepository(absolute))) {
                diagnostics.push({
                    path: normalize(relative).replace(/\/$/u, ""),
                    code: "EMBEDDED_GIT_REPOSITORY_SKIPPED",
                    message: "Directory is itself a Git repository (embedded-git-repo) and was not indexed. Nested repositories are separate workspaces and are not recursively scanned.",
                });
            }
            continue;
        }
        if (details.size > limits.maxFileBytes)
            throw new MemexError("SOURCE_TOO_LARGE", "A repository file exceeds the graph file size limit.");
        total += details.size;
        if (total > limits.maxRepositoryBytes)
            throw new MemexError("SOURCE_TOO_LARGE", "Repository exceeds the graph byte limit.");
        const normalized = normalize(relative);
        const blob = blobIds.get(normalized);
        results.push({ path: normalized, size: details.size, language: detectLanguage(relative), ...(blob !== undefined && !dirty.has(normalized) ? { sourceId: `git:${blob}` } : {}) });
    }
    return { files: results, diagnostics };
}
async function isEmbeddedGitRepository(directory) {
    try {
        await lstat(path.join(directory, ".git"));
        return true;
    }
    catch (error) {
        if (isNotFound(error))
            return false;
        throw error;
    }
}
export async function readRepositoryFile(root, file) {
    if (!safeRelativePath(file.path))
        throw new MemexError("INVALID_ARGUMENT", "Graph repository path is invalid.");
    const absolute = path.resolve(root, file.path);
    assertInside(root, absolute);
    const details = await lstat(absolute);
    if (details.isSymbolicLink() || !details.isFile())
        throw new MemexError("SYMLINK_ESCAPE", "Graph scanner refuses symbolic-link repository files.");
    const body = await readFile(absolute);
    if (body.includes(0))
        throw new MemexError("UNSUPPORTED_SOURCE", "Graph scanner refuses binary repository files.");
    const contentHash = createHash("sha256").update(body).digest("hex");
    return { path: file.path, content: body.toString("utf8"), size: details.size, contentHash, language: file.language, sourceId: file.sourceId ?? `worktree:${contentHash}` };
}
export async function resolveRepositorySourceIds(root, files) {
    const resolved = [];
    for (const file of files) {
        if (file.sourceId !== undefined)
            resolved.push({ ...file, sourceId: file.sourceId });
        else {
            try {
                const loaded = await readRepositoryFile(root, file);
                resolved.push({ ...file, sourceId: loaded.sourceId, size: loaded.size });
            }
            catch (error) {
                if (error instanceof MemexError && error.code === "UNSUPPORTED_SOURCE")
                    continue;
                throw error;
            }
        }
    }
    return resolved;
}
export async function enumerateRepositoryFiles(root, limits) {
    const { files } = await enumerateRepositoryMetadata(root, limits);
    const results = [];
    for (const file of files) {
        try {
            const loaded = await readRepositoryFile(root, file);
            results.push(loaded);
        }
        catch (error) {
            if (error instanceof MemexError && error.code === "UNSUPPORTED_SOURCE")
                continue;
            throw error;
        }
    }
    return results;
}
/** @deprecated Compatibility reader. Stage B query paths must use openGraphIndex. */
export async function readStoredGraph(storage) {
    for (const candidate of await readManifests(storage)) {
        try {
            return parseCodeGraph(JSON.parse(await readFile(manifestSnapshotPath(storage, candidate.manifest), "utf8")));
        }
        catch {
            continue;
        }
    }
    throw new MemexError("NOT_INITIALIZED", "No recoverable Memex graph snapshot exists.");
}
export async function readGraphShard(storage, shardName) {
    return parseShard(JSON.parse(await readFile(confinedStoredName(storage.shardRoot, shardName), "utf8")));
}
export async function readEnrichmentShard(storage, shardName) {
    return parseEnrichmentShard(JSON.parse(await readFile(confinedStoredName(storage.enrichmentRoot, shardName), "utf8")));
}
export function enrichmentShardFileName(sourcePath, sourceContentHash) {
    return `${graphHash(["enrichment", sourcePath, sourceContentHash])}.json`;
}
export async function readManifest(storage) {
    const manifests = await readManifests(storage);
    const first = manifests.at(0);
    if (first === undefined)
        throw new MemexError("NOT_INITIALIZED", "No recoverable Memex graph manifest exists.");
    return first.manifest;
}
export async function openGraphIndex(storage) {
    const manifests = await readManifests(storage);
    for (const candidate of manifests) {
        try {
            return await openGraphIndexGeneration(manifestGenerationPath(storage, candidate.manifest.generation), candidate.manifest.generation, candidate.recovered);
        }
        catch {
            continue;
        }
    }
    throw new MemexError("NOT_INITIALIZED", "No recoverable Memex graph index exists.");
}
export async function writeGraph(storage, graph, shards, enrichmentShards = []) {
    return withGraphWriteLock(storage, async () => writeGraphUnlocked(storage, graph, shards, enrichmentShards));
}
export async function withGraphWriteLock(storage, operation) {
    return withFileWriteLock(storage.writeLockPath, operation, { waitMs: GRAPH_WRITE_LOCK_WAIT_MS, staleMs: GRAPH_STALE_LOCK_MS });
}
export async function currentGitFingerprint(root) {
    const head = await runGit(root, ["rev-parse", "HEAD"]).catch(() => "");
    return head ? { gitHead: head } : {};
}
export function repositoryFingerprint(files) {
    return graphHash(files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}\0${file.contentHash}\0${String(file.size)}`));
}
export function repositoryMetadataFingerprint(files) {
    return graphHash(files.slice().sort((left, right) => left.path.localeCompare(right.path)).map((file) => `${file.path}\0${String(file.size)}\0${file.sourceId}`));
}
export async function changedRepositoryPaths(root, base) {
    if (base !== undefined) {
        if (!/^[a-f0-9]{7,64}$/iu.test(base))
            throw new MemexError("INVALID_ARGUMENT", "Graph base must be a Git commit hash.");
        const [diff, status] = await Promise.all([
            runGit(root, ["diff", "--name-only", "-z", "--find-renames", base]),
            runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        ]);
        return [...new Set([...diff.split("\0").filter(Boolean).map(normalize), ...parsePorcelainPaths(status)])].sort((left, right) => left.localeCompare(right));
    }
    return parsePorcelainPaths(await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}
export async function changedRepositoryEvidence(root, base) {
    const [paths, status, current] = await Promise.all([
        changedRepositoryPaths(root, base),
        runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        currentGitFingerprint(root),
    ]);
    const workingTree = parsePorcelainPaths(status).length > 0;
    return { paths, ...(current.gitHead === undefined ? {} : { head: current.gitHead }), changeState: workingTree ? "working-tree" : paths.length > 0 ? "committed" : "clean" };
}
/**
 * Same persistence logic as {@link writeGraph}, without acquiring the graph writer lock.
 * Use only from within a callback already running inside {@link withGraphWriteLock} for the
 * same storage (for example `enrichGraph`'s read-check-write critical section) -- calling
 * {@link writeGraph} there would re-acquire the same lock file and deadlock.
 */
export async function writeGraphUnlocked(storage, graph, shards, enrichmentShards) {
    const previous = await readManifest(storage).catch(() => undefined);
    const reusable = new Map(previous?.shards.map((entry) => [`${entry.path}\0${entry.contentHash}`, entry]) ?? []);
    await mkdir(storage.shardRoot, { recursive: true, mode: 0o700 });
    await mkdir(storage.enrichmentRoot, { recursive: true, mode: 0o700 });
    await mkdir(storage.generationRoot, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(storage.shardRoot);
    await assertRegularDirectory(storage.enrichmentRoot);
    await assertRegularDirectory(storage.generationRoot);
    let reusedShardCount = 0;
    const manifestShards = [];
    for (const shard of shards) {
        const key = `${shard.path}\0${shard.contentHash}`;
        const reused = reusable.get(key);
        const shardFile = reused?.shard ?? `${graphHash([GRAPH_SCANNER_VERSION, shard.path, shard.language, shard.contentHash])}.json`;
        if (reused !== undefined)
            reusedShardCount += 1;
        else
            await atomicWriteFile(confinedStoredName(storage.shardRoot, shardFile), `${JSON.stringify(shard)}\n`);
        manifestShards.push({ path: shard.path, contentHash: shard.contentHash, sourceId: shard.sourceId, shard: shardFile });
    }
    const manifestEnrichmentShards = [];
    for (const shard of enrichmentShards) {
        const fileName = enrichmentShardFileName(shard.sourcePath, shard.sourceContentHash);
        const target = confinedStoredName(storage.enrichmentRoot, fileName);
        if (!(await isRegularFile(target)))
            await atomicWriteFile(target, `${JSON.stringify(shard)}\n`);
        manifestEnrichmentShards.push({ sourcePath: shard.sourcePath, sourceContentHash: shard.sourceContentHash, shard: fileName });
    }
    const canonical = canonicalizeGraph(graph);
    const generation = `g-${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
    const generationPath = manifestGenerationPath(storage, generation);
    const published = await generationIsValid(storage, generation).catch(() => false);
    if (!published) {
        await rm(generationPath, { recursive: true, force: true });
        await mkdir(generationPath, { recursive: true, mode: 0o700 });
        await assertRegularDirectory(generationPath);
        const index = await writeGraphIndexGeneration(generationPath, generation, canonical);
        await atomicWriteFile(path.join(generationPath, "snapshot.json"), `${JSON.stringify(canonical)}\n`);
        const manifest = {
            schemaVersion: GRAPH_STORE_SCHEMA_VERSION,
            scannerVersion: GRAPH_SCANNER_VERSION,
            generation,
            snapshot: `${generation}/snapshot.json`,
            index,
            generatedAt: canonical.generatedAt,
            source: canonical.source,
            counts: { files: canonical.files.length, nodes: canonical.nodes.length, edges: canonical.edges.length, diagnostics: canonical.diagnostics.length },
            shards: manifestShards.sort((left, right) => left.path.localeCompare(right.path)),
            enrichmentShards: manifestEnrichmentShards.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
        };
        await publishManifest(storage, previous, manifest);
    }
    else {
        const existing = await readManifest(storage);
        if (existing.generation !== generation)
            throw new MemexError("INVALID_STATE", "Graph generation publication changed during write.");
        const sortedShards = manifestShards.sort((left, right) => left.path.localeCompare(right.path));
        const sortedEnrichmentShards = manifestEnrichmentShards.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
        if (JSON.stringify(existing.shards) !== JSON.stringify(sortedShards) || JSON.stringify(existing.enrichmentShards) !== JSON.stringify(sortedEnrichmentShards)) {
            await publishManifest(storage, previous, { ...existing, shards: sortedShards, enrichmentShards: sortedEnrichmentShards });
        }
    }
    await garbageCollect(storage, previous);
    return { manifestPath: storage.manifestPath, reusedShardCount };
}
async function publishManifest(storage, previous, manifest) {
    if (previous !== undefined)
        await atomicWriteFile(storage.previousManifestPath, `${JSON.stringify(previous)}\n`);
    await atomicWriteFile(storage.manifestPath, `${JSON.stringify(manifest)}\n`);
}
async function generationIsValid(storage, generation) {
    const reader = await openGraphIndexGeneration(manifestGenerationPath(storage, generation), generation, false);
    return reader.status().generation === generation;
}
async function readManifests(storage) {
    const values = [];
    for (const [candidate, recovered] of [[storage.manifestPath, false], [storage.previousManifestPath, true]]) {
        try {
            values.push({ manifest: parseManifest(JSON.parse(await readFile(candidate, "utf8"))), recovered });
        }
        catch {
            continue;
        }
    }
    return values;
}
function parseManifest(value) {
    if (!isRecord(value) || value.schemaVersion !== GRAPH_STORE_SCHEMA_VERSION || value.scannerVersion !== GRAPH_SCANNER_VERSION || !safeGeneration(value.generation) || !safeSnapshot(value.snapshot) || !Array.isArray(value.shards) || (value.enrichmentShards !== undefined && !Array.isArray(value.enrichmentShards)) || typeof value.generatedAt !== "string" || !isRecord(value.source) || typeof value.source.dirtyFingerprint !== "string" || typeof value.source.scannerVersion !== "string" || !isRecord(value.counts) || !nonNegativeInteger(value.counts.files) || !nonNegativeInteger(value.counts.nodes) || !nonNegativeInteger(value.counts.edges) || !nonNegativeInteger(value.counts.diagnostics)) {
        throw new MemexError("INVALID_STATE", "Graph manifest schema is incompatible.");
    }
    const index = parseManifestIndex(value.index, value.generation);
    const shards = value.shards.map(parseManifestShard).sort((left, right) => left.path.localeCompare(right.path));
    if (JSON.stringify(shards) !== JSON.stringify(value.shards))
        throw new MemexError("INVALID_STATE", "Graph manifest shards are not canonical.");
    const enrichmentShardsInput = value.enrichmentShards ?? [];
    const enrichmentShards = enrichmentShardsInput.map(parseManifestEnrichmentShard).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    if (JSON.stringify(enrichmentShards) !== JSON.stringify(enrichmentShardsInput))
        throw new MemexError("INVALID_STATE", "Graph manifest enrichment shards are not canonical.");
    return { schemaVersion: GRAPH_STORE_SCHEMA_VERSION, scannerVersion: GRAPH_SCANNER_VERSION, generation: value.generation, snapshot: value.snapshot, index, generatedAt: value.generatedAt, source: { ...(typeof value.source.gitHead === "string" ? { gitHead: value.source.gitHead } : {}), dirtyFingerprint: value.source.dirtyFingerprint, scannerVersion: value.source.scannerVersion }, counts: { files: value.counts.files, nodes: value.counts.nodes, edges: value.counts.edges, diagnostics: value.counts.diagnostics }, shards, enrichmentShards };
}
function parseManifestEnrichmentShard(value) {
    if (!isRecord(value) || !safeRelativePath(value.sourcePath) || typeof value.sourceContentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sourceContentHash) || !safeStoredName(value.shard))
        throw new MemexError("INVALID_STATE", "Graph manifest enrichment shard is invalid.");
    return { sourcePath: value.sourcePath, sourceContentHash: value.sourceContentHash, shard: value.shard };
}
function parseManifestIndex(value, generation) {
    if (!isRecord(value) || value.schemaVersion !== GRAPH_STORE_SCHEMA_VERSION || value.scannerVersion !== GRAPH_SCANNER_VERSION || value.generation !== generation || value.architecture !== "architecture.json") {
        throw new MemexError("INVALID_STATE", "Graph manifest index is invalid.");
    }
    const buckets = (entry) => {
        if (!Array.isArray(entry))
            throw new MemexError("INVALID_STATE", "Graph manifest index buckets are invalid.");
        const names = [];
        for (const name of entry) {
            if (typeof name !== "string" || !/^[a-f0-9]$/u.test(name))
                throw new MemexError("INVALID_STATE", "Graph manifest index buckets are invalid.");
            names.push(name);
        }
        const ordered = names.slice().sort((left, right) => left.localeCompare(right));
        if (new Set(ordered).size !== ordered.length || JSON.stringify(entry) !== JSON.stringify(ordered))
            throw new MemexError("INVALID_STATE", "Graph manifest index buckets are not canonical.");
        return ordered;
    };
    return { schemaVersion: GRAPH_STORE_SCHEMA_VERSION, scannerVersion: GRAPH_SCANNER_VERSION, generation, nodeBuckets: buckets(value.nodeBuckets), edgeBuckets: buckets(value.edgeBuckets), inboundBuckets: buckets(value.inboundBuckets), outboundBuckets: buckets(value.outboundBuckets), symbolBuckets: buckets(value.symbolBuckets), pathBuckets: buckets(value.pathBuckets), architecture: "architecture.json" };
}
function parseManifestShard(value) {
    if (!isRecord(value) || !safeRelativePath(value.path) || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(value.contentHash) || typeof value.sourceId !== "string" || value.sourceId.length === 0 || !safeStoredName(value.shard))
        throw new MemexError("INVALID_STATE", "Graph manifest shard is invalid.");
    return { path: value.path, contentHash: value.contentHash, sourceId: value.sourceId, shard: value.shard };
}
async function garbageCollect(storage, previous) {
    const current = await readManifest(storage).catch(() => undefined);
    const retained = new Set([current?.generation, previous?.generation].filter((value) => value !== undefined));
    for (const entry of await readdir(storage.generationRoot).catch(() => [])) {
        if (safeGeneration(entry) && !retained.has(entry))
            await rm(manifestGenerationPath(storage, entry), { recursive: true, force: true });
    }
    const shards = new Set((current?.shards ?? []).concat(previous?.shards ?? []).map((entry) => entry.shard));
    for (const entry of await readdir(storage.shardRoot).catch(() => []))
        if (!shards.has(entry))
            await rm(confinedStoredName(storage.shardRoot, entry), { force: true });
    const enrichmentShards = new Set((current?.enrichmentShards ?? []).concat(previous?.enrichmentShards ?? []).map((entry) => entry.shard));
    for (const entry of await readdir(storage.enrichmentRoot).catch(() => []))
        if (!enrichmentShards.has(entry))
            await rm(confinedStoredName(storage.enrichmentRoot, entry), { force: true });
}
function createStorage(root) {
    return { root, manifestPath: path.join(root, "manifest.json"), previousManifestPath: path.join(root, "manifest.previous.json"), writeLockPath: path.join(root, "writer.lock"), generationRoot: path.join(root, "generations"), shardRoot: path.join(root, "shards"), enrichmentRoot: path.join(root, "enrichment"), snapshotRoot: path.join(root, "snapshots") };
}
function manifestGenerationPath(storage, generation) {
    if (!safeGeneration(generation))
        throw new MemexError("INVALID_STATE", "Graph generation is invalid.");
    return path.join(storage.generationRoot, generation);
}
function manifestSnapshotPath(storage, manifest) {
    if (manifest.snapshot !== `${manifest.generation}/snapshot.json`)
        throw new MemexError("INVALID_STATE", "Graph snapshot path is invalid.");
    return path.join(storage.generationRoot, manifest.snapshot);
}
function confinedStoredName(root, name) {
    if (!safeStoredName(name))
        throw new MemexError("INVALID_STATE", "Graph storage entry is invalid.");
    return path.join(root, name);
}
function parseShard(value) {
    if (!isRecord(value) || !safeRelativePath(value.path) || typeof value.language !== "string" || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(value.contentHash) || typeof value.sourceId !== "string" || value.sourceId.length === 0 || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || !isRecord(value.scan))
        throw new MemexError("INVALID_STATE", "Graph shard is invalid.");
    const scan = value.scan;
    const strings = (key) => { const candidate = scan[key]; if (!Array.isArray(candidate) || !candidate.every((entry) => typeof entry === "string"))
        throw new MemexError("INVALID_STATE", "Graph shard is invalid."); return candidate; };
    const symbols = Array.isArray(scan.symbols) ? scan.symbols.map((entry) => parseShardSymbol(entry)) : undefined;
    const relations = Array.isArray(scan.relations) ? scan.relations.map((entry) => parseShardRelation(entry)) : undefined;
    const diagnostics = Array.isArray(scan.diagnostics) ? scan.diagnostics.map((entry) => parseShardDiagnostic(entry)) : undefined;
    if (symbols === undefined || relations === undefined || diagnostics === undefined)
        throw new MemexError("INVALID_STATE", "Graph shard is invalid.");
    return { path: value.path, language: value.language, contentHash: value.contentHash, size: value.size, sourceId: value.sourceId, scan: { symbols, relations, imports: strings("imports"), exports: strings("exports"), calls: strings("calls"), inherits: strings("inherits"), implements: strings("implements"), references: strings("references"), diagnostics } };
}
function parseShardSymbol(value) {
    if (!isRecord(value) || typeof value.name !== "string" || typeof value.qualifiedName !== "string" || typeof value.scope !== "string" || typeof value.kind !== "string" || !positiveLine(value.startLine) || !positiveLine(value.endLine) || value.startLine > value.endLine || typeof value.exported !== "boolean")
        throw new MemexError("INVALID_STATE", "Graph shard symbol is invalid.");
    return { name: value.name, qualifiedName: value.qualifiedName, scope: value.scope, kind: value.kind, startLine: value.startLine, endLine: value.endLine, exported: value.exported };
}
function parseShardRelation(value) {
    if (!isRecord(value) || !isRelationKind(value.kind) || typeof value.fromQualifiedName !== "string" || typeof value.target !== "string" || !positiveLine(value.line) || (value.confidence !== "resolved" && value.confidence !== "heuristic"))
        throw new MemexError("INVALID_STATE", "Graph shard relation is invalid.");
    return { kind: value.kind, fromQualifiedName: value.fromQualifiedName, target: value.target, line: value.line, confidence: value.confidence };
}
function parseShardDiagnostic(value) {
    if (!isRecord(value) || !safeRelativePath(value.path) || typeof value.code !== "string" || typeof value.message !== "string")
        throw new MemexError("INVALID_STATE", "Graph shard diagnostic is invalid.");
    return { path: value.path, code: value.code, message: value.message };
}
// Directories excluded no matter where they occur in the tree: build tooling
// and dependency artifacts that are never source, at any depth.
const ANYWHERE_EXCLUDED_DIRS = [".git", "node_modules", "vendor", "dist", "build", "coverage"];
// The wiki's own generated content directories. Both are, by construction
// (see paths.ts resolveWikiLocation), always a direct child of the scanned
// workspace root ("<root>/memex" for code mode; ".memex" is only ever created
// under the host home directory and never inside a scanned repository).
// Matching them anywhere in the tree — rather than only at the root — would
// silently blackhole an unrelated nested directory that happens to share the
// name, such as this very project's own plugin at "plugins/memex".
const ROOT_ONLY_EXCLUDED_DIRS = [".memex", "memex"];
function excluded(relative) { const parts = relative.split("/"); const name = parts.at(-1) ?? ""; return parts.some((part) => ANYWHERE_EXCLUDED_DIRS.includes(part)) || ROOT_ONLY_EXCLUDED_DIRS.includes(parts[0] ?? "") || /(?:^|[._-])(generated|min)\./iu.test(name) || /\.map$/iu.test(name); }
function normalize(relative) { return relative.split(path.sep).join("/"); }
function parseGitIndexBlobIds(output) { const result = new Map(); for (const entry of output.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0)
        continue;
    const header = entry.slice(0, tab).split(" ");
    const blob = header[1];
    const stage = header[2];
    const filePath = entry.slice(tab + 1);
    if (blob !== undefined && stage === "0" && /^[a-f0-9]{40,64}$/iu.test(blob) && safeRelativePath(filePath))
        result.set(normalize(filePath), blob);
} return result; }
function parsePorcelainPaths(status) { const entries = status.split("\0"); const paths = new Set(); for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4)
        continue;
    const code = entry.slice(0, 2);
    paths.add(normalize(entry.slice(3)));
    if (code.includes("R") || code.includes("C")) {
        const original = entries[index + 1];
        if (original) {
            paths.add(normalize(original));
            index += 1;
        }
    }
} return [...paths].sort((a, b) => a.localeCompare(b)); }
function safeStoredName(value) { return typeof value === "string" && /^[a-f0-9]{64}\.json$/iu.test(value); }
function safeGeneration(value) { return typeof value === "string" && /^g-[a-f0-9]{64}$/u.test(value); }
function safeSnapshot(value) { return typeof value === "string" && /^g-[a-f0-9]{64}\/snapshot\.json$/u.test(value); }
function safeRelativePath(value) { return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === ".."); }
function positiveLine(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isRelationKind(value) { return value === "calls" || value === "inherits" || value === "implements" || value === "references"; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isNotFound(error) { return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"); }
function assertInside(root, candidate) { const relative = path.relative(root, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    return; throw new MemexError("PATH_OUTSIDE_ROOT", "Graph file path escapes the repository root."); }
async function assertRegularDirectory(directory) { const details = await lstat(directory); if (details.isSymbolicLink() || !details.isDirectory())
    throw new MemexError("SYMLINK_ESCAPE", "Graph storage directory must not be a symbolic link."); }
async function isRegularFile(file) { try {
    const details = await lstat(file);
    if (details.isSymbolicLink())
        throw new MemexError("SYMLINK_ESCAPE", "Graph manifest must not be a symbolic link.");
    return details.isFile();
}
catch (error) {
    if (error instanceof MemexError)
        throw error;
    if (isNotFound(error))
        return false;
    throw new MemexError("IO_FAILURE", "Unable to probe graph storage.");
} }
function runGit(cwd, args) { return new Promise((resolve, reject) => { const child = spawn("git", [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); const chunks = []; let settled = false; const fail = () => { if (!settled) {
    settled = true;
    child.kill("SIGKILL");
    reject(new MemexError("GIT_FAILURE", "Unable to enumerate repository files for the graph."));
} }; const timeout = setTimeout(fail, 15_000); child.stdout.on("data", (chunk) => { if (Buffer.concat(chunks).byteLength + chunk.byteLength > 16 * 1024 * 1024) {
    fail();
    return;
} chunks.push(chunk); }); child.once("error", fail); child.once("close", (code) => { clearTimeout(timeout); if (settled)
    return; settled = true; if (code !== 0) {
    reject(new MemexError("GIT_FAILURE", "Unable to enumerate repository files for the graph."));
    return;
} resolve(Buffer.concat(chunks).toString("utf8")); }); }); }
