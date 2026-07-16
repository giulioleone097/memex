import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "./doctor.js";
import { defaultVendorRoot, loadEmbedder, loadVendorManifest } from "./embedder.js";
import { OpenWikiError } from "./errors.js";
import { collectGitContext } from "./git.js";
import { getGraphStatus } from "./graph.js";
import { openGraphIndex, probeGraphStorage, resolveGraphStorage } from "./graph-store.js";
import { openLexicalIndex } from "./lexical-index.js";
import { resolveWikiLocation } from "./paths.js";
import { ask as retrieveAsk, search as retrieveSearch, } from "./retrieve.js";
import { listSchedules, removeSchedule, setSchedule } from "./schedules.js";
import { ingestSource, listSources, purgeData } from "./sources.js";
import { readState } from "./state.js";
import { openVectorStore } from "./vector-store.js";
import { checkWiki, finalizeRun, initializeWiki, readPage, writePage, } from "./wiki.js";
export const OPENWIKI_OPERATIONS = [
    "init",
    "status",
    "context",
    "search",
    "ask",
    "read",
    "write",
    "ingest",
    "enrich",
    "finalize",
    "check",
    "doctor",
    "schedule",
    "purge",
    "graph",
];
const GRAPH_ACTIONS = [
    "build",
    "status",
    "query",
    "context",
    "impact",
    "changes",
    "map",
    "path",
    "explain",
    "communities",
    "report",
];
const MODES = ["code", "personal"];
const WIKI_COMMANDS = ["init", "update", "ingest"];
const GRAPH_RESPONSE_BYTE_LIMIT = 48 * 1024;
const RETRIEVAL_SIGNALS = ["lexical", "vector", "graph"];
function isRetrievalSignal(value) {
    return typeof value === "string" && RETRIEVAL_SIGNALS.includes(value);
}
function readOptionalSignals(input) {
    if (!has(input, "signals"))
        return undefined;
    const value = input.signals;
    if (!Array.isArray(value) || value.length === 0 || !value.every(isRetrievalSignal)) {
        throw invalid("Argument signals must be a non-empty array of lexical, vector, graph.");
    }
    return [...value];
}
async function openLexicalAndVector(location, wantsVector) {
    const lexicalIndex = await openLexicalIndex(path.join(location.dataRoot, "lexical"));
    if (!wantsVector)
        return { lexicalIndex };
    const vendorRoot = defaultVendorRoot();
    const embedder = await loadEmbedder(vendorRoot);
    const manifest = await loadVendorManifest(vendorRoot);
    const modelRevision = manifest.assets.find((asset) => asset.path.startsWith(`model/${embedder.modelId}/`))?.revision ?? "unknown";
    const vectorStore = await openVectorStore(path.join(location.dataRoot, "vectors"), { modelId: embedder.modelId, modelRevision, dims: embedder.dims });
    return { lexicalIndex, embedder, vectorStore };
}
// `search`'s graph signal is one of three optional inputs — absent when not
// yet built, degrading the implicit default rather than erroring.
async function openGraphIndexIfAvailable(location) {
    if (location.mode !== "code" || location.workspaceRoot === undefined)
        return undefined;
    const homeDir = hostHomeDir();
    const status = await getGraphStatus({ root: location.workspaceRoot, homeDir });
    if (!status.available)
        return undefined;
    const resolved = await resolveGraphStorage(location.workspaceRoot, homeDir);
    return openGraphIndex(resolved.storage);
}
export async function dispatch(request) {
    try {
        return { ok: true, data: await dispatchUnsafe(request) };
    }
    catch (error) {
        return toEnvelope(error);
    }
}
export function toEnvelope(error) {
    if (error instanceof OpenWikiError)
        return { ok: false, error: error.toJSON() };
    return {
        ok: false,
        error: { code: "IO_FAILURE", message: "OpenWiki operation failed unexpectedly." },
    };
}
async function dispatchUnsafe(request) {
    const input = readRecord(request.input, "Operation input must be an object.");
    switch (request.operation) {
        case "init": {
            const locationOptions = readLocation(input, ["mode", "root"]);
            const initialized = await initializeWiki(locationOptions);
            return {
                ...initialized,
                location: {
                    ...initialized.location,
                    dataRoot: path.join(hostHomeDir(), ".openwiki", "data", initialized.location.workspaceId),
                    ...(locationOptions.root === undefined
                        ? {}
                        : { workspaceRoot: locationOptions.root, wikiRoot: path.join(locationOptions.root, "openwiki") }),
                },
            };
        }
        case "status": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root"]));
            return { location, state: await readState(location), sources: await listSources(location) };
        }
        case "context": {
            assertKeys(input, ["root", "previousHead"]);
            return collectGitContext(readRequiredString(input, "root"), readOptionalString(input, "previousHead"));
        }
        case "search": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "query", "limit", "signals"]));
            const requested = readOptionalSignals(input);
            const explicit = requested !== undefined;
            const wantsVector = explicit ? requested.includes("vector") : true;
            const wantsGraph = explicit ? requested.includes("graph") : true;
            const lexicalAndVector = await openLexicalAndVector(location, wantsVector);
            const graphIndex = wantsGraph ? await openGraphIndexIfAvailable(location) : undefined;
            if (explicit && requested.includes("graph") && graphIndex === undefined) {
                throw new OpenWikiError("NOT_INITIALIZED", "Graph retrieval requires a built graph index; run graph build first.");
            }
            const signals = explicit ? requested : ["lexical", "vector", ...(graphIndex === undefined ? [] : ["graph"])];
            const ports = { ...lexicalAndVector, ...(graphIndex === undefined ? {} : { graphIndex }) };
            return retrieveSearch({ text: readRequiredString(input, "query"), limit: readOptionalBoundedInteger(input, "limit", 1, 100) ?? 20, signals }, ports);
        }
        case "ask": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "query", "limit", "signals"]));
            if (location.mode !== "code" || location.workspaceRoot === undefined) {
                throw invalid("Ask requires code mode until personal-mode graph support lands (2a).");
            }
            const requested = readOptionalSignals(input);
            const wantsVector = requested === undefined ? true : requested.includes("vector");
            const homeDir = hostHomeDir();
            const [lexicalAndVector, status] = await Promise.all([
                openLexicalAndVector(location, wantsVector),
                getGraphStatus({ root: location.workspaceRoot, homeDir }),
            ]);
            if (!status.available)
                throw new OpenWikiError("NOT_INITIALIZED", "Ask requires a built graph index; run graph build first.");
            const resolved = await resolveGraphStorage(location.workspaceRoot, homeDir);
            const graphIndex = await openGraphIndex(resolved.storage);
            return retrieveAsk(readRequiredString(input, "query"), readOptionalBoundedInteger(input, "limit", 1, 100) ?? 20, { ...lexicalAndVector, graphIndex }, { stale: !status.fresh }, requested);
        }
        case "read": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "page"]));
            return readPage(location, readRequiredString(input, "page"));
        }
        case "write": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "page", "content"]));
            const page = readRequiredString(input, "page");
            await writePage(location, page, readRequiredString(input, "content"));
            return { page, written: true };
        }
        case "ingest": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "envelope"]));
            return ingestSource({ location, envelope: requireValue(input, "envelope") });
        }
        case "enrich": {
            assertKeys(input, ["root", "envelope"]);
            const root = readRequiredString(input, "root");
            const envelope = requireValue(input, "envelope");
            const enrich = await loadEnrich();
            return enrich.enrichGraph({ root, homeDir: hostHomeDir(), envelope });
        }
        case "finalize": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "command", "runId", "startedAt", "completedAt", "summary", "lastGitHead"]));
            return finalizeRun({
                location,
                command: readEnum(input, "command", WIKI_COMMANDS),
                runId: readRequiredString(input, "runId"),
                startedAt: readRequiredString(input, "startedAt"),
                ...(has(input, "completedAt") ? { completedAt: readRequiredString(input, "completedAt") } : {}),
                summary: readRequiredString(input, "summary"),
                ...(has(input, "lastGitHead") ? { lastGitHead: readRequiredString(input, "lastGitHead") } : {}),
            });
        }
        case "check": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root"]));
            const graphIndex = location.mode === "code" ? await tryOpenGraphIndexForCheck(location.workspaceRoot, hostHomeDir()) : undefined;
            return checkWiki(location, { ...(graphIndex === undefined ? {} : { graph: graphIndex }) });
        }
        case "doctor": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root"]));
            return runDoctor({ location });
        }
        case "schedule":
            return dispatchSchedule(input);
        case "purge": {
            const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "scope"]));
            return purgeData({ location, scope: readEnum(input, "scope", ["raw", "schedules", "personal-wiki", "all"]) });
        }
        case "graph":
            return dispatchGraph(input);
    }
}
async function dispatchSchedule(input) {
    assertKeys(input, ["mode", "root", "action", "id", "operation", "cron", "timezone", "sourceId", "enabled"]);
    const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "action", "id", "operation", "cron", "timezone", "sourceId", "enabled"]));
    const action = readEnum(input, "action", ["set", "list", "remove"]);
    if (action === "list") {
        assertAbsent(input, ["id", "operation", "cron", "timezone", "sourceId", "enabled"]);
        return listSchedules(location);
    }
    const id = readRequiredString(input, "id");
    if (action === "remove") {
        assertAbsent(input, ["operation", "cron", "timezone", "sourceId", "enabled"]);
        return removeSchedule({ location, id });
    }
    const operation = readEnum(input, "operation", ["update", "ingest"]);
    const sourceId = readOptionalString(input, "sourceId");
    if (operation === "update" && sourceId !== undefined)
        throw invalid("Update schedules cannot include sourceId.");
    if (operation === "ingest" && sourceId === undefined)
        throw invalid("Ingest schedules require sourceId.");
    return setSchedule({
        location,
        schedule: {
            schemaVersion: 1,
            id,
            command: operation,
            cron: readRequiredString(input, "cron"),
            ...(readOptionalString(input, "timezone") === undefined ? {} : { timezone: readOptionalString(input, "timezone") }),
            enabled: has(input, "enabled") ? readBoolean(input, "enabled") : true,
            ...(sourceId === undefined ? {} : { sourceId }),
        },
    });
}
async function dispatchGraph(input) {
    assertKeys(input, ["mode", "root", "action", "force", "query", "target", "base", "direction", "depth", "limit", "from", "to"]);
    if (has(input, "mode"))
        readEnum(input, "mode", ["code"]);
    const root = readRequiredString(input, "root");
    const action = readEnum(input, "action", GRAPH_ACTIONS);
    const force = has(input, "force") ? readBoolean(input, "force") : undefined;
    const limit = readOptionalBoundedInteger(input, "limit", 1, 100);
    const target = readOptionalString(input, "target");
    const query = readOptionalString(input, "query");
    const base = readOptionalString(input, "base");
    const direction = has(input, "direction") ? readEnum(input, "direction", ["inbound", "outbound", "both"]) : undefined;
    const depth = readOptionalBoundedInteger(input, "depth", 1, 5);
    const from = readOptionalString(input, "from");
    const to = readOptionalString(input, "to");
    const graph = await loadGraph();
    if (action === "build") {
        assertAbsent(input, ["query", "target", "base", "direction", "depth", "limit"]);
        return publicGraphResult("build", root, await graph.buildGraph({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(force === undefined ? {} : { force }) }), limit);
    }
    if (action === "status") {
        assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "limit"]);
        return publicGraphResult("status", root, await graph.getGraphStatus({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT }), limit);
    }
    if (action === "query") {
        assertAbsent(input, ["force", "target", "base", "direction", "depth"]);
        if (query === undefined)
            throw invalid("Graph query requires query.");
        return publicGraphResult("query", root, await graph.queryGraph({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, query, ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "context") {
        assertAbsent(input, ["force", "query", "base", "direction", "depth"]);
        if (target === undefined)
            throw invalid("Graph context requires target.");
        return publicGraphResult("context", root, await graph.getGraphContext({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, target, ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "impact") {
        assertAbsent(input, ["force", "query", "base"]);
        if (target === undefined)
            throw invalid("Graph impact requires target.");
        return publicGraphResult("impact", root, await graph.analyzeGraphImpact({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, target, ...(direction === undefined ? {} : { direction }), ...(depth === undefined ? {} : { depth }), ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "changes") {
        assertAbsent(input, ["force", "query", "target", "direction", "depth"]);
        return publicGraphResult("changes", root, await graph.analyzeGraphChanges({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(base === undefined ? {} : { base }), ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "path") {
        assertAbsent(input, ["force", "query", "target", "base", "direction", "depth"]);
        if (from === undefined || to === undefined)
            throw invalid("Graph path requires from and to.");
        return publicGraphResult("path", root, await graph.getGraphPath({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, from, to, ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "explain") {
        assertAbsent(input, ["force", "query", "base", "direction", "depth", "from", "to"]);
        if (target === undefined)
            throw invalid("Graph explain requires target.");
        return publicGraphResult("explain", root, await graph.explainGraphNode({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, target, ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "communities") {
        assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "from", "to"]);
        return publicGraphResult("communities", root, await graph.listGraphCommunities({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(limit === undefined ? {} : { limit }) }), limit);
    }
    if (action === "report") {
        assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "from", "to", "limit"]);
        return publicGraphResult("report", root, await graph.renderGraphReport({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT }), limit);
    }
    assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "from", "to"]);
    return publicGraphResult("map", root, await graph.getArchitectureMap({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(limit === undefined ? {} : { limit }) }), limit);
}
async function tryOpenGraphIndexForCheck(workspaceRoot, homeDir) {
    const probe = await probeGraphStorage(workspaceRoot, homeDir);
    if (!probe.initialized)
        return undefined;
    const resolved = await resolveGraphStorage(workspaceRoot, homeDir);
    return openGraphIndex(resolved.storage);
}
function publicGraphResult(action, requestedRoot, value, limit) {
    const result = readRecord(value, "Graph operation returned an invalid result.");
    const fields = graphPublicFields(action);
    const publicResult = {};
    for (const field of fields)
        if (has(result, field))
            publicResult[field] = result[field];
    publicResult.root = requestedRoot;
    for (const field of ["head", "previousHead", "indexedHead", "currentHead", "base"]) {
        const value = publicResult[field];
        if (typeof value === "string")
            publicResult[field] = value.trim();
    }
    if (has(result, "diagnostics") && Array.isArray(publicResult.diagnostics)) {
        publicResult.diagnostics = publicResult.diagnostics.slice(0, limit ?? 100);
    }
    if (limit !== undefined && action !== "build" && action !== "status")
        publicResult.limit = limit;
    return publicResult;
}
function graphPublicFields(action) {
    switch (action) {
        case "build":
            return ["schemaVersion", "action", "root", "fresh", "buildMode", "fullRebuild", "head", "previousHead", "dirtyFingerprint", "changedPaths", "truncated", "scannedFileCount", "removedFileCount", "fileCount", "nodeCount", "edgeCount", "diagnosticCount", "generatedAt"];
        case "status":
            return ["schemaVersion", "action", "root", "available", "fresh", "reason", "indexedHead", "currentHead", "counts", "generatedAt"];
        case "query":
            return ["schemaVersion", "action", "root", "nodes", "edges", "truncated", "diagnostics", "query"];
        case "context":
            return ["schemaVersion", "action", "root", "nodes", "edges", "truncated", "diagnostics", "target"];
        case "impact":
            return ["schemaVersion", "action", "root", "nodes", "edges", "truncated", "diagnostics", "target", "direction", "depth", "paths"];
        case "changes":
            return ["schemaVersion", "action", "root", "nodes", "edges", "truncated", "diagnostics", "changedPaths", "changeState", "head", "base"];
        case "map":
            return ["schemaVersion", "action", "root", "modules", "hubs", "cycles", "flows", "truncated", "diagnostics"];
        case "path":
            return ["schemaVersion", "action", "root", "from", "to", "found", "nodes", "edges", "totalWeight", "truncated"];
        case "explain":
            return ["schemaVersion", "action", "root", "target", "node", "neighborhood", "community", "communityStale", "citingPages", "diagnostics"];
        case "communities":
            return ["schemaVersion", "action", "root", "communities", "stale", "generation", "generatedAt", "truncated"];
        case "report":
            return ["schemaVersion", "action", "root", "page", "written", "communityCount", "godNodeCount", "surprisingConnectionCount", "ambiguousEdgeCount", "coverageRatio", "generation", "generatedAt"];
    }
}
async function loadGraph() {
    const moduleValue = await import(new URL("./graph.js", import.meta.url).href);
    const module = readRecord(moduleValue, "Native graph module is invalid.");
    return {
        buildGraph: readAsyncFunction(module, "buildGraph"),
        getGraphStatus: readAsyncFunction(module, "getGraphStatus"),
        queryGraph: readAsyncFunction(module, "queryGraph"),
        getGraphContext: readAsyncFunction(module, "getGraphContext"),
        analyzeGraphImpact: readAsyncFunction(module, "analyzeGraphImpact"),
        analyzeGraphChanges: readAsyncFunction(module, "analyzeGraphChanges"),
        getArchitectureMap: readAsyncFunction(module, "getArchitectureMap"),
        getGraphPath: readAsyncFunction(module, "getGraphPath"),
        explainGraphNode: readAsyncFunction(module, "explainGraphNode"),
        listGraphCommunities: readAsyncFunction(module, "listGraphCommunities"),
        renderGraphReport: readAsyncFunction(module, "renderGraphReport"),
    };
}
async function loadEnrich() {
    const moduleValue = await import(new URL("./enrich.js", import.meta.url).href);
    const module = readRecord(moduleValue, "Native enrich module is invalid.");
    return { enrichGraph: readAsyncFunction(module, "enrichGraph") };
}
function readAsyncFunction(record, key) {
    const value = record[key];
    if (typeof value !== "function")
        throw new OpenWikiError("IO_FAILURE", "Native graph module is unavailable.");
    return async (options) => {
        const result = Reflect.apply(value, undefined, [options]);
        return await Promise.resolve(result);
    };
}
function readLocation(input, allowed) {
    assertKeys(input, allowed);
    const mode = readEnum(input, "mode", MODES);
    const root = readOptionalString(input, "root");
    if (mode === "code" && root === undefined)
        throw invalid("Code mode requires root.");
    if (mode === "personal" && root !== undefined)
        throw invalid("Personal mode forbids root.");
    return { mode, ...(root === undefined ? {} : { root }), homeDir: hostHomeDir() };
}
function hostHomeDir() {
    return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}
function readRecord(value, message) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw invalid(message);
    return Object.fromEntries(Object.entries(value));
}
function assertKeys(input, allowed) {
    for (const key of Object.keys(input))
        if (!allowed.includes(key))
            throw invalid(`Unknown argument: ${key}.`);
}
function assertAbsent(input, keys) {
    for (const key of keys)
        if (has(input, key))
            throw invalid(`Argument ${key} is incompatible with this operation.`);
}
function requireValue(input, key) {
    if (!has(input, key))
        throw invalid(`Missing required argument: ${key}.`);
    return input[key];
}
function readRequiredString(input, key) {
    const value = requireValue(input, key);
    if (typeof value !== "string" || value.length === 0)
        throw invalid(`Argument ${key} must be a non-empty string.`);
    return value;
}
function readOptionalString(input, key) {
    if (!has(input, key))
        return undefined;
    return readRequiredString(input, key);
}
function readOptionalBoundedInteger(input, key, minimum, maximum) {
    if (!has(input, key))
        return undefined;
    const value = input[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
        throw invalid(`Argument ${key} must be an integer between ${String(minimum)} and ${String(maximum)}.`);
    return value;
}
function readBoolean(input, key) {
    const value = requireValue(input, key);
    if (typeof value !== "boolean")
        throw invalid(`Argument ${key} must be boolean.`);
    return value;
}
function readEnum(input, key, allowed) {
    const value = readRequiredString(input, key);
    const match = allowed.find((candidate) => candidate === value);
    if (match === undefined)
        throw invalid(`Argument ${key} is invalid.`);
    return match;
}
function has(input, key) {
    return Object.prototype.hasOwnProperty.call(input, key);
}
function invalid(message) {
    return new OpenWikiError("INVALID_ARGUMENT", message);
}
export async function readCliTransport(filePath) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch {
        throw new OpenWikiError("NOT_FOUND", "Input file could not be read.");
    }
}
