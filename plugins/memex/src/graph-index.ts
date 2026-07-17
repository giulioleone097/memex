import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  GRAPH_SCANNER_VERSION,
  isGraphConfidence,
  isGraphEdgeKind,
  isGraphNodeKind,
  type CodeGraphV1,
  type GraphDiagnosticV1,
  type GraphEdgeV1,
  type GraphNodeKind,
  type GraphNodeV1,
} from "./graph-contracts.js";
import { MemexError } from "./errors.js";

export const GRAPH_STORE_SCHEMA_VERSION = 2 as const;

export interface GraphIndexManifest {
  schemaVersion: typeof GRAPH_STORE_SCHEMA_VERSION;
  scannerVersion: string;
  generation: string;
  nodeBuckets: string[];
  edgeBuckets: string[];
  inboundBuckets: string[];
  outboundBuckets: string[];
  symbolBuckets: string[];
  pathBuckets: string[];
  architecture: "architecture.json";
}

export interface GraphIndexMetrics {
  bytesRead: number;
  filesRead: number;
}

export interface GraphIndexStatus {
  generation: string;
  recovered: boolean;
  schemaVersion: typeof GRAPH_STORE_SCHEMA_VERSION;
  scannerVersion: string;
}

export interface GraphAdjacency {
  edges: GraphEdgeV1[];
  total: number;
  truncated: boolean;
}

export interface GraphIndexPort {
  node(id: string): Promise<GraphNodeV1 | undefined>;
  edge(id: string): Promise<GraphEdgeV1 | undefined>;
  rankedCandidates(query: string, limit: number): Promise<string[]>;
  inbound(id: string, limit: number): Promise<GraphAdjacency>;
  outbound(id: string, limit: number): Promise<GraphAdjacency>;
  changedPathSeeds(paths: readonly string[], limit: number): Promise<string[]>;
  architectureSummary(): Promise<Readonly<GraphArchitectureSummary>>;
  allNodes(kind?: GraphNodeKind): Promise<GraphNodeV1[]>;
  allEdges(): Promise<GraphEdgeV1[]>;
  metrics(): GraphIndexMetrics;
  status(): GraphIndexStatus;
}

export interface GraphArchitectureSummary {
  modules: GraphNodeV1[];
  entrypoints: string[];
  hubs: Array<{ id: string; degree: number }>;
  flows: Array<{ from: string; to: string; kind: GraphEdgeV1["kind"] }>;
  cycles: string[][];
  diagnostics: GraphDiagnosticV1[];
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
}

type EdgeBucket = Record<string, GraphEdgeV1[]>;
type EdgeRecordBucket = Record<string, GraphEdgeV1>;
type NodeBucket = Record<string, GraphNodeV1>;
type CandidateBucket = Record<string, string[]>;
type PathBucket = Record<string, string[]>;

export async function writeGraphIndexGeneration(
  generationRoot: string,
  generation: string,
  graph: CodeGraphV1,
): Promise<GraphIndexManifest> {
  const writer = createImmutableGenerationWriter(generationRoot);
  const nodes = new Map<string, NodeBucket>();
  const edges = new Map<string, EdgeRecordBucket>();
  const inbound = new Map<string, EdgeBucket>();
  const outbound = new Map<string, EdgeBucket>();
  const symbols = new Map<string, CandidateBucket>();
  const paths = new Map<string, PathBucket>();

  for (const node of graph.nodes) {
    put(nodes, bucketFor(node.id), node.id, node);
    for (const token of tokens(`${node.name} ${node.path} ${node.scope ?? ""}.${node.name}`)) {
      const bucket = bucketFor(token);
      const candidates = getOrCreate(symbols, bucket, () => emptyRecord<string[]>());
      const ids = candidates[token] ?? [];
      ids.push(node.id);
      candidates[token] = ids;
    }
    const bucket = bucketFor(node.path);
    const indexed = getOrCreate(paths, bucket, () => emptyRecord<string[]>());
    const ids = indexed[node.path] ?? [];
    ids.push(node.id);
    indexed[node.path] = ids;
  }

  for (const edge of graph.edges) {
    put(edges, bucketFor(edge.id), edge.id, edge);
    append(inbound, bucketFor(edge.to), edge.to, edge);
    append(outbound, bucketFor(edge.from), edge.from, edge);
  }

  const manifest: GraphIndexManifest = {
    schemaVersion: GRAPH_STORE_SCHEMA_VERSION,
    scannerVersion: GRAPH_SCANNER_VERSION,
    generation,
    nodeBuckets: await writeBuckets(writer, "nodes", nodes),
    edgeBuckets: await writeBuckets(writer, "edges", edges),
    inboundBuckets: await writeBuckets(writer, "inbound", inbound),
    outboundBuckets: await writeBuckets(writer, "outbound", outbound),
    symbolBuckets: await writeBuckets(writer, "symbols", symbols),
    pathBuckets: await writeBuckets(writer, "paths", paths),
    architecture: "architecture.json",
  };
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  const architecture: GraphArchitectureSummary = {
    modules: graph.nodes.filter((node) => node.kind === "module"),
    entrypoints: graph.nodes.filter((node) => node.kind === "symbol" && /^(?:main|start|run|handler)$/iu.test(node.name)).map((node) => node.id).slice(0, 100),
    hubs: graph.nodes.map((node) => ({ id: node.id, degree: degrees.get(node.id) ?? 0 })).filter((node) => node.degree > 1).sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id)).slice(0, 100),
    flows: graph.edges.slice(0, 100).map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    cycles: findCycles(graph.edges, 100),
    diagnostics: graph.diagnostics,
    fileCount: graph.files.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
  await writer.write(manifest.architecture, serialize(architecture));
  await writer.write("index.json", serialize(manifest));
  await writer.syncDirectories();
  return manifest;
}

export async function openGraphIndexGeneration(
  generationRoot: string,
  expectedGeneration: string,
  recovered: boolean,
): Promise<GraphIndexPort> {
  const initial = await readJson(generationRoot, "index.json");
  const manifest = parseIndexManifest(initial.value);
  if (manifest.generation !== expectedGeneration) {
    throw new MemexError("INVALID_STATE", "Graph index generation does not match its manifest.");
  }
  let bytesRead = initial.bytes;
  let filesRead = 1;
  const cached = new Map<string, unknown>();
  const read = async (relative: string): Promise<unknown> => {
    const cachedValue = cached.get(relative);
    if (cachedValue !== undefined) return cachedValue;
    const raw = await readJson(generationRoot, relative);
    cached.set(relative, raw.value);
    bytesRead += raw.bytes;
    filesRead += 1;
    return raw.value;
  };
  const readBucket = async (directory: string, bucket: string, allowed: readonly string[]): Promise<unknown> => {
    if (!allowed.includes(bucket)) {
      return {};
    }
    return read(`${directory}/${bucket}.json`);
  };
  const readNode = async (id: string): Promise<GraphNodeV1 | undefined> => {
    return parseNodeBucket(await readBucket("nodes", bucketFor(id), manifest.nodeBuckets)).get(id);
  };

  return {
    async node(id) {
      return readNode(id);
    },
    async edge(id) {
      return parseEdgeRecordBucket(await readBucket("edges", bucketFor(id), manifest.edgeBuckets)).get(id);
    },
    async rankedCandidates(query, limit) {
      assertLimit(limit);
      const normalized = query.trim().toLowerCase();
      const queryTokens = tokens(query);
      if (normalized.length === 0 || queryTokens.length === 0) throw new MemexError("INVALID_ARGUMENT", "Graph query must not be empty.");
      const candidates = new Set<string>();
      for (const token of queryTokens) {
        const bucket = parseStringListBucket(await readBucket("symbols", bucketFor(token), manifest.symbolBuckets));
        for (const id of bucket.get(token) ?? []) candidates.add(id);
      }
      const ranked: Array<{ id: string; score: number }> = [];
      for (const id of [...candidates].sort((left, right) => left.localeCompare(right))) {
        const node = await readNode(id);
        if (node === undefined) continue;
        const name = node.name.toLowerCase();
        const nodePath = node.path.toLowerCase();
        const qualified = `${node.scope ?? ""}.${name}`.replace(/^\./u, "");
        if (!queryTokens.every((token) => name.includes(token) || nodePath.includes(token) || qualified.includes(token))) continue;
        const inbound = parseEdgeListBucket(await readBucket("inbound", bucketFor(id), manifest.inboundBuckets)).get(id) ?? [];
        const outbound = parseEdgeListBucket(await readBucket("outbound", bucketFor(id), manifest.outboundBuckets)).get(id) ?? [];
        let score = 0;
        if (name === normalized || nodePath === normalized) score += 1000;
        if (qualified === normalized) score += 900;
        if (qualified.startsWith(normalized)) score += 500;
        score += queryTokens.length * 100;
        ranked.push({ id, score: score + Math.min(inbound.length + outbound.length, 50) });
      }
      return ranked
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((candidate) => candidate.id);
    },
    async inbound(id, limit) {
      assertLimit(limit);
      const edges = parseEdgeListBucket(await readBucket("inbound", bucketFor(id), manifest.inboundBuckets)).get(id) ?? [];
      return { edges: edges.slice(0, limit), total: edges.length, truncated: edges.length > limit };
    },
    async outbound(id, limit) {
      assertLimit(limit);
      const edges = parseEdgeListBucket(await readBucket("outbound", bucketFor(id), manifest.outboundBuckets)).get(id) ?? [];
      return { edges: edges.slice(0, limit), total: edges.length, truncated: edges.length > limit };
    },
    async changedPathSeeds(changedPaths, limit) {
      assertLimit(limit);
      const ids = new Set<string>();
      for (const changedPath of changedPaths) {
        const bucket = parseStringListBucket(await readBucket("paths", bucketFor(changedPath), manifest.pathBuckets));
        for (const id of bucket.get(changedPath) ?? []) {
          ids.add(id);
          if (ids.size === limit) return [...ids];
        }
      }
      return [...ids];
    },
    async architectureSummary() {
      return parseArchitectureSummary(await read(manifest.architecture));
    },
    async allNodes(kind) {
      const nodes: GraphNodeV1[] = [];
      for (const bucket of manifest.nodeBuckets) {
        for (const node of parseNodeBucket(await read(`nodes/${bucket}.json`)).values()) if (kind === undefined || node.kind === kind) nodes.push(node);
      }
      return nodes.sort((left, right) => left.id.localeCompare(right.id));
    },
    async allEdges() {
      const edges: GraphEdgeV1[] = [];
      for (const bucket of manifest.edgeBuckets) {
        for (const edge of parseEdgeRecordBucket(await read(`edges/${bucket}.json`)).values()) edges.push(edge);
      }
      return edges.sort((left, right) => left.id.localeCompare(right.id));
    },
    metrics() {
      return { bytesRead, filesRead };
    },
    status() {
      return { generation: manifest.generation, recovered, schemaVersion: manifest.schemaVersion, scannerVersion: manifest.scannerVersion };
    },
  };
}

function put<T>(buckets: Map<string, Record<string, T>>, bucket: string, key: string, value: T): void {
  getOrCreate(buckets, bucket, () => emptyRecord<T>())[key] = value;
}

function append(buckets: Map<string, EdgeBucket>, bucket: string, key: string, edge: GraphEdgeV1): void {
  const values = getOrCreate(buckets, bucket, () => emptyRecord<GraphEdgeV1[]>());
  const list = values[key] ?? [];
  list.push(edge);
  values[key] = list;
}

function getOrCreate<T>(map: Map<string, T>, key: string, create: () => T): T {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = create();
  map.set(key, created);
  return created;
}

async function writeBuckets<T extends NodeBucket | EdgeRecordBucket | EdgeBucket | CandidateBucket | PathBucket>(
  writer: ImmutableGenerationWriter,
  directory: string,
  buckets: Map<string, T>,
): Promise<string[]> {
  const names = [...buckets.keys()].sort((left, right) => left.localeCompare(right));
  await writer.directory(directory);
  for (const name of names) {
    const values = buckets.get(name);
    if (values === undefined) throw new MemexError("INVALID_STATE", "Graph bucket disappeared during serialization.");
    await writer.write(`${directory}/${name}.json`, serialize(values));
  }
  return names;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(canonical(value))}\n`;
}

interface ImmutableGenerationWriter {
  directory(relative: string): Promise<void>;
  write(relative: string, content: string): Promise<void>;
  syncDirectories(): Promise<void>;
}

function createImmutableGenerationWriter(root: string): ImmutableGenerationWriter {
  const directories = new Set<string>([root]);
  return {
    async directory(relative) {
      const directory = path.join(root, relative);
      await ensureDirectory(directory);
      directories.add(directory);
    },
    async write(relative, content) {
      const file = confinedPath(root, relative);
      const directory = path.dirname(file);
      await ensureDirectory(directory);
      directories.add(directory);
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new MemexError("INVALID_STATE", "Immutable graph generation already contains this entry.");
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    async syncDirectories() {
      for (const directory of [...directories].sort((left, right) => left.localeCompare(right))) {
        let handle;
        try { handle = await open(directory, "r"); await handle.sync(); }
        catch (error) { if (!(error instanceof Error && "code" in error && (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EPERM"))) throw error; }
        finally { await handle?.close().catch(() => undefined); }
      }
    },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

async function readJson(root: string, relative: string): Promise<{ value: unknown; bytes: number }> {
  const file = confinedPath(root, relative);
  let details;
  try {
    details = await lstat(file);
  } catch {
    throw new MemexError("INVALID_STATE", "Graph index entry is missing.");
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new MemexError("SYMLINK_ESCAPE", "Graph index entry must be a regular file.");
  }
  try {
    const raw = await readFile(file);
    return { value: JSON.parse(raw.toString("utf8")) as unknown, bytes: raw.byteLength };
  } catch {
    throw new MemexError("INVALID_STATE", "Graph index entry is invalid JSON.");
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new MemexError("SYMLINK_ESCAPE", "Graph bucket directory must be a regular directory.");
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

function findCycles(edges: readonly GraphEdgeV1[], limit: number): string[][] {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active: string[] = [];
  const activeSet = new Set<string>();
  const visit = (id: string): void => {
    if (cycles.length === limit || visited.has(id)) return;
    visited.add(id);
    active.push(id);
    activeSet.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (cycles.length === limit) return;
      const cycleStart = active.indexOf(target);
      if (cycleStart >= 0 && activeSet.has(target)) cycles.push([...active.slice(cycleStart), target]);
      else visit(target);
    }
    active.pop();
    activeSet.delete(id);
  };
  for (const id of [...outgoing.keys()].sort((left, right) => left.localeCompare(right))) visit(id);
  return cycles;
}

function parseIndexManifest(value: unknown): GraphIndexManifest {
  if (!isRecord(value) || value.schemaVersion !== GRAPH_STORE_SCHEMA_VERSION || value.scannerVersion !== GRAPH_SCANNER_VERSION || !safeGeneration(value.generation) || value.architecture !== "architecture.json") {
    throw new MemexError("INVALID_STATE", "Graph index schema is incompatible.");
  }
  return {
    schemaVersion: GRAPH_STORE_SCHEMA_VERSION,
    scannerVersion: GRAPH_SCANNER_VERSION,
    generation: value.generation,
    nodeBuckets: parseBuckets(value.nodeBuckets),
    edgeBuckets: parseBuckets(value.edgeBuckets),
    inboundBuckets: parseBuckets(value.inboundBuckets),
    outboundBuckets: parseBuckets(value.outboundBuckets),
    symbolBuckets: parseBuckets(value.symbolBuckets),
    pathBuckets: parseBuckets(value.pathBuckets),
    architecture: "architecture.json",
  };
}

function parseNodeBucket(value: unknown): Map<string, GraphNodeV1> {
  return parseRecord(value, parseNode);
}

function parseEdgeRecordBucket(value: unknown): Map<string, GraphEdgeV1> {
  return parseRecord(value, parseEdge);
}

function parseEdgeListBucket(value: unknown): Map<string, GraphEdgeV1[]> {
  return parseRecord(value, (entry) => {
    if (!Array.isArray(entry)) throw new MemexError("INVALID_STATE", "Graph edge bucket is invalid.");
    return entry.map(parseEdge);
  });
}

function parseStringListBucket(value: unknown): Map<string, string[]> {
  return parseRecord(value, (entry) => {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) throw new MemexError("INVALID_STATE", "Graph index bucket is invalid.");
    return entry;
  });
}

function parseRecord<T>(value: unknown, parse: (entry: unknown) => T): Map<string, T> {
  if (!isRecord(value)) throw new MemexError("INVALID_STATE", "Graph index bucket is invalid.");
  return new Map(Object.entries(value).map(([key, entry]) => [key, parse(entry)]));
}

function parseNode(value: unknown): GraphNodeV1 {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string" || typeof value.name !== "string" || !isGraphNodeKind(value.kind)) throw new MemexError("INVALID_STATE", "Graph node bucket is invalid.");
  const node: GraphNodeV1 = { id: value.id, kind: value.kind, path: value.path, name: value.name };
  if (value.symbolKind !== undefined) {
    if (typeof value.symbolKind !== "string") throw new MemexError("INVALID_STATE", "Graph node bucket is invalid.");
    node.symbolKind = value.symbolKind;
  }
  if (value.scope !== undefined) {
    if (typeof value.scope !== "string") throw new MemexError("INVALID_STATE", "Graph node bucket is invalid.");
    node.scope = value.scope;
  }
  if (value.startLine !== undefined) {
    if (!positiveInteger(value.startLine)) throw new MemexError("INVALID_STATE", "Graph node bucket is invalid.");
    node.startLine = value.startLine;
  }
  if (value.endLine !== undefined) {
    if (!positiveInteger(value.endLine)) throw new MemexError("INVALID_STATE", "Graph node bucket is invalid.");
    node.endLine = value.endLine;
  }
  if (value.summary !== undefined) {
    if (typeof value.summary !== "string") throw new MemexError("INVALID_STATE", "Graph node bucket is invalid.");
    node.summary = value.summary;
  }
  return node;
}

function parseEdge(value: unknown): GraphEdgeV1 {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.from !== "string" || typeof value.to !== "string" || !isGraphEdgeKind(value.kind) || !isGraphConfidence(value.confidence)) throw new MemexError("INVALID_STATE", "Graph edge bucket is invalid.");
  return { id: value.id, kind: value.kind, from: value.from, to: value.to, confidence: value.confidence };
}

function parseArchitectureSummary(value: unknown): GraphArchitectureSummary {
  if (!isRecord(value) || !Array.isArray(value.modules) || !Array.isArray(value.entrypoints) || !Array.isArray(value.hubs) || !Array.isArray(value.flows) || !Array.isArray(value.cycles) || !Array.isArray(value.diagnostics) || !nonNegativeInteger(value.fileCount) || !nonNegativeInteger(value.nodeCount) || !nonNegativeInteger(value.edgeCount)) throw new MemexError("INVALID_STATE", "Graph architecture index is invalid.");
  const modules = value.modules.map(parseNode);
  const entrypoints = value.entrypoints;
  if (!entrypoints.every((entry) => typeof entry === "string")) throw new MemexError("INVALID_STATE", "Graph architecture index is invalid.");
  const hubs = value.hubs.map(parseHub);
  const flows = value.flows.map(parseFlow);
  const cycles = value.cycles.map((cycle) => {
    if (!Array.isArray(cycle) || !cycle.every((id) => typeof id === "string")) throw new MemexError("INVALID_STATE", "Graph architecture index is invalid.");
    return cycle;
  });
  const diagnostics = value.diagnostics.map(parseDiagnostic);
  return { modules, entrypoints, hubs, flows, cycles, diagnostics, fileCount: value.fileCount, nodeCount: value.nodeCount, edgeCount: value.edgeCount };
}

function parseDiagnostic(value: unknown): GraphDiagnosticV1 {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.code !== "string" || typeof value.message !== "string") throw new MemexError("INVALID_STATE", "Graph architecture index is invalid.");
  return { path: value.path, code: value.code, message: value.message };
}

function parseHub(value: unknown): { id: string; degree: number } {
  if (!isRecord(value) || typeof value.id !== "string" || !nonNegativeInteger(value.degree)) throw new MemexError("INVALID_STATE", "Graph architecture index is invalid.");
  return { id: value.id, degree: value.degree };
}

function parseFlow(value: unknown): { from: string; to: string; kind: GraphEdgeV1["kind"] } {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string" || !isGraphEdgeKind(value.kind)) throw new MemexError("INVALID_STATE", "Graph architecture index is invalid.");
  return { from: value.from, to: value.to, kind: value.kind };
}

function parseBuckets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new MemexError("INVALID_STATE", "Graph index bucket manifest is invalid.");
  }
  const names: string[] = [];
  for (const entry of value) { if (typeof entry !== "string" || !/^[a-f0-9]$/u.test(entry)) throw new MemexError("INVALID_STATE", "Graph index bucket manifest is invalid."); names.push(entry); }
  const sorted = names.slice().sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length || JSON.stringify(value) !== JSON.stringify(sorted)) {
    throw new MemexError("INVALID_STATE", "Graph index bucket manifest is not canonical.");
  }
  return sorted;
}

function bucketFor(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 1);
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]+/gu) ?? [])].sort((left, right) => left.localeCompare(right));
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new MemexError("INVALID_ARGUMENT", "Graph index limit must be between 1 and 100.");
  }
}

function confinedPath(root: string, relative: string): string {
  if (!/^(?:[a-z]+\/)?(?:[a-f0-9]|architecture|index)\.json$/u.test(relative)) {
    throw new MemexError("INVALID_STATE", "Graph index path is invalid.");
  }
  const candidate = path.resolve(root, relative);
  if (path.relative(root, candidate).startsWith("..") || path.isAbsolute(path.relative(root, candidate))) {
    throw new MemexError("SYMLINK_ESCAPE", "Graph index path escapes its generation.");
  }
  return candidate;
}

function safeGeneration(value: unknown): value is string {
  return typeof value === "string" && /^g-[a-f0-9]{64}$/u.test(value);
}

// Object.create(null), not {}: the symbol/path token dictionaries built in
// writeGraphIndexGeneration are keyed by arbitrary real-world strings (words
// extracted from symbol names, scopes, and file paths) — not always hashes —
// and a plain {} inherits Object.prototype members ("constructor", "toString",
// "valueOf", ...). A real class constructor method literally tokenizes to
// "constructor", so `candidates["constructor"] ?? []` resolved to the
// inherited Object constructor function (truthy, not undefined) instead of
// the intended fallback array, crashing on `.push()`. A null-prototype object
// has no inherited members, so every lookup for a key not yet explicitly set
// is genuinely undefined, regardless of what that key's text is. Serializes
// identically to plain-object JSON (JSON.stringify/Object.entries only ever
// consider own enumerable properties), so the on-disk bucket file format is
// unchanged.
function emptyRecord<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Cypher capability (additive LadybugDB layer).
//
// The pure-TS GraphIndexPort above is the untouched backbone. LadybugDB, when
// available, adds an arbitrary-Cypher query surface synced from the same shards.
// A "tier" describes Cypher availability: native and wasm provide Cypher; pure
// means port-only (no Cypher) and degrades honestly.
// ---------------------------------------------------------------------------

/** A scalar Cypher parameter value. */
export type CypherScalar = string | number | boolean | null;

/**
 * A Cypher parameter: a scalar, a list of scalars, or a list of row objects
 * (used for bulk `UNWIND $rows` loads). Nested lists beyond this are not needed.
 */
export type CypherParam = CypherScalar | ReadonlyArray<CypherScalar> | ReadonlyArray<Record<string, CypherScalar>>;

/** The result of a read-only Cypher query. */
export interface CypherResult {
  columns: string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  truncated: boolean;
}

/** Capability implemented by LadybugDB-backed tiers only. */
export interface CypherCapable {
  /**
   * Runs a read-only Cypher query. `maxRows` bounds how many rows are read from
   * the engine (via a cursor, so an unbounded result set is never fully
   * materialized); the result's `truncated` flag reports whether more existed.
   */
  cypher(query: string, params?: Record<string, CypherParam>, maxRows?: number): Promise<CypherResult>;
}

export type GraphCypherTier = "native" | "wasm" | "pure";

export interface GraphCypherSelection {
  tier: GraphCypherTier;
  reason: string;
  /** Present iff the selected tier is native or wasm. */
  cypher?: CypherCapable;
  close(): Promise<void>;
}

/** A resolved Ladybug tier, produced by an injected `tryNative`/`tryWasm` factory. */
export interface CypherTierResolution {
  cypher: CypherCapable;
  close(): Promise<void>;
}

export interface OpenGraphCypherOptions {
  /** Defaults to `resolveBackendPreference()`. */
  preference?: GraphCypherTier | "auto";
  tryNative?: () => Promise<CypherTierResolution | null>;
  tryWasm?: () => Promise<CypherTierResolution | null>;
}

/** Reads MEMEX_GRAPH_BACKEND; returns "auto" for missing/invalid values. */
export function resolveBackendPreference(env: Record<string, string | undefined> = process.env): GraphCypherTier | "auto" {
  const raw = (env.MEMEX_GRAPH_BACKEND ?? "").trim().toLowerCase();
  return raw === "native" || raw === "wasm" || raw === "pure" ? raw : "auto";
}

const noopClose = async (): Promise<void> => {};

/**
 * Resolves the Cypher tier: native → wasm → pure (auto), or the requested tier
 * with a pure fallback. Never throws; a tier factory that returns null or throws
 * degrades to the next candidate, ending at the always-available pure tier.
 */
export async function openGraphCypher(opts: OpenGraphCypherOptions = {}): Promise<GraphCypherSelection> {
  const preference = opts.preference ?? resolveBackendPreference();
  const reasons: string[] = [];

  const attempt = async (tier: "native" | "wasm", fn?: () => Promise<CypherTierResolution | null>): Promise<GraphCypherSelection | null> => {
    if (!fn) {
      reasons.push(`${tier}: not wired`);
      return null;
    }
    try {
      const resolved = await fn();
      if (!resolved) {
        reasons.push(`${tier}: unavailable`);
        return null;
      }
      return { tier, reason: `${tier} Cypher backend active`, cypher: resolved.cypher, close: () => resolved.close() };
    } catch (error) {
      reasons.push(`${tier}: ${(error as Error).message}`);
      return null;
    }
  };

  const pureSelection = (): GraphCypherSelection => ({
    tier: "pure",
    reason: reasons.length > 0 ? `pure (no Cypher — ${reasons.join("; ")})` : "pure (no Cypher backend requested)",
    close: noopClose,
  });

  if (preference === "pure") return pureSelection();
  if (preference === "native") return (await attempt("native", opts.tryNative)) ?? pureSelection();
  if (preference === "wasm") return (await attempt("wasm", opts.tryWasm)) ?? pureSelection();
  return (await attempt("native", opts.tryNative)) ?? (await attempt("wasm", opts.tryWasm)) ?? pureSelection();
}
