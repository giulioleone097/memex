import path from "node:path";
import { GRAPH_DEFAULTS, GRAPH_SCANNER_VERSION, canonicalizeGraph, createGraphEdgeId, createGraphNodeId, } from "./graph-contracts.js";
import { contextGraph, impactGraph, queryGraph } from "./graph-query.js";
import { currentGitFingerprint, changedRepositoryPaths, enumerateRepositoryFiles, readGraphShard, readManifest, readStoredGraph, repositoryFingerprint, resolveGraphStorage, writeGraph } from "./graph-store.js";
import { scanSourceFile } from "./graph-scan.js";
export async function buildGraph(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    const limits = { maxFiles: options.limits?.maxFiles ?? GRAPH_DEFAULTS.maxFiles, maxFileBytes: options.limits?.maxFileBytes ?? GRAPH_DEFAULTS.maxFileBytes, maxRepositoryBytes: options.limits?.maxRepositoryBytes ?? GRAPH_DEFAULTS.maxRepositoryBytes };
    const previous = options.force ? undefined : await readStoredGraph(resolved.storage).catch(() => undefined);
    const previousManifest = options.force ? undefined : await readManifest(resolved.storage).catch(() => undefined);
    const files = await enumerateRepositoryFiles(resolved.repositoryRoot, limits);
    const git = await currentGitFingerprint(resolved.repositoryRoot);
    const fingerprint = { ...git, dirtyFingerprint: repositoryFingerprint(files) };
    const oldShards = new Map(previousManifest?.shards.map((entry) => [`${entry.path}\0${entry.contentHash}`, entry]) ?? []);
    const shards = [];
    let reusedFileCount = 0;
    for (const file of files) {
        const prior = oldShards.get(`${file.path}\0${file.contentHash}`);
        if (prior) {
            try {
                const raw = await readGraphShard(resolved.storage, prior.shard);
                if (raw.path === file.path && raw.contentHash === file.contentHash) {
                    shards.push(raw);
                    reusedFileCount += 1;
                    continue;
                }
            }
            catch { /* rescan corrupt private shard */ }
        }
        shards.push({ path: file.path, language: file.language, contentHash: file.contentHash, size: file.size, scan: scanSourceFile({ path: file.path, language: file.language, content: file.content }) });
    }
    const generatedAt = options.now ?? new Date().toISOString();
    const graph = assembleGraph(resolved.workspaceId, generatedAt, { ...fingerprint, scannerVersion: GRAPH_SCANNER_VERSION }, shards);
    const persisted = await writeGraph(resolved.storage, graph, shards);
    return { schemaVersion: 1, action: "build", root: resolved.repositoryRoot, fresh: true, fullRebuild: Boolean(options.force) || previous === undefined, ...(fingerprint.gitHead === undefined ? {} : { head: fingerprint.gitHead }), dirtyFingerprint: fingerprint.dirtyFingerprint, scannedFileCount: files.length - reusedFileCount, reusedFileCount, removedFileCount: Math.max(0, (previous?.files.length ?? 0) - files.length), fileCount: graph.files.length, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, diagnosticCount: graph.diagnostics.length, generatedAt, graph, manifestPath: persisted.manifestPath, reusedShardCount: persisted.reusedShardCount };
}
export async function getGraphStatus(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    let graph;
    try {
        graph = await readStoredGraph(resolved.storage);
    }
    catch {
        return { schemaVersion: 1, action: "status", root: resolved.repositoryRoot, available: false, fresh: false, reason: "No recoverable OpenWiki graph snapshot exists." };
    }
    const [current, files] = await Promise.all([currentGitFingerprint(resolved.repositoryRoot), enumerateRepositoryFiles(resolved.repositoryRoot, GRAPH_DEFAULTS)]);
    const fresh = repositoryFingerprint(files) === graph.source.dirtyFingerprint;
    return { schemaVersion: 1, action: "status", root: resolved.repositoryRoot, available: true, fresh, ...(fresh ? {} : { reason: "Repository content changed since the last graph build." }), ...(graph.source.gitHead === undefined ? {} : { indexedHead: graph.source.gitHead }), ...(current.gitHead === undefined ? {} : { currentHead: current.gitHead }), counts: { files: graph.files.length, nodes: graph.nodes.length, edges: graph.edges.length, diagnostics: graph.diagnostics.length }, generatedAt: graph.generatedAt, graph };
}
export async function queryGraphOperation(options) { const loaded = await load(options); const result = queryGraph(loaded.graph, { query: options.query, ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.responseByteLimit === undefined ? {} : { responseByteLimit: options.responseByteLimit }) }); return envelope("query", loaded.root, loaded.graph, result, { query: options.query }); }
export { queryGraphOperation as queryGraph };
export async function getGraphContext(options) { const loaded = await load(options); const result = contextGraph(loaded.graph, options.target, options.limit, options.responseByteLimit); return envelope("context", loaded.root, loaded.graph, result, { target: options.target }); }
export async function analyzeGraphImpact(options) { const loaded = await load(options); const direction = options.direction ?? "both"; const depth = options.depth ?? GRAPH_DEFAULTS.maxTraversalDepth; const result = impactGraph(loaded.graph, options.target, direction, depth, options.limit, options.responseByteLimit); return { schemaVersion: 1, action: "impact", root: loaded.root, nodes: result.nodes, edges: result.edges, truncated: result.truncated, diagnostics: loaded.graph.diagnostics, target: options.target, direction, depth, paths: result.paths }; }
export async function analyzeGraphChanges(options) { const loaded = await load(options); const changedPaths = await changedRepositoryPaths(loaded.root, options.base); const changed = new Set(loaded.graph.nodes.filter((node) => changedPaths.includes(node.path)).map((node) => node.id)); for (const edge of loaded.graph.edges)
    if (changed.has(edge.from) || changed.has(edge.to)) {
        changed.add(edge.from);
        changed.add(edge.to);
    } const result = { nodes: loaded.graph.nodes.filter((node) => changed.has(node.id)).slice(0, options.limit ?? GRAPH_DEFAULTS.defaultEntityLimit), edges: loaded.graph.edges.filter((edge) => changed.has(edge.from) && changed.has(edge.to)), truncated: changed.size > (options.limit ?? GRAPH_DEFAULTS.defaultEntityLimit), unresolvedEdgeCount: 0 }; return { schemaVersion: 1, action: "changes", root: loaded.root, nodes: result.nodes, edges: result.edges, truncated: result.truncated, diagnostics: loaded.graph.diagnostics, changedPaths, ...(options.base === undefined ? {} : { base: options.base }) }; }
export async function getArchitectureMap(options) { const loaded = await load(options); const modules = loaded.graph.nodes.filter((node) => node.kind === "module"); const degree = new Map(); for (const edge of loaded.graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
} const max = options.limit ?? GRAPH_DEFAULTS.defaultEntityLimit; const hubs = [...loaded.graph.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id)).slice(0, max); const flows = loaded.graph.edges.filter((edge) => edge.kind === "imports").map((edge) => ({ from: edge.from, to: edge.to, weight: 1 })).slice(0, max); return { schemaVersion: 1, action: "map", root: loaded.root, modules: modules.slice(0, max), hubs, cycles: [], flows, truncated: modules.length > max, diagnostics: loaded.graph.diagnostics }; }
async function load(options) { const resolved = await resolveGraphStorage(options.root, options.homeDir); return { root: resolved.repositoryRoot, graph: await readStoredGraph(resolved.storage) }; }
function envelope(action, root, graph, result, extra) { return { schemaVersion: 1, action, root, nodes: result.nodes, edges: result.edges, truncated: result.truncated, diagnostics: graph.diagnostics, ...extra }; }
function assembleGraph(workspaceId, generatedAt, source, shards) {
    const nodes = [];
    const edges = [];
    const diagnostics = [];
    const repository = node("repository", ".", "repository");
    nodes.push(repository);
    const directories = new Map();
    const fileNodes = new Map();
    const moduleNodes = new Map();
    const symbolNodes = new Map();
    const addEdge = (kind, from, to, confidence) => { const edge = { id: createGraphEdgeId(kind, from.id, to.id, confidence), kind, from: from.id, to: to.id, confidence }; if (!edges.some((candidate) => candidate.id === edge.id))
        edges.push(edge); };
    for (const shard of shards) {
        let parent = repository;
        const parts = shard.path.split("/");
        for (let index = 0; index < parts.length - 1; index += 1) {
            const directoryPath = parts.slice(0, index + 1).join("/");
            let directory = directories.get(directoryPath);
            if (!directory) {
                directory = node("directory", directoryPath, parts[index]);
                directories.set(directoryPath, directory);
                nodes.push(directory);
                addEdge("contains", parent, directory, "exact");
            }
            parent = directory;
        }
        const file = node("file", shard.path, parts.at(-1));
        const module = node("module", shard.path, shard.path);
        nodes.push(file, module);
        fileNodes.set(shard.path, file);
        moduleNodes.set(shard.path, module);
        addEdge("contains", parent, file, "exact");
        addEdge("contains", file, module, "exact");
        for (const symbol of shard.scan.symbols) {
            const symbolNode = node("symbol", shard.path, symbol.name, symbol.kind, symbol.startLine, symbol.endLine);
            nodes.push(symbolNode);
            addEdge("declares", module, symbolNode, "exact");
            if (symbol.exported)
                addEdge("exports", module, symbolNode, "exact");
            const named = symbolNodes.get(symbol.name) ?? [];
            named.push(symbolNode);
            symbolNodes.set(symbol.name, named);
        }
        diagnostics.push(...shard.scan.diagnostics);
    }
    for (const shard of shards) {
        const module = moduleNodes.get(shard.path);
        if (!module)
            continue;
        for (const imported of shard.scan.imports) {
            const targetPath = resolveImport(shard.path, imported, fileNodes);
            const target = targetPath ? moduleNodes.get(targetPath) : undefined;
            if (target)
                addEdge("imports", module, target, targetPath === imported ? "exact" : "resolved");
            else
                diagnostics.push({ path: shard.path, code: "UNRESOLVED_IMPORT", message: `Unable to resolve import ${imported}.` });
        }
        const localSymbols = nodes.filter((candidate) => candidate.kind === "symbol" && candidate.path === shard.path);
        for (const [kind, names] of [["calls", shard.scan.calls], ["inherits", shard.scan.inherits], ["implements", shard.scan.implements], ["references", shard.scan.references]])
            for (const name of names) {
                const target = symbolNodes.get(name) ?? [];
                const onlyTarget = target[0];
                if (target.length === 1 && onlyTarget)
                    for (const from of localSymbols)
                        addEdge(kind, from, onlyTarget, "resolved");
                else if (target.length > 1)
                    diagnostics.push({ path: shard.path, code: "AMBIGUOUS_SYMBOL", message: `Symbol ${name} is ambiguous.` });
                else
                    diagnostics.push({ path: shard.path, code: "UNRESOLVED_SYMBOL", message: `Unable to resolve symbol ${name}.` });
            }
    }
    return canonicalizeGraph({ schemaVersion: 1, workspaceId, generatedAt, source, files: shards.map(({ path: filePath, language, contentHash, size }) => ({ path: filePath, language, contentHash, size })), nodes, edges, diagnostics });
}
function node(kind, nodePath, name, symbolKind, startLine, endLine) { return { id: createGraphNodeId(kind, nodePath, name, symbolKind, startLine === undefined ? undefined : String(startLine)), kind, path: nodePath, name, ...(symbolKind === undefined ? {} : { symbolKind }), ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) }; }
function resolveImport(from, specifier, files) { const base = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : specifier; const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"].map((extension) => `${base}${extension}`), ...["index.ts", "index.js", "__init__.py"].map((index) => `${base}/${index}`)]; return candidates.find((candidate) => files.has(candidate)); }
