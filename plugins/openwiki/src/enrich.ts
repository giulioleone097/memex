import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { parseEnrichEnvelope } from "./contracts.js";
import { OpenWikiError } from "./errors.js";
import {
  createGraphEdgeId,
  createGraphNodeId,
  mergeEnrichment,
  validEdgeConfidence,
  type EnrichmentShardV1,
  type GraphEdgeV1,
  type GraphNodeV1,
} from "./graph-contracts.js";
import { assembleGraph } from "./graph.js";
import type { GraphIndexPort } from "./graph-index.js";
import {
  openGraphIndex,
  readEnrichmentShard,
  readGraphShard,
  readManifest,
  resolveGraphStorage,
  withGraphWriteLock,
  writeGraphUnlocked,
} from "./graph-store.js";
import { redactSensitive } from "./redact.js";

export interface EnrichOptions { root: string; homeDir?: string; envelope: unknown; now?: string; }
export interface EnrichResult {
  action: "enrich";
  sourcePath: string;
  sourceContentHash: string;
  applied: boolean;
  nodesWritten: number;
  edgesWritten: number;
  nodeIds: Record<string, string>;
  generatedAt: string;
}

export async function enrichGraph(options: EnrichOptions): Promise<EnrichResult> {
  const parsed = parseEnrichEnvelope(options.envelope);
  const redacted = parseEnrichEnvelope(redactSensitive(parsed));
  const resolved = await resolveGraphStorage(options.root, options.homeDir);
  await assertContentHashMatches(resolved.repositoryRoot, redacted.sourcePath, redacted.sourceContentHash);

  const localNodeIds = new Map<string, string>();
  const publicNodeIds = new Map<string, string>();
  const resolvedNodes: GraphNodeV1[] = [];
  for (const node of redacted.nodes) {
    const id = createGraphNodeId(node.kind, node.path, node.name);
    const key = localKey(node.kind, node.path, node.name);
    localNodeIds.set(key, id);
    localNodeIds.set(id, id);
    publicNodeIds.set(key, id);
    resolvedNodes.push({ id, kind: node.kind, path: node.path, name: node.name, ...(node.summary === undefined ? {} : { summary: node.summary }) });
  }

  return withGraphWriteLock(resolved.storage, async () => {
    const manifest = await readManifest(resolved.storage);

    // Edge references are validated unconditionally, even when this call turns out to be a
    // no-op below: an unresolved reference is a hard INVALID_ARGUMENT at write time (Global
    // Constraints), never silently skipped just because the source content hash is unchanged.
    const index = await openGraphIndex(resolved.storage);
    const resolvedEdges: GraphEdgeV1[] = [];
    for (const edge of redacted.edges) {
      if (!validEdgeConfidence(edge.kind, edge.confidence)) throw new OpenWikiError("INVALID_ARGUMENT", "Enrich edge confidence is not valid for its edge kind.");
      const from = await resolveNodeRef(index, localNodeIds, edge.from);
      const to = await resolveNodeRef(index, localNodeIds, edge.to);
      resolvedEdges.push({ id: createGraphEdgeId(edge.kind, from, to, edge.confidence), kind: edge.kind, from, to, confidence: edge.confidence });
    }

    const existing = manifest.enrichmentShards.find((entry) => entry.sourcePath === redacted.sourcePath);
    if (existing?.sourceContentHash === redacted.sourceContentHash) {
      return { action: "enrich" as const, sourcePath: redacted.sourcePath, sourceContentHash: redacted.sourceContentHash, applied: false, nodesWritten: 0, edgesWritten: 0, nodeIds: Object.fromEntries(publicNodeIds), generatedAt: manifest.generatedAt };
    }

    const now = options.now ?? new Date().toISOString();
    const sourceNodeId = createGraphNodeId("source", redacted.sourcePath, redacted.sourceContentHash);
    const sourceNode: GraphNodeV1 = { id: sourceNodeId, kind: "source", path: redacted.sourcePath, name: redacted.sourceContentHash };
    const groundsEdges: GraphEdgeV1[] = resolvedNodes.map((node) => ({ id: createGraphEdgeId("grounds", sourceNodeId, node.id, "extracted"), kind: "grounds", from: sourceNodeId, to: node.id, confidence: "extracted" }));

    const shard: EnrichmentShardV1 = {
      sourcePath: redacted.sourcePath,
      sourceContentHash: redacted.sourceContentHash,
      nodes: [sourceNode, ...resolvedNodes],
      edges: [...groundsEdges, ...resolvedEdges],
      enrichedAt: now,
    };

    const codeShards = await Promise.all(manifest.shards.map((entry) => readGraphShard(resolved.storage, entry.shard)));
    const codeGraph = assembleGraph(resolved.workspaceId, now, manifest.source, codeShards);
    const otherEnrichmentShards = await Promise.all(
      manifest.enrichmentShards.filter((entry) => entry.sourcePath !== redacted.sourcePath).map((entry) => readEnrichmentShard(resolved.storage, entry.shard)),
    );
    const enrichmentShards = [...otherEnrichmentShards, shard];
    const merged = mergeEnrichment(codeGraph, enrichmentShards);

    await writeGraphUnlocked(resolved.storage, merged, codeShards, enrichmentShards);

    return { action: "enrich" as const, sourcePath: redacted.sourcePath, sourceContentHash: redacted.sourceContentHash, applied: true, nodesWritten: shard.nodes.length, edgesWritten: shard.edges.length, nodeIds: Object.fromEntries(publicNodeIds), generatedAt: now };
  });
}

async function resolveNodeRef(index: GraphIndexPort, localNodeIds: ReadonlyMap<string, string>, ref: string): Promise<string> {
  const local = localNodeIds.get(ref);
  if (local !== undefined) return local;
  if (/^[a-f0-9]{64}$/u.test(ref) && (await index.node(ref)) !== undefined) return ref;
  throw new OpenWikiError("INVALID_ARGUMENT", "Enrich edge references an unknown node.");
}

function localKey(kind: "concept" | "page", path: string, name: string): string {
  return `${kind}:${path}:${name}`;
}

async function assertContentHashMatches(repositoryRoot: string, sourcePath: string, expectedHash: string): Promise<void> {
  const absolute = path.resolve(repositoryRoot, sourcePath);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new OpenWikiError("PATH_OUTSIDE_ROOT", "Enrich sourcePath escapes the repository root.");
  }
  let details;
  try {
    details = await lstat(absolute);
  } catch {
    throw new OpenWikiError("NOT_FOUND", "Enrich sourcePath was not found.");
  }
  if (details.isSymbolicLink() || !details.isFile()) throw new OpenWikiError("SYMLINK_ESCAPE", "Enrich sourcePath must be a regular repository file.");
  const content = await readFile(absolute);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== expectedHash) throw new OpenWikiError("INVALID_ARGUMENT", "Enrich sourceContentHash does not match the current file content.");
}
