import path from "node:path";
import { GRAPH_DEFAULTS, GRAPH_SCANNER_VERSION, canonicalizeGraph, createGraphEdgeId, createGraphNodeId, } from "./graph-contracts.js";
import { contextGraph, entityLimit, impactGraph, queryGraph, responseLimit } from "./graph-query.js";
import { currentGitFingerprint, changedRepositoryPaths, enumerateRepositoryFiles, readStoredGraph, repositoryFingerprint, resolveGraphStorage, writeGraph } from "./graph-store.js";
import { scanSourceFile } from "./graph-scan.js";
import { OpenWikiError } from "./errors.js";
export async function buildGraph(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    const limits = { maxFiles: options.limits?.maxFiles ?? GRAPH_DEFAULTS.maxFiles, maxFileBytes: options.limits?.maxFileBytes ?? GRAPH_DEFAULTS.maxFileBytes, maxRepositoryBytes: options.limits?.maxRepositoryBytes ?? GRAPH_DEFAULTS.maxRepositoryBytes };
    const previous = options.force ? undefined : await readStoredGraph(resolved.storage).catch(() => undefined);
    const files = await enumerateRepositoryFiles(resolved.repositoryRoot, limits);
    const git = await currentGitFingerprint(resolved.repositoryRoot);
    const fingerprint = { ...git, dirtyFingerprint: repositoryFingerprint(files) };
    const shards = files.map((file) => ({ path: file.path, language: file.language, contentHash: file.contentHash, size: file.size, scan: scanSourceFile({ path: file.path, language: file.language, content: file.content }) }));
    const generatedAt = options.now ?? new Date().toISOString();
    const graph = assembleGraph(resolved.workspaceId, generatedAt, { ...fingerprint, scannerVersion: GRAPH_SCANNER_VERSION }, shards);
    await writeGraph(resolved.storage, graph, shards);
    const changed = changedBuildPaths(previous, graph);
    const paths = boundedPaths(changed, options.limit);
    return { schemaVersion: 1, action: "build", root: resolved.repositoryRoot, fresh: true, buildMode: previous === undefined ? "full" : "incremental", fullRebuild: Boolean(options.force) || previous === undefined, ...(fingerprint.gitHead === undefined ? {} : { head: fingerprint.gitHead }), ...(previous?.source.gitHead === undefined ? {} : { previousHead: previous.source.gitHead }), dirtyFingerprint: fingerprint.dirtyFingerprint, changedPaths: paths.values, truncated: paths.truncated, scannedFileCount: files.length, removedFileCount: Math.max(0, (previous?.files.length ?? 0) - files.length), fileCount: graph.files.length, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, diagnosticCount: graph.diagnostics.length, generatedAt };
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
    return { schemaVersion: 1, action: "status", root: resolved.repositoryRoot, available: true, fresh, ...(fresh ? {} : { reason: "Repository content changed since the last graph build." }), ...(graph.source.gitHead === undefined ? {} : { indexedHead: graph.source.gitHead }), ...(current.gitHead === undefined ? {} : { currentHead: current.gitHead }), counts: { files: graph.files.length, nodes: graph.nodes.length, edges: graph.edges.length, diagnostics: graph.diagnostics.length }, generatedAt: graph.generatedAt };
}
export async function queryGraphOperation(options) { const loaded = await load(options); const result = queryGraph(loaded.graph, { query: options.query, ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.responseByteLimit === undefined ? {} : { responseByteLimit: options.responseByteLimit }) }); return boundedEnvelope(envelope("query", loaded.root, loaded.graph, result, { query: options.query }), options.responseByteLimit); }
export { queryGraphOperation as queryGraph };
export async function getGraphContext(options) { const loaded = await load(options); const result = contextGraph(loaded.graph, options.target, options.limit, options.responseByteLimit); return boundedEnvelope(envelope("context", loaded.root, loaded.graph, result, { target: options.target }), options.responseByteLimit); }
export async function analyzeGraphImpact(options) { const loaded = await load(options); const direction = options.direction ?? "both"; const depth = options.depth ?? GRAPH_DEFAULTS.maxTraversalDepth; const result = impactGraph(loaded.graph, options.target, direction, depth, options.limit, options.responseByteLimit); const value = { schemaVersion: 1, action: "impact", root: loaded.root, nodes: result.nodes, edges: result.edges, truncated: result.truncated, diagnostics: loaded.graph.diagnostics, target: options.target, direction, depth, paths: result.paths }; return boundedEnvelope(value, options.responseByteLimit); }
export async function analyzeGraphChanges(options) { const loaded = await load(options); const changedPaths = await changedRepositoryPaths(loaded.root, options.base); const changedIds = loaded.graph.nodes.filter((node) => changedPaths.includes(node.path)).map((node) => node.id); const result = impactFromIds(loaded.graph, changedIds, options.limit, options.responseByteLimit); const boundedChangedPaths = boundedPaths(changedPaths, options.limit); const value = { schemaVersion: 1, action: "changes", root: loaded.root, nodes: result.nodes, edges: result.edges, truncated: result.truncated || boundedChangedPaths.truncated, diagnostics: loaded.graph.diagnostics, changedPaths: boundedChangedPaths.values, ...(options.base === undefined ? {} : { base: options.base }) }; return boundedEnvelope(value, options.responseByteLimit); }
export async function getArchitectureMap(options) { const loaded = await load(options); const max = entityLimit(options.limit); const modules = loaded.graph.nodes.filter((node) => node.kind === "module").sort((left, right) => left.path.localeCompare(right.path)); const degree = new Map(); const imported = new Set(); for (const edge of loaded.graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    if (edge.kind === "imports")
        imported.add(edge.to);
} const entrypoints = modules.filter((module) => !imported.has(module.id)); const hubs = [...loaded.graph.nodes].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id)); const flows = moduleFlows(loaded.graph).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)); const cycles = moduleCycles(loaded.graph); const value = { schemaVersion: 1, action: "map", root: loaded.root, modules: modules.slice(0, max), entrypoints: entrypoints.slice(0, max), hubs: hubs.slice(0, max), cycles: cycles.slice(0, max), flows: flows.slice(0, max), truncated: modules.length > max || entrypoints.length > max || hubs.length > max || cycles.length > max || flows.length > max, truncatedCollections: { modules: modules.length > max, entrypoints: entrypoints.length > max, hubs: hubs.length > max, cycles: cycles.length > max, flows: flows.length > max, diagnostics: false }, diagnostics: loaded.graph.diagnostics }; return boundedEnvelope(value, options.responseByteLimit); }
async function load(options) { const resolved = await resolveGraphStorage(options.root, options.homeDir); return { root: resolved.repositoryRoot, graph: await readStoredGraph(resolved.storage) }; }
function envelope(action, root, graph, result, extra) { return { schemaVersion: 1, action, root, nodes: result.nodes, edges: result.edges, truncated: result.truncated, diagnostics: graph.diagnostics, ...extra }; }
function impactFromIds(graph, roots, limit, byteLimit) { const visited = new Set(roots); let frontier = [...visited].sort(); let truncated = false; for (let depth = 1; depth <= GRAPH_DEFAULTS.maxTraversalDepth && frontier.length > 0; depth += 1) {
    const next = new Set();
    for (const current of frontier)
        for (const edge of graph.edges)
            if (edge.to === current && !visited.has(edge.from)) {
                visited.add(edge.from);
                next.add(edge.from);
            }
    frontier = [...next].sort();
    if (depth === GRAPH_DEFAULTS.maxTraversalDepth && frontier.length > 0)
        truncated = true;
} const candidates = graph.nodes.filter((node) => visited.has(node.id)).sort((left, right) => left.id.localeCompare(right.id)); const max = entityLimit(limit); let nodes = candidates.slice(0, max); let edges = graph.edges.filter((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to)).sort((left, right) => left.id.localeCompare(right.id)); while (nodes.length > 0 && Buffer.byteLength(JSON.stringify({ nodes, edges }), "utf8") > responseLimit(byteLimit)) {
    nodes = nodes.slice(0, -1);
    const ids = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    truncated = true;
} return { nodes, edges, truncated: truncated || candidates.length > max, unresolvedEdgeCount: 0 }; }
function moduleFlows(graph) { const byId = new Map(graph.nodes.filter((node) => node.kind === "module").map((node) => [node.id, node.path])); const weights = new Map(); for (const edge of graph.edges.filter((edge) => edge.kind === "imports")) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from && to) {
        const key = `${from}\u0000${to}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
    }
} return [...weights].map(([key, weight]) => { const [from, to] = key.split("\u0000"); return { from: from, to: to, weight }; }); }
function moduleCycles(graph) { const flows = moduleFlows(graph); const adjacency = new Map(); for (const flow of flows)
    adjacency.set(flow.from, [...(adjacency.get(flow.from) ?? []), flow.to].sort((left, right) => left.localeCompare(right))); const index = new Map(); const lowLink = new Map(); const stack = []; const onStack = new Set(); const components = []; let nextIndex = 0; const visit = (node) => { index.set(node, nextIndex); lowLink.set(node, nextIndex); nextIndex += 1; stack.push(node); onStack.add(node); for (const target of adjacency.get(node) ?? [])
    if (!index.has(target)) {
        visit(target);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(target)));
    }
    else if (onStack.has(target))
        lowLink.set(node, Math.min(lowLink.get(node), index.get(target))); if (lowLink.get(node) === index.get(node)) {
    const component = [];
    let member;
    do {
        member = stack.pop();
        if (member) {
            onStack.delete(member);
            component.push(member);
        }
    } while (member !== node);
    if (component.length > 1 || (adjacency.get(node) ?? []).includes(node))
        components.push(component.sort((left, right) => left.localeCompare(right)));
} }; for (const node of [...new Set([...adjacency.keys(), ...flows.map((flow) => flow.to)])].sort((left, right) => left.localeCompare(right)))
    if (!index.has(node))
        visit(node); return components.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000"))); }
function boundedEnvelope(value, requestedByteLimit) { const limit = responseLimit(requestedByteLimit); const bounded = structuredClone(value); const trim = (key) => { const valueAtKey = bounded[key]; if (Array.isArray(valueAtKey) && valueAtKey.length > 0) {
    valueAtKey.pop();
    bounded.truncated = true;
    const collections = bounded.truncatedCollections;
    if (isTruncationCollections(collections))
        markCollectionTruncated(collections, key);
    return true;
} return false; }; while (Buffer.byteLength(JSON.stringify(bounded), "utf8") > limit)
    if (!(trim("diagnostics") || trim("paths") || trim("edges") || trim("nodes") || trim("cycles") || trim("flows") || trim("hubs") || trim("entrypoints") || trim("modules") || trim("changedPaths")))
        break; if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > limit)
    throw new OpenWikiError("SOURCE_TOO_LARGE", "Graph response metadata exceeds the response byte limit."); return bounded; }
function isTruncationCollections(value) { if (value === null || typeof value !== "object" || Array.isArray(value))
    return false; const entries = Object.entries(value); return entries.length === 6 && entries.every(([key, item]) => ["modules", "entrypoints", "hubs", "cycles", "flows", "diagnostics"].includes(key) && typeof item === "boolean"); }
function markCollectionTruncated(collections, key) { if (key === "modules" || key === "entrypoints" || key === "hubs" || key === "cycles" || key === "flows" || key === "diagnostics")
    collections[key] = true; }
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
            const symbolNode = node("symbol", shard.path, symbol.name, symbol.kind, symbol.startLine, symbol.endLine, symbol.scope);
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
        const localByQualifiedName = new Map(localSymbols.map((symbol) => [`${symbol.scope === undefined ? "" : `${symbol.scope}.`}${symbol.name}`, symbol]));
        for (const relation of shard.scan.relations ?? []) {
            const from = localByQualifiedName.get(relation.fromQualifiedName);
            const target = symbolNodes.get(relation.target) ?? [];
            if (from && target.length === 1 && target[0])
                addEdge(relation.kind, from, target[0], relation.confidence);
            else if (target.length > 1)
                diagnostics.push({ path: shard.path, code: "AMBIGUOUS_SYMBOL", message: `Symbol ${relation.target} is ambiguous.` });
            else if (from)
                diagnostics.push({ path: shard.path, code: "UNRESOLVED_SYMBOL", message: `Unable to resolve symbol ${relation.target}.` });
        }
    }
    return canonicalizeGraph({ schemaVersion: 1, workspaceId, generatedAt, source, files: shards.map(({ path: filePath, language, contentHash, size }) => ({ path: filePath, language, contentHash, size })), nodes, edges, diagnostics });
}
function node(kind, nodePath, name, symbolKind, startLine, endLine, scope) { const discriminator = startLine === undefined ? undefined : scope === undefined || scope.length === 0 ? String(startLine) : `${scope}\u0000${startLine.toString()}`; return { id: createGraphNodeId(kind, nodePath, name, symbolKind, discriminator), kind, path: nodePath, name, ...(scope === undefined || scope.length === 0 ? {} : { scope }), ...(symbolKind === undefined ? {} : { symbolKind }), ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) }; }
function resolveImport(from, specifier, files) { const base = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : specifier; const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"].map((extension) => `${base}${extension}`), ...["index.ts", "index.js", "__init__.py"].map((index) => `${base}/${index}`)]; return candidates.find((candidate) => files.has(candidate)); }
function changedBuildPaths(previous, graph) { if (previous === undefined)
    return graph.files.map((file) => file.path).sort((left, right) => left.localeCompare(right)); const previousFiles = new Map(previous.files.map((file) => [file.path, file.contentHash])); const currentFiles = new Map(graph.files.map((file) => [file.path, file.contentHash])); return [...new Set([...previousFiles.keys(), ...currentFiles.keys()].filter((filePath) => previousFiles.get(filePath) !== currentFiles.get(filePath)))].sort((left, right) => left.localeCompare(right)); }
function boundedPaths(paths, limit) { const max = entityLimit(limit); return { values: [...paths].sort((left, right) => left.localeCompare(right)).slice(0, max), truncated: paths.length > max }; }
