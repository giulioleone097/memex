import { readFile } from "node:fs/promises";
import path from "node:path";

import { defaultVendorRoot, verifyAllVendorAssets } from "./embedder.js";
import { UNSCOPED_PROJECT_SCOPE } from "./evidence-identity.js";
import { getGraphStatus } from "./graph.js";
import { openGraphIndex, probeGraphStorage, readManifest as readGraphManifest } from "./graph-store.js";
import { openLexicalIndex } from "./lexical-index.js";
import { hostHomeDir, type WikiLocation } from "./paths.js";
import { tryReadState } from "./state.js";
import { openVectorStore } from "./vector-store.js";
import { checkWiki } from "./wiki.js";

/** Stable discriminator for the additive retrieval-health read model. */
export const RETRIEVAL_HEALTH_SCHEMA = "memex.retrieval-health.v1" as const;

export type RetrievalSignal = "lexical" | "vector" | "graph";
export type RetrievalProofStatus = "proven" | "failed" | "unknown";

export interface RetrievalHealthFailure {
  code: string;
  message: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface RetrievalProofLayer {
  status: RetrievalProofStatus;
  checkedAt: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  failures: RetrievalHealthFailure[];
}

export interface RetrievalCoverageSignal {
  expected: number;
  indexed: number;
  ratio: number;
  ready: boolean;
}

export interface RetrievalHealth {
  schema: typeof RETRIEVAL_HEALTH_SCHEMA;
  ready: boolean;
  reasons: string[];
  proofLayers: {
    source: RetrievalProofLayer;
    installedCache: RetrievalProofLayer;
    registry: RetrievalProofLayer;
    hostMount: RetrievalProofLayer;
    liveCall: RetrievalProofLayer;
  };
  identity: {
    repositoryIdentity: string | null;
    hostLocalStorageKey: string;
    wikiHash: string | null;
    matches: boolean;
  };
  freshness: {
    status: "current" | "stale" | "unknown";
    indexedAt?: string;
    reason?: string;
  };
  coverage: {
    expected: number;
    indexed: number;
    lexical: RetrievalCoverageSignal;
    vector: RetrievalCoverageSignal;
  };
  graphGeneration: string | null;
  modelRevision: string | null;
  modelId: string | null;
  counts: {
    lexical: number;
    vector: number;
    graph: { files: number; nodes: number; edges: number; diagnostics: number };
  };
  benchmarkFailures: {
    /** Normalized codes compatible with the benchmark gate report. */
    byCategory: Record<string, string[]>;
    bySignal: Record<RetrievalSignal, string[]>;
    /** Full inspectable evidence for each normalized failure code. */
    details: {
      byCategory: Record<string, RetrievalHealthFailure[]>;
      bySignal: Record<RetrievalSignal, RetrievalHealthFailure[]>;
    };
  };
  lastError: RetrievalHealthFailure | null;
  recovery: {
    required: boolean;
    action: string;
    commands: string[];
  };
  lastUpdate: {
    noOp: boolean | null;
    graphGenerated: boolean | null;
    reembedded: boolean | null;
  };
}

export interface RetrievalHealthOptions {
  /** Primarily useful to deterministic unit tests and host integrations. */
  now?: string;
  /** The caller can pass operation evidence when it already has it. */
  lastUpdate?: Partial<RetrievalHealth["lastUpdate"]>;
  /** Stable, portable repository/project scope resolved by the adapter. */
  projectScope?: string | null;
  /** Injectable only for deterministic registry regression tests. */
  vendorRoot?: string;
}

interface ManifestRecord {
  chunks: unknown;
  modelId: unknown;
  modelRevision: unknown;
  embeddingsAvailable: unknown;
  unavailableReason: unknown;
  totalDocs: unknown;
  dims: unknown;
  documentFrequency: unknown;
}

type FailureCategory = "source" | "installedCache" | "registry" | "hostMount" | "liveCall";
type FailuresByCategory = { [Category in FailureCategory]: RetrievalHealthFailure[] };
type FailuresBySignal = { [Signal in RetrievalSignal]: RetrievalHealthFailure[] };
type FailureRecorder = (
  category: FailureCategory,
  code: string,
  message: string,
  input: Record<string, unknown>,
  output?: Record<string, unknown>,
  signal?: RetrievalSignal,
) => RetrievalHealthFailure;

/**
 * Read retrieval health from the canonical source, private cache, vendor
 * registry, mounted host and live local ports. Every failed probe is retained
 * as structured input/output evidence; no layer is inferred from another.
 */
export async function readRetrievalHealth(
  location: WikiLocation,
  options: RetrievalHealthOptions = {},
): Promise<RetrievalHealth> {
  const now = options.now ?? new Date().toISOString();
  const failuresByCategory: FailuresByCategory = {
    source: [],
    installedCache: [],
    registry: [],
    hostMount: [],
    liveCall: [],
  };
  const failuresBySignal: FailuresBySignal = {
    lexical: [],
    vector: [],
    graph: [],
  };
  const failure: FailureRecorder = (
    category,
    code: string,
    message: string,
    input: Record<string, unknown>,
    output: Record<string, unknown> = {},
    signal?: RetrievalSignal,
  ): RetrievalHealthFailure => {
    const value = { code, message, input, output };
    failuresByCategory[category].push(value);
    if (signal !== undefined) failuresBySignal[signal].push(value);
    return value;
  };

  let state = null;
  let stateError: RetrievalHealthFailure | undefined;
  try {
    state = await tryReadState(location);
  } catch (error) {
    stateError = failure("source", "STATE_READ_FAILED", "Wiki state could not be read.", { statePath: location.statePath }, { error: safeError(error) });
  }

  const repositoryIdentity = options.projectScope ?? (location.mode === "personal" ? "memex:personal" : null);
  const sourceInput = {
    mode: location.mode,
    repositoryIdentity,
    hostLocalStorageKey: location.workspaceId,
    wikiRoot: location.wikiRoot,
    statePath: location.statePath,
  };
  const wikiHash = state?.contentHash ?? null;
  const sourceFailures = failuresByCategory.source;
  if (repositoryIdentity === null) failure("source", "REPOSITORY_IDENTITY_UNAVAILABLE", "Stable repository identity could not be established.", sourceInput);
  else if (repositoryIdentity === UNSCOPED_PROJECT_SCOPE) failure("source", "REPOSITORY_IDENTITY_UNSCOPED", "Repository has no portable origin identity.", sourceInput);
  if (state === null && stateError === undefined) failure("source", "STATE_MISSING", "Wiki state is not initialized.", sourceInput);

  let lexicalCount = 0;
  let vectorCount = 0;
  let vectorModelId: string | undefined;
  let vectorModelRevision: string | undefined;
  let vectorAvailable = true;
  let vectorUnavailableReason: string | undefined;
  let lexicalManifest: ManifestRecord | undefined;
  let vectorManifest: ManifestRecord | undefined;
  let lexicalValidated = false;
  let vectorValidated = false;
  const lexicalManifestPath = path.join(location.dataRoot, "lexical", "manifest.json");
  const vectorManifestPath = path.join(location.dataRoot, "vectors", "manifest.json");
  try {
    lexicalManifest = await readManifestRecord(lexicalManifestPath);
    lexicalCount = countChunks(lexicalManifest);
    const lexicalIndex = await openLexicalIndex(path.dirname(lexicalManifestPath));
    const probeTerm = firstManifestTerm(lexicalManifest);
    if (lexicalCount > 0 && probeTerm === undefined) throw new Error("Lexical index has chunks but no searchable terms.");
    if (probeTerm !== undefined && (await lexicalIndex.search(probeTerm, 1)).length === 0) throw new Error("Lexical index returned no result for an indexed term.");
    lexicalValidated = true;
  } catch (error) {
    failure("installedCache", "LEXICAL_CACHE_READ_FAILED", "Lexical index manifest could not be read.", { path: lexicalManifestPath, signal: "lexical" }, { error: safeError(error) }, "lexical");
  }
  try {
    vectorManifest = await readManifestRecord(vectorManifestPath);
    vectorCount = countChunks(vectorManifest);
    vectorModelId = stringValue(vectorManifest.modelId);
    vectorModelRevision = stringValue(vectorManifest.modelRevision);
    const vectorDims = positiveInteger(vectorManifest.dims);
    if (vectorModelId === undefined || vectorModelRevision === undefined || vectorDims === undefined) throw new Error("Vector index model metadata is invalid.");
    const vectorStore = await openVectorStore(path.dirname(vectorManifestPath), { modelId: vectorModelId, modelRevision: vectorModelRevision, dims: vectorDims });
    const vectorStatus = await vectorStore.status();
    if (!vectorStatus.compatible || vectorStatus.chunks !== vectorCount) throw new Error("Vector index status does not match its manifest.");
    if (vectorCount > 0 && (await vectorStore.search(new Float32Array(vectorDims), 1)).length === 0) throw new Error("Vector index has chunks but no readable vectors.");
    vectorAvailable = vectorManifest.embeddingsAvailable !== false;
    vectorUnavailableReason = stringValue(vectorManifest.unavailableReason);
    if (!vectorAvailable) failure("installedCache", "VECTOR_EMBEDDINGS_UNAVAILABLE", vectorUnavailableReason ?? "Vector embeddings are unavailable.", { path: vectorManifestPath, signal: "vector" }, { embeddingsAvailable: false }, "vector");
    vectorValidated = vectorAvailable;
  } catch (error) {
    failure("installedCache", "VECTOR_CACHE_READ_FAILED", "Vector index manifest could not be read.", { path: vectorManifestPath, signal: "vector" }, { error: safeError(error) }, "vector");
  }

  let graphGeneration: string | undefined;
  let graphCounts = { files: 0, nodes: 0, edges: 0, diagnostics: 0 };
  let graphGeneratedAt: string | undefined;
  let graphAvailable = false;
  if (location.mode === "code" && location.workspaceRoot !== undefined) {
    try {
      const probed = await probeGraphStorage(location.workspaceRoot, hostHomeDir());
      if (!probed.initialized) throw new Error("Graph index is not initialized.");
      const manifest = await readGraphManifest(probed.storage);
      await openGraphIndex(probed.storage);
      graphGeneration = manifest.generation;
      graphGeneratedAt = manifest.generatedAt;
      graphCounts = manifest.counts;
      graphAvailable = true;
    } catch (error) {
      failure("installedCache", "GRAPH_CACHE_READ_FAILED", "Graph index manifest could not be read.", { root: location.workspaceRoot, signal: "graph" }, { error: safeError(error) }, "graph");
    }
  }

  const vendorRoot = options.vendorRoot ?? defaultVendorRoot();
  let registryModelId: string | undefined;
  let registryModelRevision: string | undefined;
  try {
    const manifest = await verifyAllVendorAssets(vendorRoot);
    const model = manifest.assets.find((asset) => asset.path.startsWith("model/"));
    if (model !== undefined) {
      registryModelRevision = model.revision;
      registryModelId = model.path.split("/")[1];
    } else {
      failure("registry", "MODEL_REGISTRY_ENTRY_MISSING", "Vendor registry has no model asset entry.", { vendorRoot });
    }
  } catch (error) {
    failure("registry", "MODEL_REGISTRY_READ_FAILED", "Installed model registry or asset verification failed.", { vendorRoot }, { error: safeError(error) });
  }
  const modelRevision = registryModelRevision ?? vectorModelRevision;
  const modelId = registryModelId ?? vectorModelId;
  if (vectorModelId !== undefined && registryModelId !== undefined && vectorModelId !== registryModelId) {
    failure("registry", "MODEL_ID_MISMATCH", "Vector index model does not match the installed registry.", { vectorModelId, registryModelId }, { vectorPath: vectorManifestPath }, "vector");
  }
  if (vectorModelRevision !== undefined && registryModelRevision !== undefined && vectorModelRevision !== registryModelRevision) {
    failure("registry", "MODEL_REVISION_MISMATCH", "Vector index model revision does not match the installed registry.", { vectorRevision: vectorModelRevision, registryRevision: registryModelRevision }, { vectorPath: vectorManifestPath });
  }

  const hostInput = { node: process.version, homeDir: hostHomeDir(), dataRoot: location.dataRoot };
  const hostFailures = failuresByCategory.hostMount;
  try {
    await readFile(location.statePath, "utf8");
  } catch (error) {
    if (state === null) failure("hostMount", "STATE_MOUNT_UNAVAILABLE", "Resolved host state path is not readable.", hostInput, { error: safeError(error) });
  }
  const hostLayer = layer(now, hostInput, { node: process.version, dataRoot: location.dataRoot }, hostFailures);

  const liveFailures = failuresByCategory.liveCall;
  if (!lexicalValidated || lexicalCount === 0) failure("liveCall", "LEXICAL_LIVE_UNAVAILABLE", "Lexical retrieval has no validated indexed chunks.", { signal: "lexical", indexed: lexicalCount }, { validated: lexicalValidated }, "lexical");
  if (!vectorValidated || vectorCount === 0) failure("liveCall", "VECTOR_LIVE_UNAVAILABLE", "Vector retrieval is not ready.", { signal: "vector", indexed: vectorCount }, { validated: vectorValidated, embeddingsAvailable: vectorAvailable, unavailableReason: vectorUnavailableReason }, "vector");
  if (location.mode === "code" && !graphAvailable) failure("liveCall", "GRAPH_LIVE_UNAVAILABLE", "Graph retrieval has no recoverable generation.", { signal: "graph" }, {}, "graph");
  const liveLayer = layer(now, { dataRoot: location.dataRoot }, { lexical: lexicalCount, vector: vectorCount, graph: graphAvailable }, liveFailures);

  const expected = Math.max(lexicalCount, vectorCount);
  const indexed = Math.min(lexicalCount, vectorCount);
  const lexical = coverage(lexicalCount, expected, failuresBySignal.lexical.length === 0 && lexicalValidated);
  const vector = coverage(vectorCount, expected, failuresBySignal.vector.length === 0 && vectorValidated);
  const fresh = await readFreshness(location, state !== null, graphGeneratedAt, graphAvailable, failure);
  const identityMatches = repositoryIdentity !== null && repositoryIdentity !== UNSCOPED_PROJECT_SCOPE && state !== null && fresh.status === "current";
  const identity = { repositoryIdentity, hostLocalStorageKey: location.workspaceId, wikiHash, matches: identityMatches };
  const sourceLayer = layer(now, sourceInput, {
    mode: location.mode,
    repositoryIdentity,
    hostLocalStorageKey: location.workspaceId,
    wikiHash,
  }, sourceFailures);
  const requiredFailures = [...sourceFailures, ...failuresByCategory.installedCache, ...failuresByCategory.registry, ...failuresByCategory.hostMount, ...liveFailures];
  const reasons: string[] = [];
  if (expected === 0) reasons.push("No expected retrieval chunks are present.");
  if (indexed === 0) reasons.push("No retrieval chunks are indexed across lexical and vector stores.");
  if (!identity.matches) reasons.push("Source identity does not match the resolved workspace.");
  if (fresh.status !== "current") reasons.push(fresh.reason ?? "Retrieval freshness is not current.");
  if (requiredFailures.length > 0) reasons.push("One or more required retrieval proofs failed.");
  const lastError = [...requiredFailures].at(-1);
  const noOp = options.lastUpdate?.noOp ?? (state?.lastRun.changed === false ? true : null);
  const lastUpdate = {
    noOp,
    graphGenerated: options.lastUpdate?.graphGenerated ?? (state?.lastRun.changed === false ? false : null),
    reembedded: options.lastUpdate?.reembedded ?? (state?.lastRun.changed === false ? false : null),
  };
  const recovery = recoveryPlan(reasons, location, vectorAvailable);
  return {
    schema: RETRIEVAL_HEALTH_SCHEMA,
    ready: reasons.length === 0,
    reasons,
    proofLayers: {
      source: sourceLayer,
      installedCache: layer(now, { lexicalManifestPath, vectorManifestPath }, { lexical: lexicalCount, vector: vectorCount, graph: graphGeneration }, failuresByCategory.installedCache),
      registry: layer(now, { vendorRoot }, { modelId: registryModelId, modelRevision: registryModelRevision }, failuresByCategory.registry),
      hostMount: hostLayer,
      liveCall: liveLayer,
    },
    identity,
    freshness: fresh,
    coverage: { expected, indexed, lexical, vector },
    graphGeneration: graphGeneration ?? null,
    modelRevision: modelRevision ?? null,
    modelId: modelId ?? null,
    counts: { lexical: lexicalCount, vector: vectorCount, graph: graphCounts },
    benchmarkFailures: {
      byCategory: failureCodes(failuresByCategory),
      bySignal: failureCodes(failuresBySignal),
      details: { byCategory: failuresByCategory, bySignal: failuresBySignal },
    },
    lastError: lastError ?? null,
    recovery,
    lastUpdate,
  };
}

/** Alias retained for callers that prefer a `get*` naming convention. */
export const getRetrievalHealth = readRetrievalHealth;

function layer(now: string, input: Record<string, unknown>, output: Record<string, unknown>, failures: RetrievalHealthFailure[]): RetrievalProofLayer {
  return { status: failures.length === 0 ? "proven" : "failed", checkedAt: now, input, output, failures: [...failures] };
}

function coverage(indexed: number, expected: number, noFailures: boolean): RetrievalCoverageSignal {
  const ratio = expected === 0 ? 0 : indexed / expected;
  return { expected, indexed, ratio, ready: expected > 0 && indexed > 0 && indexed >= expected && noFailures };
}

async function readFreshness(
  location: WikiLocation,
  stateAvailable: boolean,
  indexedAt: string | undefined,
  graphAvailable: boolean,
  fail: FailureRecorder,
): Promise<RetrievalHealth["freshness"]> {
  if (!stateAvailable) return { status: "unknown", ...(indexedAt === undefined ? {} : { indexedAt }), reason: "Wiki state is unavailable, so source freshness cannot be established." };
  try {
    const wiki = await checkWiki(location, { phase: "strict" });
    if (!wiki.ok) {
      const issueCodes = wiki.issues.map((issue) => issue.code);
      fail("source", "WIKI_SOURCE_STALE", "Wiki content or source integrity does not match finalized state.", { statePath: location.statePath }, { phase: wiki.phase, issueCodes });
      return { status: "stale", ...(indexedAt === undefined ? {} : { indexedAt }), reason: "Wiki content or source integrity does not match finalized state." };
    }
    if (location.mode === "code" && !graphAvailable) return { status: "unknown", ...(indexedAt === undefined ? {} : { indexedAt }), reason: "No validated graph generation is available to establish repository freshness." };
    if (location.mode === "code" && location.workspaceRoot !== undefined) {
      const status = await getGraphStatus({ root: location.workspaceRoot, homeDir: hostHomeDir() });
      if (!status.available) return { status: "unknown", ...(indexedAt === undefined ? {} : { indexedAt }), reason: status.reason ?? "Graph status is unavailable." };
      if (!status.fresh) {
        fail("source", "STALE_RETRIEVAL", "Repository content changed since the last graph build.", { root: location.workspaceRoot }, { indexedHead: status.indexedHead, currentHead: status.currentHead });
        return { status: "stale", ...(indexedAt === undefined ? {} : { indexedAt }), reason: status.reason ?? "Repository content changed since the last graph build." };
      }
    }
    return { status: "current", ...(indexedAt === undefined ? {} : { indexedAt }) };
  } catch (error) {
    fail("source", "FRESHNESS_READ_FAILED", "Retrieval freshness could not be established.", { root: location.workspaceRoot ?? location.wikiRoot }, { error: safeError(error) });
    return { status: "unknown", ...(indexedAt === undefined ? {} : { indexedAt }), reason: "Retrieval freshness could not be established." };
  }
}

function recoveryPlan(reasons: readonly string[], location: WikiLocation, vectorAvailable: boolean): RetrievalHealth["recovery"] {
  if (reasons.length === 0) return { required: false, action: "No recovery required.", commands: [] };
  const commands: string[] = [];
  if (location.mode === "code") commands.push(`memex graph --action build --root ${location.workspaceRoot ?? "<root>"}`);
  if (!vectorAvailable) commands.push("memex doctor");
  commands.push(`memex check --mode ${location.mode}${location.workspaceRoot === undefined ? "" : ` --root ${location.workspaceRoot}`}`);
  return { required: true, action: "Refresh the stale or missing retrieval proofs, then re-run retrieval_health.", commands };
}

async function readManifestRecord(filePath: string): Promise<ManifestRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manifest is not an object.");
  return {
    chunks: Reflect.get(parsed, "chunks"),
    modelId: Reflect.get(parsed, "modelId"),
    modelRevision: Reflect.get(parsed, "modelRevision"),
    embeddingsAvailable: Reflect.get(parsed, "embeddingsAvailable"),
    unavailableReason: Reflect.get(parsed, "unavailableReason"),
    totalDocs: Reflect.get(parsed, "totalDocs"),
    dims: Reflect.get(parsed, "dims"),
    documentFrequency: Reflect.get(parsed, "documentFrequency"),
  };
}

function countChunks(manifest: ManifestRecord): number {
  if (Array.isArray(manifest.chunks)) return manifest.chunks.length;
  return typeof manifest.totalDocs === "number" && Number.isSafeInteger(manifest.totalDocs) ? manifest.totalDocs : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function firstManifestTerm(manifest: ManifestRecord): string | undefined {
  if (manifest.documentFrequency === null || typeof manifest.documentFrequency !== "object" || Array.isArray(manifest.documentFrequency)) return undefined;
  return Object.keys(manifest.documentFrequency).sort().find((term) => term.trim().length > 0);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function failureCodes(failures: FailuresByCategory | FailuresBySignal): Record<string, string[]> {
  return Object.fromEntries(Object.entries(failures).map(([category, values]) => [category, [...new Set(values.map((value) => value.code))].sort()]));
}
