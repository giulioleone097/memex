import path from "node:path";
import { GRAPH_CONTRACTS_SCHEMA_VERSION, GRAPH_DEFAULTS, GRAPH_SCANNER_VERSION, canonicalizeGraph, createGraphEdgeId, createGraphNodeId, mergeEnrichment, } from "./graph-contracts.js";
import { entityLimit, matchTargets, responseLimit } from "./graph-query.js";
import { changedRepositoryEvidence, currentGitFingerprint, enumerateRepositoryMetadata, openGraphIndex, probeGraphStorage, readEnrichmentShard, readGraphShard, readManifest, readRepositoryFile, readStoredGraph, repositoryMetadataFingerprint, resolveGraphStorage, resolveRepositorySourceIds, writeGraph } from "./graph-store.js";
import { openGraphCypher } from "./graph-index.js";
import { openWasmTier } from "./ladybug-wasm.js";
import { openNativeTier } from "./ladybug-native.js";
import { scanSourceFile } from "./graph-scan.js";
import { computeCommunities, computeCoverageStats, computeGodNodes, computeShortestPath, computeSuggestedQuestions, computeSurprisingConnections, findCitingPages, summarizeCommunities, synthesizeMemberOfEdges, } from "./analyze.js";
import { probeAnalysisStorage, readCommunitiesSnapshot, resolveAnalysisStorage, writeCommunitiesSnapshot } from "./analysis-store.js";
import { renderGraphReportMarkdown } from "./report.js";
import { resolveWikiLocation } from "./paths.js";
import { writePage } from "./wiki.js";
import { MemexError } from "./errors.js";
import { reindexCodeSymbols } from "./reindex.js";
const GOD_NODE_LIMIT = 20;
const SURPRISING_CONNECTION_LIMIT = 20;
const AMBIGUOUS_EDGE_LIMIT = 50;
const LAZY_TRAVERSAL_MAX_VISITED = 10_000;
const LAZY_TRAVERSAL_DEADLINE_MS = 2_000;
export async function buildGraph(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    const limits = { maxFiles: options.limits?.maxFiles ?? GRAPH_DEFAULTS.maxFiles, maxFileBytes: options.limits?.maxFileBytes ?? GRAPH_DEFAULTS.maxFileBytes, maxRepositoryBytes: options.limits?.maxRepositoryBytes ?? GRAPH_DEFAULTS.maxRepositoryBytes };
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- build compares generations through the deprecated compatibility snapshot only.
    const previous = options.force ? undefined : await readStoredGraph(resolved.storage).catch(() => undefined);
    const manifest = await readManifest(resolved.storage).catch(() => undefined);
    const previousManifest = options.force ? undefined : manifest;
    const enrichmentShards = await Promise.all((manifest?.enrichmentShards ?? []).map((entry) => readEnrichmentShard(resolved.storage, entry.shard)));
    const enumerated = await enumerateRepositoryMetadata(resolved.repositoryRoot, limits);
    const metadata = enumerated.files;
    const previousBySource = new Map(previousManifest?.shards.map((entry) => [`${entry.path}\u0000${entry.sourceId}`, entry]) ?? []);
    const shards = [];
    const sourceState = [];
    let reused = 0;
    for (const file of metadata) {
        const prior = file.sourceId === undefined ? undefined : previousBySource.get(`${file.path}\u0000${file.sourceId}`);
        if (prior !== undefined) {
            try {
                const shard = await readGraphShard(resolved.storage, prior.shard);
                if (shard.path === file.path && shard.sourceId === file.sourceId) {
                    shards.push(shard);
                    sourceState.push({ path: file.path, size: file.size, sourceId: file.sourceId });
                    reused += 1;
                    continue;
                }
            }
            catch { /* corrupt private shard is rescanned */ }
        }
        let loaded;
        try {
            loaded = await readRepositoryFile(resolved.repositoryRoot, file);
        }
        catch (error) {
            if (error instanceof MemexError && error.code === "UNSUPPORTED_SOURCE")
                continue;
            throw error;
        }
        const loadedPrior = previousBySource.get(`${loaded.path}\u0000${loaded.sourceId}`);
        if (loadedPrior !== undefined) {
            try {
                const shard = await readGraphShard(resolved.storage, loadedPrior.shard);
                if (shard.path === loaded.path && shard.sourceId === loaded.sourceId) {
                    shards.push(shard);
                    sourceState.push({ path: loaded.path, size: loaded.size, sourceId: loaded.sourceId });
                    reused += 1;
                    continue;
                }
            }
            catch { /* corrupt private shard is rescanned */ }
        }
        shards.push({ path: loaded.path, language: loaded.language, contentHash: loaded.contentHash, size: loaded.size, sourceId: loaded.sourceId, scan: scanSourceFile({ path: loaded.path, language: loaded.language, content: loaded.content }) });
        sourceState.push({ path: loaded.path, size: loaded.size, sourceId: loaded.sourceId });
    }
    const git = await currentGitFingerprint(resolved.repositoryRoot);
    const fingerprint = { ...git, dirtyFingerprint: repositoryMetadataFingerprint(sourceState) };
    const generatedAt = options.now ?? new Date().toISOString();
    const codeGraph = assembleGraph(resolved.workspaceId, generatedAt, { ...fingerprint, scannerVersion: GRAPH_SCANNER_VERSION }, shards, enumerated.diagnostics);
    const graph = mergeEnrichment(codeGraph, enrichmentShards);
    await writeGraph(resolved.storage, graph, shards, enrichmentShards);
    await reindexCodeSymbols(resolved.repositoryRoot, await openGraphIndex(resolved.storage), options.homeDir);
    const changed = changedBuildPaths(previous, graph);
    const paths = boundedPaths(changed, options.limit);
    const value = { schemaVersion: 1, action: "build", root: resolved.repositoryRoot, fresh: true, buildMode: previous === undefined ? "full" : "incremental", fullRebuild: Boolean(options.force) || previous === undefined, ...(fingerprint.gitHead === undefined ? {} : { head: fingerprint.gitHead }), ...(previous?.source.gitHead === undefined ? {} : { previousHead: previous.source.gitHead }), dirtyFingerprint: fingerprint.dirtyFingerprint, changedPaths: paths.values, truncated: paths.truncated, scannedFileCount: metadata.length - reused, removedFileCount: Math.max(0, (previous?.files.length ?? 0) - metadata.length), fileCount: graph.files.length, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, diagnosticCount: graph.diagnostics.length, diagnostics: graph.diagnostics, generatedAt };
    return boundedEnvelope(value, options.responseByteLimit);
}
export async function getGraphStatus(options) {
    const probed = await probeGraphStorage(options.root, options.homeDir);
    if (!probed.initialized)
        return { schemaVersion: 1, action: "status", root: probed.repositoryRoot, available: false, fresh: false, reason: "No recoverable Memex graph manifest exists." };
    let manifest;
    try {
        manifest = await readManifest(probed.storage);
    }
    catch {
        return { schemaVersion: 1, action: "status", root: probed.repositoryRoot, available: false, fresh: false, reason: "No recoverable Memex graph manifest exists." };
    }
    const [evidence, enumerated, index] = await Promise.all([changedRepositoryEvidence(probed.repositoryRoot), enumerateRepositoryMetadata(probed.repositoryRoot, GRAPH_DEFAULTS), openGraphIndex(probed.storage)]);
    const metadata = enumerated.files;
    const indexedPaths = new Set(manifest.shards.map((shard) => shard.path));
    const sourceState = await resolveRepositorySourceIds(probed.repositoryRoot, metadata.filter((file) => file.sourceId === undefined || indexedPaths.has(file.path)));
    const fresh = evidence.head === manifest.source.gitHead && repositoryMetadataFingerprint(sourceState) === manifest.source.dirtyFingerprint;
    const diagnostics = (await index.architectureSummary()).diagnostics;
    return { schemaVersion: 1, action: "status", root: probed.repositoryRoot, available: true, fresh, ...(fresh ? {} : { reason: evidence.changeState === "working-tree" ? "Repository content changed since the last graph build." : "Repository HEAD changed since the last graph build." }), ...(manifest.source.gitHead === undefined ? {} : { indexedHead: manifest.source.gitHead }), ...(evidence.head === undefined ? {} : { currentHead: evidence.head }), counts: manifest.counts, diagnostics, generatedAt: manifest.generatedAt };
}
export async function queryGraphOperation(options) { const loaded = await loadIndex(options); const result = await lazyCandidates(loaded.index, options.query, options.limit, options.responseByteLimit, loaded.diagnostics); return boundedEnvelope(envelope("query", loaded.root, loaded.diagnostics, result, { query: options.query }), options.responseByteLimit); }
export { queryGraphOperation as queryGraph };
export async function getGraphContext(options) { const loaded = await loadIndex(options); const roots = await lazyTargetNodes(loaded.index, options.target, options.limit); const ids = new Set(roots.map((node) => node.id)); const adjacency = await adjacentEdges(loaded.index, ids, entityLimit(options.limit)); for (const edge of adjacency.edges) {
    ids.add(edge.from);
    ids.add(edge.to);
} const result = await lazyResult(loaded.index, ids, adjacency.edges, options.limit, options.responseByteLimit, loaded.diagnostics); return boundedEnvelope(envelope("context", loaded.root, loaded.diagnostics, { ...result, truncated: result.truncated || adjacency.truncated }, { target: options.target }), options.responseByteLimit); }
export async function analyzeGraphImpact(options) { const loaded = await loadIndex(options); const direction = options.direction ?? "both"; const depth = options.depth ?? GRAPH_DEFAULTS.maxTraversalDepth; const roots = await lazyTargetNodes(loaded.index, options.target, options.limit); const impact = await lazyImpact(loaded.index, roots.map((node) => node.id), direction, depth, options.limit, options.responseByteLimit, loaded.diagnostics); const value = { schemaVersion: 1, action: "impact", root: loaded.root, nodes: impact.nodes, edges: impact.edges, truncated: impact.truncated, diagnostics: loaded.diagnostics, target: options.target, direction, depth, paths: impact.paths }; return boundedEnvelope(value, options.responseByteLimit); }
export async function analyzeGraphChanges(options) { const loaded = await loadIndex(options); const evidence = await changedRepositoryEvidence(loaded.root, options.base); const changedIds = await loaded.index.changedPathSeeds(evidence.paths, entityLimit(options.limit)); const result = await lazyImpact(loaded.index, changedIds, "inbound", GRAPH_DEFAULTS.maxTraversalDepth, options.limit, options.responseByteLimit, loaded.diagnostics); const boundedChangedPaths = boundedPaths(evidence.paths, options.limit); const value = { schemaVersion: 1, action: "changes", root: loaded.root, nodes: result.nodes, edges: result.edges, truncated: result.truncated || boundedChangedPaths.truncated, diagnostics: loaded.diagnostics, changedPaths: boundedChangedPaths.values, changeState: evidence.changeState, ...(evidence.head === undefined ? {} : { head: evidence.head }), ...(options.base === undefined ? {} : { base: options.base }) }; return boundedEnvelope(value, options.responseByteLimit); }
export async function getArchitectureMap(options) { const loaded = await loadIndex(options); const summary = await loaded.index.architectureSummary(); const max = entityLimit(options.limit); const entrypoints = await nodesByIds(loaded.index, summary.entrypoints); const hubs = await nodesByIds(loaded.index, summary.hubs.map((hub) => hub.id)); const flows = await lazyFlows(loaded.index, summary.flows); const cycles = await lazyCycles(loaded.index, summary.cycles); const value = { schemaVersion: 1, action: "map", root: loaded.root, modules: summary.modules.slice(0, max), entrypoints: entrypoints.slice(0, max), hubs: hubs.slice(0, max), cycles: cycles.slice(0, max), flows: flows.slice(0, max), truncated: summary.modules.length > max || entrypoints.length > max || hubs.length > max || cycles.length > max || flows.length > max, truncatedCollections: { modules: summary.modules.length > max, entrypoints: entrypoints.length > max, hubs: hubs.length > max, cycles: cycles.length > max, flows: flows.length > max, diagnostics: false }, diagnostics: loaded.diagnostics }; return boundedEnvelope(value, options.responseByteLimit); }
async function loadIndex(options) { const resolved = await resolveGraphStorage(options.root, options.homeDir); const index = await openGraphIndex(resolved.storage); return { root: resolved.repositoryRoot, index, diagnostics: (await index.architectureSummary()).diagnostics }; }
function envelope(action, root, diagnostics, result, extra) { return { schemaVersion: 1, action, root, nodes: result.nodes, edges: result.edges, truncated: result.truncated, diagnostics, ...extra }; }
async function lazyCandidates(index, query, limit, byteLimit, diagnostics) { if (query.trim().length === 0)
    throw new MemexError("INVALID_ARGUMENT", "Graph query must not be empty."); const ids = await index.rankedCandidates(query, entityLimit(limit)); const adjacency = await adjacentEdges(index, new Set(ids), entityLimit(limit)); const result = await lazyResult(index, new Set(ids), adjacency.edges, limit, byteLimit, diagnostics); return { ...result, truncated: result.truncated || adjacency.truncated }; }
async function lazyTargetNodes(index, target, limit) { const candidates = await index.rankedCandidates(target, entityLimit(limit)); const nodes = await nodesByIds(index, candidates); const needle = target.toLowerCase(); const exact = nodes.filter((node) => node.id === target || node.path === target || node.name.toLowerCase() === needle || `${node.scope ?? ""}.${node.name}`.replace(/^\./u, "").toLowerCase() === needle); if (exact.length > 0)
    return exact; if (nodes.length === 0)
    throw new MemexError("NOT_FOUND", "Graph target was not found."); return nodes.slice(0, 1); }
async function nodesByIds(index, ids) { const nodes = await Promise.all([...new Set(ids)].map((id) => index.node(id))); return nodes.filter((node) => node !== undefined).sort((left, right) => left.id.localeCompare(right.id)); }
async function adjacentEdges(index, ids, limit) { const edges = new Map(); let truncated = false; for (const id of [...ids].sort((left, right) => left.localeCompare(right))) {
    const [inbound, outbound] = await Promise.all([index.inbound(id, limit), index.outbound(id, limit)]);
    truncated ||= inbound.truncated || outbound.truncated;
    for (const edge of [...inbound.edges, ...outbound.edges])
        edges.set(edge.id, edge);
} return { edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)), truncated }; }
async function lazyResult(index, ids, edges, limit, byteLimit, diagnostics) { const max = entityLimit(limit); let nodes = (await nodesByIds(index, [...ids])).slice(0, max); let resultEdges = containedEdges(edges, nodes); let truncated = ids.size > max; while (nodes.length > 0 && Buffer.byteLength(JSON.stringify({ nodes, edges: resultEdges }), "utf8") > responseLimit(byteLimit)) {
    nodes = nodes.slice(0, -1);
    resultEdges = containedEdges(edges, nodes);
    truncated = true;
} return { nodes, edges: resultEdges, truncated, unresolvedEdgeCount: diagnostics.filter((diagnostic) => diagnostic.code.startsWith("UNRESOLVED") || diagnostic.code.startsWith("AMBIGUOUS")).length }; }
async function lazyImpact(index, rootIds, direction, depth, limit, byteLimit, diagnostics) { if (!Number.isSafeInteger(depth) || depth < 1 || depth > GRAPH_DEFAULTS.maxTraversalDepth)
    throw new MemexError("INVALID_ARGUMENT", "Graph traversal depth must be between 1 and 5."); const visited = new Set(rootIds); const paths = rootIds.map((nodeId) => ({ nodeId, depth: 0 })); const edges = new Map(); let frontier = [...visited].sort((left, right) => left.localeCompare(right)); let traversalTruncated = false; const deadline = Date.now() + LAZY_TRAVERSAL_DEADLINE_MS; for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0 && !traversalTruncated; currentDepth += 1) {
    const next = new Set();
    for (const id of frontier) {
        if (Date.now() >= deadline || visited.size >= LAZY_TRAVERSAL_MAX_VISITED) {
            traversalTruncated = true;
            break;
        }
        const sets = direction === "inbound" ? [await index.inbound(id, 100)] : direction === "outbound" ? [await index.outbound(id, 100)] : await Promise.all([index.inbound(id, 100), index.outbound(id, 100)]);
        for (const set of sets) {
            traversalTruncated ||= set.truncated;
            for (const edge of set.edges) {
                edges.set(edge.id, edge);
                const nodeId = direction === "inbound" ? edge.from : direction === "outbound" ? edge.to : edge.from === id ? edge.to : edge.from;
                if (!visited.has(nodeId)) {
                    visited.add(nodeId);
                    next.add(nodeId);
                    paths.push({ nodeId, depth: currentDepth, via: edge.id });
                }
            }
        }
    }
    frontier = [...next].sort((left, right) => left.localeCompare(right));
    if (currentDepth === depth && frontier.length > 0)
        traversalTruncated = true;
} const result = await lazyResult(index, visited, [...edges.values()], limit, byteLimit, diagnostics); const included = new Set(result.nodes.map((node) => node.id)); return { ...result, truncated: result.truncated || traversalTruncated, paths: paths.filter((entry) => included.has(entry.nodeId)).sort((left, right) => left.depth - right.depth || left.nodeId.localeCompare(right.nodeId)) }; }
function containedEdges(edges, nodes) { const ids = new Set(nodes.map((node) => node.id)); return edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).sort((left, right) => left.id.localeCompare(right.id)); }
async function lazyFlows(index, flows) { const weights = new Map(); for (const flow of flows.filter((flow) => flow.kind === "imports")) {
    const [from, to] = await Promise.all([index.node(flow.from), index.node(flow.to)]);
    if (from !== undefined && to !== undefined) {
        const key = `${from.path}\u0000${to.path}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
    }
} return [...weights.entries()].map(([key, weight]) => { const parts = key.split("\u0000"); return { from: parts[0] ?? "", to: parts[1] ?? "", weight }; }).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)); }
async function lazyCycles(index, cycles) { const result = []; for (const cycle of cycles) {
    const nodes = await nodesByIds(index, cycle);
    const paths = nodes.map((node) => node.path);
    if (paths.length > 1 && paths[0] === paths.at(-1))
        paths.pop();
    if (paths.length > 0)
        result.push([...new Set(paths)].sort((left, right) => left.localeCompare(right)));
} return result.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000"))); }
function boundedEnvelope(value, requestedByteLimit) { const limit = responseLimit(requestedByteLimit); const bounded = structuredClone(value); const trim = (key) => { const valueAtKey = bounded[key]; if (Array.isArray(valueAtKey) && valueAtKey.length > 0) {
    valueAtKey.pop();
    bounded.truncated = true;
    const collections = bounded.truncatedCollections;
    if (isTruncationCollections(collections))
        markCollectionTruncated(collections, key);
    return true;
} return false; }; while (Buffer.byteLength(JSON.stringify(bounded), "utf8") > limit)
    if (!(trim("diagnostics") || trim("paths") || trim("edges") || trim("nodes") || trim("cycles") || trim("flows") || trim("hubs") || trim("entrypoints") || trim("modules") || trim("changedPaths") || trim("rows")))
        break; if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > limit)
    throw new MemexError("SOURCE_TOO_LARGE", "Graph response metadata exceeds the response byte limit."); return bounded; }
function isTruncationCollections(value) { if (value === null || typeof value !== "object" || Array.isArray(value))
    return false; const entries = Object.entries(value); return entries.length === 6 && entries.every(([key, item]) => ["modules", "entrypoints", "hubs", "cycles", "flows", "diagnostics"].includes(key) && typeof item === "boolean"); }
function markCollectionTruncated(collections, key) { if (key === "modules" || key === "entrypoints" || key === "hubs" || key === "cycles" || key === "flows" || key === "diagnostics")
    collections[key] = true; }
export function assembleGraph(workspaceId, generatedAt, source, shards, boundaryDiagnostics = []) {
    const nodes = [];
    const edges = [];
    const diagnostics = [...boundaryDiagnostics];
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
    return canonicalizeGraph({ schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION, workspaceId, generatedAt, source, files: shards.map(({ path: filePath, language, contentHash, size }) => ({ path: filePath, language, contentHash, size })), nodes, edges, diagnostics });
}
function node(kind, nodePath, name, symbolKind, startLine, endLine, scope) { const discriminator = startLine === undefined ? undefined : scope === undefined || scope.length === 0 ? String(startLine) : `${scope}\u0000${startLine.toString()}`; return { id: createGraphNodeId(kind, nodePath, name, symbolKind, discriminator), kind, path: nodePath, name, ...(scope === undefined || scope.length === 0 ? {} : { scope }), ...(symbolKind === undefined ? {} : { symbolKind }), ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) }; }
function resolveImport(from, specifier, files) { const base = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : specifier; const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"].map((extension) => `${base}${extension}`), ...["index.ts", "index.js", "__init__.py"].map((index) => `${base}/${index}`)]; return candidates.find((candidate) => files.has(candidate)); }
function changedBuildPaths(previous, graph) { if (previous === undefined)
    return graph.files.map((file) => file.path).sort((left, right) => left.localeCompare(right)); const previousFiles = new Map(previous.files.map((file) => [file.path, file.contentHash])); const currentFiles = new Map(graph.files.map((file) => [file.path, file.contentHash])); return [...new Set([...previousFiles.keys(), ...currentFiles.keys()].filter((filePath) => previousFiles.get(filePath) !== currentFiles.get(filePath)))].sort((left, right) => left.localeCompare(right)); }
function boundedPaths(paths, limit) { const max = entityLimit(limit); return { values: [...paths].sort((left, right) => left.localeCompare(right)).slice(0, max), truncated: paths.length > max }; }
export async function renderGraphReport(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- report recomputes structural analytics over the full unified graph, not a bounded query path.
    const baseGraph = await readStoredGraph(resolved.storage);
    const manifest = await readManifest(resolved.storage);
    const shards = await Promise.all(manifest.shards.map((entry) => readGraphShard(resolved.storage, entry.shard)));
    const communities = computeCommunities(baseGraph);
    const memberOfEdges = synthesizeMemberOfEdges(baseGraph, communities);
    const existingEdgeIds = new Set(baseGraph.edges.map((edge) => edge.id));
    const mergedEdges = [...baseGraph.edges, ...memberOfEdges.filter((edge) => !existingEdgeIds.has(edge.id))];
    const graphWithCommunities = canonicalizeGraph({ ...baseGraph, edges: mergedEdges });
    await writeGraph(resolved.storage, graphWithCommunities, shards);
    const updatedManifest = await readManifest(resolved.storage);
    const nodesById = new Map(graphWithCommunities.nodes.map((node) => [node.id, node]));
    const godNodes = computeGodNodes(graphWithCommunities, GOD_NODE_LIMIT);
    const godNodeEntries = godNodes
        .map((entry) => ({ node: nodesById.get(entry.nodeId), degree: entry.degree }))
        .filter((entry) => entry.node !== undefined);
    const communitySummaries = summarizeCommunities(graphWithCommunities, communities);
    const membership = Object.fromEntries(communities);
    const generatedAt = options.now ?? new Date().toISOString();
    const analysisResolved = await resolveAnalysisStorage(options.root, options.homeDir);
    await writeCommunitiesSnapshot(analysisResolved.storage, {
        schemaVersion: 1,
        generation: updatedManifest.generation,
        generatedAt,
        communities: communitySummaries,
        membership,
    });
    const surprisingConnections = computeSurprisingConnections(graphWithCommunities, SURPRISING_CONNECTION_LIMIT)
        .map((connection) => ({ from: nodesById.get(connection.from), to: nodesById.get(connection.to), kind: connection.kind, confidence: connection.confidence, priority: connection.priority }))
        .filter((entry) => entry.from !== undefined && entry.to !== undefined);
    const coverage = computeCoverageStats(graphWithCommunities);
    const suggestedQuestions = computeSuggestedQuestions(godNodes, communitySummaries, graphWithCommunities);
    const ambiguousEdges = graphWithCommunities.edges
        .filter((edge) => edge.confidence === "ambiguous")
        .slice(0, AMBIGUOUS_EDGE_LIMIT)
        .map((edge) => ({ edge, from: nodesById.get(edge.from), to: nodesById.get(edge.to) }));
    const markdown = renderGraphReportMarkdown({
        root: resolved.repositoryRoot,
        generation: updatedManifest.generation,
        generatedAt,
        godNodes: godNodeEntries,
        communities: communitySummaries,
        surprisingConnections,
        suggestedQuestions,
        coverage,
        ambiguousEdges,
    });
    const location = await resolveWikiLocation({ mode: "code", root: options.root, ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }) });
    await writePage(location, "graph-report.md", markdown);
    return {
        schemaVersion: 1,
        action: "report",
        root: resolved.repositoryRoot,
        page: "graph-report.md",
        written: true,
        communityCount: communitySummaries.length,
        godNodeCount: godNodeEntries.length,
        surprisingConnectionCount: surprisingConnections.length,
        ambiguousEdgeCount: ambiguousEdges.length,
        coverageRatio: coverage.coverageRatio,
        generation: updatedManifest.generation,
        generatedAt,
    };
}
export async function listGraphCommunities(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    const analysis = await probeAnalysisStorage(options.root, options.homeDir);
    if (!analysis.initialized) {
        return { schemaVersion: 1, action: "communities", root: resolved.repositoryRoot, communities: [], stale: true, truncated: false };
    }
    const snapshot = await readCommunitiesSnapshot(analysis.storage);
    const manifest = await readManifest(resolved.storage).catch(() => undefined);
    const stale = manifest === undefined || manifest.generation !== snapshot.generation;
    const max = entityLimit(options.limit);
    const truncated = snapshot.communities.length > max;
    return {
        schemaVersion: 1,
        action: "communities",
        root: resolved.repositoryRoot,
        communities: snapshot.communities.slice(0, max),
        stale,
        generation: snapshot.generation,
        generatedAt: snapshot.generatedAt,
        truncated,
    };
}
export async function getGraphPath(options) {
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- path needs the full graph for a global shortest-path computation, not a bounded query path.
    const graph = await readStoredGraph(resolved.storage);
    const fromNode = matchTargets(graph, options.from)[0];
    const toNode = matchTargets(graph, options.to)[0];
    if (fromNode === undefined || toNode === undefined) {
        throw new MemexError("NOT_FOUND", "Graph target was not found.");
    }
    const found = computeShortestPath(graph, fromNode.id, toNode.id);
    if (found === undefined) {
        return { schemaVersion: 1, action: "path", root: resolved.repositoryRoot, from: options.from, to: options.to, found: false, nodes: [], edges: [], truncated: false };
    }
    const max = entityLimit(options.limit);
    const truncated = found.nodeIds.length > max;
    const boundedIds = new Set(found.nodeIds.slice(0, max));
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
    const nodes = found.nodeIds
        .filter((id) => boundedIds.has(id))
        .map((id) => nodesById.get(id))
        .filter((node) => node !== undefined);
    const edges = found.edgeIds
        .map((id) => edgesById.get(id))
        .filter((edge) => edge !== undefined && boundedIds.has(edge.from) && boundedIds.has(edge.to));
    return {
        schemaVersion: 1,
        action: "path",
        root: resolved.repositoryRoot,
        from: options.from,
        to: options.to,
        found: true,
        nodes,
        edges,
        totalWeight: found.totalWeight,
        truncated,
    };
}
export async function explainGraphNode(options) {
    const context = await getGraphContext(options);
    const needle = options.target.toLocaleLowerCase();
    const node = context.nodes.find((candidate) => candidate.id === options.target || candidate.path === options.target || candidate.name.toLocaleLowerCase() === needle) ??
        context.nodes[0];
    if (node === undefined) {
        throw new MemexError("NOT_FOUND", "Graph target was not found.");
    }
    const citingPages = findCitingPages(context.nodes, context.edges, node.id);
    const analysis = await probeAnalysisStorage(options.root, options.homeDir);
    let community;
    let communityStale = true;
    if (analysis.initialized) {
        const snapshot = await readCommunitiesSnapshot(analysis.storage);
        const graphResolved = await resolveGraphStorage(options.root, options.homeDir);
        const manifest = await readManifest(graphResolved.storage).catch(() => undefined);
        communityStale = manifest === undefined || manifest.generation !== snapshot.generation;
        const communityId = snapshot.membership[node.id];
        const summary = communityId === undefined ? undefined : snapshot.communities.find((entry) => entry.id === communityId);
        if (summary !== undefined) {
            community = { id: summary.id, memberCount: summary.memberCount, topTerms: summary.topTerms };
        }
    }
    return {
        schemaVersion: 1,
        action: "explain",
        root: context.root,
        target: options.target,
        node,
        neighborhood: { nodes: context.nodes, edges: context.edges, truncated: context.truncated },
        ...(community === undefined ? {} : { community }),
        communityStale,
        citingPages,
        diagnostics: context.diagnostics,
    };
}
// Runs a read-only Cypher query against the derived LadybugDB graph. The graph
// is loaded from the shard-backed index (openGraphIndex, the non-deprecated
// query path) and synced into the selected tier (native → wasm), rebuilt fresh
// per call. On the pure tier (no Cypher) this fails with a typed, actionable
// error rather than silently returning nothing.
export async function cypherGraph(options) {
    // Validate/derive the row cap BEFORE opening a tier, so an out-of-range limit
    // fails fast without paying the graph build + sync cost.
    const max = entityLimit(options.limit);
    const resolved = await resolveGraphStorage(options.root, options.homeDir);
    const index = await openGraphIndex(resolved.storage);
    const [nodes, edges] = await Promise.all([index.allNodes(), index.allEdges()]);
    const selection = await openGraphCypher({
        ...(options.preference === undefined ? {} : { preference: options.preference }),
        tryNative: () => openNativeTier({ nodes, edges }),
        tryWasm: () => openWasmTier({ nodes, edges }),
    });
    try {
        if (selection.cypher === undefined) {
            throw new MemexError("GRAPH_CYPHER_UNAVAILABLE", `Cypher requires the LadybugDB backend but the active tier is "${selection.tier}" (${selection.reason}). `
                + "Install @ladybugdb/core for the native tier, or run `memex doctor` to check the vendored wasm assets.");
        }
        // maxRows bounds the cursor read so an unbounded result set is never fully
        // materialized; `truncated` reflects whether more rows existed.
        const result = await selection.cypher.cypher(options.query, options.params, max);
        const value = {
            schemaVersion: 1,
            action: "cypher",
            root: resolved.repositoryRoot,
            tier: selection.tier,
            columns: result.columns,
            rows: result.rows,
            truncated: result.truncated,
            diagnostics: [],
        };
        return boundedEnvelope(value, options.responseByteLimit);
    }
    finally {
        await selection.close();
    }
}
