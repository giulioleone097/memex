import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { dispatch } from "../../dist/adapter.js";
import {
  GRAPH_DEFAULTS,
  GRAPH_SCANNER_VERSION,
  canonicalizeGraph,
  createGraphEdgeId,
  createGraphNodeId,
} from "../../dist/graph-contracts.js";
import {
  currentGitFingerprint,
  enumerateRepositoryMetadata,
  readRepositoryFile,
  repositoryMetadataFingerprint,
  resolveGraphStorage,
  resolveRepositorySourceIds,
  writeGraph,
} from "../../dist/graph-store.js";

const execFileAsync = promisify(execFile);
const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-retrieve-wiring-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// dispatch() resolves its homeDir exclusively from process.env.HOME (adapter.ts's
// hostHomeDir(), never from `input` — there is no per-call override seam), but
// writeFixtureGraph(root, home) writes fixture graph state under an isolated
// temp `home` directory. Without this, dispatch() would look for the graph
// under the *real* host home directory, where the fixture was never written,
// and every dispatch("search"/"ask") call against fixture graph data would
// fail with NOT_INITIALIZED regardless of correctness. This is the standard,
// minimal way to test code that reads an env var with no injection seam.
async function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

async function initGitRepo(root) {
  const run = (...args) => execFileAsync("git", args, { cwd: root });
  await run("init", "-q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "Test");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "service.ts"), "export function runCatalogSync() {}\n");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}

// Writes a minimal, real graph directly via the shard store (bypassing
// buildGraph()/reindexCodeSymbols, which exercise the real scanner and
// reindex pipeline — this task is responsible for proving dispatch("search"/
// "ask") correctly wires retrieve.ts, not for re-proving Task 10's write-path
// embedding, which is Task 13's real-asset-gated job).
//
// Writes one real shard for src/service.ts (not an empty shards array) so
// `manifest.shards` includes its path (TP.2 review finding I3): getGraphStatus
// pre-filters repository metadata to `sourceId === undefined ||
// indexedPaths.has(path)` before computing its comparison fingerprint
// (`indexedPaths` comes from `manifest.shards`) — an empty shards array would
// make it filter out this committed, sourceId-bearing file entirely and
// compare against an empty-set fingerprint, which would never match this
// fixture's non-empty-derived one regardless of `badFingerprint`. Writing the
// real shard keeps this fixture's own fingerprint computation in agreement
// with getGraphStatus's filtered one by construction.
// If `currentGitFingerprint`/`enumerateRepositoryMetadata`/
// `repositoryMetadataFingerprint`/`resolveRepositorySourceIds`/
// `readRepositoryFile`'s exact return shapes differ from assumed here, verify
// with `grep -n "^export" plugins/openwiki/src/graph-store.ts` before adjusting.
async function writeFixtureGraph(root, home, { badFingerprint = false } = {}) {
  const resolved = await resolveGraphStorage(root, home);
  const git = await currentGitFingerprint(root);
  const { files: metadata } = await enumerateRepositoryMetadata(root, GRAPH_DEFAULTS);
  const sourceState = await resolveRepositorySourceIds(root, metadata);
  const dirtyFingerprint = badFingerprint ? "deliberately-mismatched-fingerprint" : repositoryMetadataFingerprint(sourceState);

  const repositoryNode = { id: createGraphNodeId("repository", ".", "repository"), kind: "repository", path: ".", name: "repository" };
  const fileNode = { id: createGraphNodeId("file", "src/service.ts", "service.ts"), kind: "file", path: "src/service.ts", name: "service.ts" };
  const symbolId = createGraphNodeId("symbol", "src/service.ts", "runCatalogSync", "function", "1");
  const symbolNode = { id: symbolId, kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 1, endLine: 1 };
  const containsEdge = { id: createGraphEdgeId("contains", repositoryNode.id, fileNode.id, "exact"), kind: "contains", from: repositoryNode.id, to: fileNode.id, confidence: "exact" };
  const declaresEdge = { id: createGraphEdgeId("declares", fileNode.id, symbolNode.id, "exact"), kind: "declares", from: fileNode.id, to: symbolNode.id, confidence: "exact" };

  const graphValue = canonicalizeGraph({
    schemaVersion: 1,
    workspaceId: resolved.workspaceId,
    generatedAt: new Date().toISOString(),
    source: { ...(git.gitHead === undefined ? {} : { gitHead: git.gitHead }), dirtyFingerprint, scannerVersion: GRAPH_SCANNER_VERSION },
    files: [{ path: "src/service.ts", language: "typescript", contentHash: "1".repeat(64), size: 42 }],
    nodes: [repositoryNode, fileNode, symbolNode],
    edges: [containsEdge, declaresEdge],
    diagnostics: [],
  });
  const fileEntry = metadata.find((file) => file.path === "src/service.ts");
  const loaded = await readRepositoryFile(root, fileEntry);
  const shard = {
    path: loaded.path,
    language: loaded.language,
    contentHash: loaded.contentHash,
    size: loaded.size,
    sourceId: loaded.sourceId,
    scan: { symbols: [], relations: [], imports: [], exports: [], calls: [], inherits: [], implements: [], references: [], diagnostics: [] },
  };
  await writeGraph(resolved.storage, graphValue, [shard]);
  return { symbolId };
}

async function indexFixtureChunk(dataRoot, nodeId) {
  const { openLexicalIndex } = await import("../../dist/lexical-index.js");
  const { chunkSymbols } = await import("../../dist/chunk.js");
  const node = { id: nodeId, kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 1, endLine: 1 };
  const [ref] = chunkSymbols([node]);
  const lexicalIndex = await openLexicalIndex(path.join(dataRoot, "lexical"));
  await lexicalIndex.upsert([{ ref, text: "symbol runCatalogSync (function) — src/service.ts:1-1" }]);
}

test("dispatch(search): lexical+graph signals return real evidence for an indexed symbol, marked degraded", async () => {
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  await initGitRepo(root);
  const { symbolId } = await writeFixtureGraph(root, home);
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  await indexFixtureChunk(location.dataRoot, symbolId);

  const result = await withHome(home, () => dispatch({ operation: "search", input: { mode: "code", root, query: "runCatalogSync", limit: 5, signals: ["lexical", "graph"] } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.degraded, true, "vector was excluded, so this must report degraded");
  assert.ok(result.data.evidence.some((item) => item.ref.nodeId === symbolId));
  const hit = result.data.evidence.find((item) => item.ref.nodeId === symbolId);
  assert.equal(hit.citation, "src/service.ts#L1-1");
});

test("dispatch(ask): wires a real stale=true when the graph fingerprint no longer matches", async () => {
  const root = await temporaryRoot("repo-stale");
  const home = await temporaryRoot("home-stale");
  await initGitRepo(root);
  const { symbolId } = await writeFixtureGraph(root, home, { badFingerprint: true });
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  await indexFixtureChunk(location.dataRoot, symbolId);

  const result = await withHome(home, () => dispatch({ operation: "ask", input: { mode: "code", root, query: "runCatalogSync", limit: 5, signals: ["lexical", "graph"] } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.schema, "memex.ask.v1");
  assert.equal(result.data.stale, true);
  assert.ok(result.data.relatedNodes.length >= 0);
});

// TP.2 review finding I3: this is the fresh-path counterpart to the test
// above — before the fix, no test exercised badFingerprint:false at all, so
// writeFixtureGraph's mismatch against getGraphStatus's own filtered
// fingerprint computation (see the comment on writeFixtureGraph) was never
// caught by a failing assertion.
test("dispatch(ask): wires a real stale=false when the graph fingerprint still matches (fresh path)", async () => {
  const root = await temporaryRoot("repo-fresh");
  const home = await temporaryRoot("home-fresh");
  await initGitRepo(root);
  const { symbolId } = await writeFixtureGraph(root, home);
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  await indexFixtureChunk(location.dataRoot, symbolId);

  const result = await withHome(home, () => dispatch({ operation: "ask", input: { mode: "code", root, query: "runCatalogSync", limit: 5, signals: ["lexical", "graph"] } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.schema, "memex.ask.v1");
  assert.equal(result.data.stale, false, "the fixture graph's fingerprint must match getGraphStatus's real recomputation now that indexedPaths includes the committed shard");
});

test("dispatch(search): an unknown signal is rejected with INVALID_ARGUMENT", async () => {
  const root = await temporaryRoot("repo-bad-signal");
  const home = await temporaryRoot("home-bad-signal");
  await initGitRepo(root);
  const result = await withHome(home, () => dispatch({ operation: "search", input: { mode: "code", root, query: "x", limit: 5, signals: ["not-a-real-signal"] } }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("dispatch(ask): personal mode is rejected outright, not silently degraded", async () => {
  const result = await dispatch({ operation: "ask", input: { mode: "personal", query: "x", limit: 5 } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("dispatch(search): explicitly requesting the graph signal before any graph build fails loudly with NOT_INITIALIZED", async () => {
  const root = await temporaryRoot("repo-no-graph");
  const home = await temporaryRoot("home-no-graph");
  await initGitRepo(root);
  const result = await withHome(home, () => dispatch({ operation: "search", input: { mode: "code", root, query: "x", limit: 5, signals: ["graph"] } }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_INITIALIZED");
});

test("dispatch(search): the implicit default narrows quietly (not an error) when no graph has been built yet", async () => {
  const root = await temporaryRoot("repo-implicit");
  const home = await temporaryRoot("home-implicit");
  await initGitRepo(root);
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const { openLexicalIndex } = await import("../../dist/lexical-index.js");
  const { chunkMarkdown } = await import("../../dist/chunk.js");
  const [ref] = chunkMarkdown("notes.md", "# Notes\n\nfindable term here.\n");
  await (await openLexicalIndex(path.join(location.dataRoot, "lexical"))).upsert([{ ref, text: "findable term here" }]);
  const result = await withHome(home, () => dispatch({ operation: "search", input: { mode: "code", root, query: "findable", limit: 5 } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.degraded, true, "no graph exists yet, so the implicit default must narrow and report degraded");
});
