import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { canonicalizeGraph, graphHash, parseCodeGraph, GRAPH_SCANNER_VERSION } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";
import { resolveWikiLocation } from "./paths.js";
import { detectLanguage } from "./graph-scan.js";
export async function resolveGraphStorage(root, homeDir) {
    const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
    const graphRoot = path.join(location.dataRoot, "graph");
    await mkdir(graphRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(graphRoot)).isSymbolicLink())
        throw new OpenWikiError("SYMLINK_ESCAPE", "Graph storage root must not be a symbolic link.");
    return { workspaceId: location.workspaceId, repositoryRoot: location.workspaceRoot, storage: { root: graphRoot, manifestPath: path.join(graphRoot, "manifest.json"), previousManifestPath: path.join(graphRoot, "manifest.previous.json"), shardRoot: path.join(graphRoot, "shards"), snapshotRoot: path.join(graphRoot, "snapshots") } };
}
export async function enumerateRepositoryFiles(root, limits) {
    const listed = await runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const paths = [...new Set(listed.split("\0").filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (paths.length > limits.maxFiles)
        throw new OpenWikiError("SOURCE_TOO_LARGE", "Repository exceeds the graph file limit.");
    let total = 0;
    const results = [];
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
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
                continue;
            throw error;
        }
        if (details.isSymbolicLink())
            throw new OpenWikiError("SYMLINK_ESCAPE", "Graph scanner refuses symbolic-link repository files.");
        if (!details.isFile())
            continue;
        if (details.size > limits.maxFileBytes)
            throw new OpenWikiError("SOURCE_TOO_LARGE", "A repository file exceeds the graph file size limit.");
        total += details.size;
        if (total > limits.maxRepositoryBytes)
            throw new OpenWikiError("SOURCE_TOO_LARGE", "Repository exceeds the graph byte limit.");
        const body = await readFile(absolute);
        if (body.includes(0))
            continue;
        const content = body.toString("utf8");
        results.push({ path: normalize(relative), content, size: details.size, contentHash: createHash("sha256").update(body).digest("hex"), language: detectLanguage(relative) });
    }
    return results;
}
export async function readStoredGraph(storage) { for (const manifest of await readManifests(storage))
    try {
        return parseCodeGraph(JSON.parse(await readFile(confinedStoredPath(storage.snapshotRoot, manifest.snapshot), "utf8")));
    }
    catch {
        continue;
    } throw new OpenWikiError("NOT_INITIALIZED", "No recoverable OpenWiki graph snapshot exists."); }
export async function readGraphShard(storage, shardName) { return parseShard(JSON.parse(await readFile(confinedStoredPath(storage.shardRoot, shardName), "utf8"))); }
export async function readManifest(storage) { for (const candidate of [storage.manifestPath, storage.previousManifestPath])
    try {
        const value = JSON.parse(await readFile(candidate, "utf8"));
        return parseManifest(value);
    }
    catch {
        continue;
    } throw new OpenWikiError("NOT_INITIALIZED", "No recoverable OpenWiki graph snapshot exists."); }
export async function writeGraph(storage, graph, shards) {
    const previous = await readManifest(storage).catch(() => undefined);
    const reusable = new Map(previous?.shards.map((entry) => [`${entry.path}\0${entry.contentHash}`, entry]) ?? []);
    await mkdir(storage.shardRoot, { recursive: true, mode: 0o700 });
    await mkdir(storage.snapshotRoot, { recursive: true, mode: 0o700 });
    let reusedShardCount = 0;
    const manifestShards = [];
    for (const shard of shards) {
        const key = `${shard.path}\0${shard.contentHash}`;
        const reuse = reusable.get(key);
        const shardFile = reuse?.shard ?? `${graphHash([GRAPH_SCANNER_VERSION, shard.path, shard.language, shard.contentHash])}.json`;
        if (reuse)
            reusedShardCount += 1;
        else
            await atomicWriteFile(confinedStoredPath(storage.shardRoot, shardFile), `${JSON.stringify(shard)}\n`);
        manifestShards.push({ path: shard.path, contentHash: shard.contentHash, shard: shardFile });
    }
    const snapshot = `${graphHash([graph.workspaceId, graph.source.dirtyFingerprint, ...graph.files.map((file) => `${file.path}:${file.contentHash}`)])}.json`;
    await atomicWriteFile(confinedStoredPath(storage.snapshotRoot, snapshot), `${JSON.stringify(canonicalizeGraph(graph))}\n`);
    const manifest = { schemaVersion: 1, snapshot, shards: manifestShards.sort((a, b) => a.path.localeCompare(b.path)) };
    if (previous)
        await atomicWriteFile(storage.previousManifestPath, `${JSON.stringify(previous)}\n`);
    await atomicWriteFile(storage.manifestPath, `${JSON.stringify(manifest)}\n`);
    const retained = [manifest, ...(previous === undefined ? [] : [previous])];
    await garbageCollect(storage, new Set(retained.flatMap((entry) => entry.shards.map((shard) => shard.shard))), new Set(retained.map((entry) => entry.snapshot)));
    return { manifestPath: storage.manifestPath, reusedShardCount };
}
export async function currentGitFingerprint(root) { const head = await runGit(root, ["rev-parse", "HEAD"]).catch(() => ""); return head ? { gitHead: head } : {}; }
export function repositoryFingerprint(files) { return graphHash(files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}\0${file.contentHash}\0${String(file.size)}`)); }
export async function changedRepositoryPaths(root, base) { if (base !== undefined) {
    if (!/^[a-f0-9]{7,64}$/iu.test(base))
        throw new OpenWikiError("INVALID_ARGUMENT", "Graph base must be a Git commit hash.");
    const output = await runGit(root, ["diff", "--name-only", `${base}..HEAD`]);
    return output.split(/\r?\n/u).filter(Boolean).map(normalize).sort((a, b) => a.localeCompare(b));
} const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]); return parsePorcelainPaths(status); }
async function readManifests(storage) { const values = []; for (const candidate of [storage.manifestPath, storage.previousManifestPath])
    try {
        values.push(parseManifest(JSON.parse(await readFile(candidate, "utf8"))));
    }
    catch {
        continue;
    } return values; }
function parseManifest(value) { if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid"); const r = value; if (r.schemaVersion !== 1 || !safeStoredName(r.snapshot) || !Array.isArray(r.shards))
    throw new Error("invalid"); const shards = r.shards.map((item) => { if (item === null || typeof item !== "object" || Array.isArray(item))
    throw new Error("invalid"); const s = item; if (!safeRelativePath(s.path) || typeof s.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(s.contentHash) || !safeStoredName(s.shard))
    throw new Error("invalid"); return { path: s.path, contentHash: s.contentHash, shard: s.shard }; }); return { schemaVersion: 1, snapshot: r.snapshot, shards }; }
async function garbageCollect(storage, reachableShards, reachableSnapshots) { for (const [directory, allowed] of [[storage.shardRoot, reachableShards], [storage.snapshotRoot, reachableSnapshots]]) {
    for (const entry of await readdir(directory).catch(() => []))
        if (!allowed.has(entry))
            await rm(confinedStoredPath(directory, entry), { force: true });
} }
function excluded(relative) { const parts = relative.split("/"); const name = parts.at(-1) ?? ""; return parts.some((part) => [".git", ".openwiki", "openwiki", "node_modules", "vendor", "dist", "build", "coverage"].includes(part)) || /(?:^|[._-])(generated|min)\./iu.test(name) || /\.map$/iu.test(name); }
function normalize(relative) { return relative.split(path.sep).join("/"); }
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
function safeRelativePath(value) { return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === ".."); }
function confinedStoredPath(root, name) { if (!safeStoredName(name))
    throw new OpenWikiError("INVALID_STATE", "Graph storage entry is invalid."); return path.join(root, name); }
function parseShard(value) { if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); const shard = value; if (!safeRelativePath(shard.path) || typeof shard.language !== "string" || typeof shard.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(shard.contentHash) || typeof shard.size !== "number" || !Number.isSafeInteger(shard.size) || shard.size < 0 || shard.scan === null || typeof shard.scan !== "object" || Array.isArray(shard.scan))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); const scan = shard.scan; const strings = (key) => { const valueAtKey = Array.isArray(scan[key]) ? scan[key] : []; if (!valueAtKey.every(isString))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); return valueAtKey; }; const symbolsValue = Array.isArray(scan.symbols) ? scan.symbols : []; if (symbolsValue.length === 0 && !Array.isArray(scan.symbols))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); const symbols = symbolsValue.map((valueAtIndex) => { if (valueAtIndex === null || typeof valueAtIndex !== "object" || Array.isArray(valueAtIndex))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); const symbol = valueAtIndex; if (typeof symbol.name !== "string" || typeof symbol.kind !== "string" || typeof symbol.startLine !== "number" || typeof symbol.endLine !== "number" || typeof symbol.exported !== "boolean")
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); return { name: symbol.name, kind: symbol.kind, startLine: symbol.startLine, endLine: symbol.endLine, exported: symbol.exported }; }); const diagnosticsValue = Array.isArray(scan.diagnostics) ? scan.diagnostics : []; if (diagnosticsValue.length === 0 && !Array.isArray(scan.diagnostics))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); const diagnostics = diagnosticsValue.map((valueAtIndex) => { if (valueAtIndex === null || typeof valueAtIndex !== "object" || Array.isArray(valueAtIndex))
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); const diagnostic = valueAtIndex; if (!safeRelativePath(diagnostic.path) || typeof diagnostic.code !== "string" || typeof diagnostic.message !== "string")
    throw new OpenWikiError("INVALID_STATE", "Graph shard is invalid."); return { path: diagnostic.path, code: diagnostic.code, message: diagnostic.message }; }); return { path: shard.path, language: shard.language, contentHash: shard.contentHash, size: shard.size, scan: { symbols, imports: strings("imports"), exports: strings("exports"), calls: strings("calls"), inherits: strings("inherits"), implements: strings("implements"), references: strings("references"), diagnostics } }; }
function isString(value) { return typeof value === "string"; }
function assertInside(root, candidate) { const relative = path.relative(root, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    return; throw new OpenWikiError("PATH_OUTSIDE_ROOT", "Graph file path escapes the repository root."); }
function runGit(cwd, args) { return new Promise((resolve, reject) => { const child = spawn("git", [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); const chunks = []; let settled = false; const fail = () => { if (!settled) {
    settled = true;
    child.kill("SIGKILL");
    reject(new OpenWikiError("GIT_FAILURE", "Unable to enumerate repository files for the graph."));
} }; const timeout = setTimeout(fail, 15_000); child.stdout.on("data", (chunk) => { if (Buffer.concat(chunks).byteLength + chunk.byteLength > 16 * 1024 * 1024) {
    fail();
    return;
} chunks.push(chunk); }); child.once("error", fail); child.once("close", (code) => { clearTimeout(timeout); if (settled)
    return; settled = true; if (code !== 0) {
    reject(new OpenWikiError("GIT_FAILURE", "Unable to enumerate repository files for the graph."));
    return;
} resolve(Buffer.concat(chunks).toString("utf8")); }); }); }
