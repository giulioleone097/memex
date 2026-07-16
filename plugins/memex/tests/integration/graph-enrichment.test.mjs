import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { createGraphEdgeId, createGraphNodeId } from "../../dist/graph-contracts.js";
import { buildGraph } from "../../dist/graph.js";
import { openGraphIndex, resolveGraphStorage, writeGraph } from "../../dist/graph-store.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-graph-enrichment-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await temporaryRoot("repo");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "memex@example.test"]);
  await git(root, ["config", "user.name", "Memex Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "worker.ts"), "export function run() { return 1; }\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

function seedGraph(workspaceId) {
  const repositoryId = createGraphNodeId("repository", ".", "repository");
  return { schemaVersion: 2, workspaceId, generatedAt: "2026-07-14T00:00:00.000Z", source: { dirtyFingerprint: "a".repeat(64), scannerVersion: "memex-graph-v1" }, files: [], nodes: [{ id: repositoryId, kind: "repository", path: ".", name: "repository" }], edges: [], diagnostics: [] };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph enrichment survives rebuild", () => {
  test("a subsequent graph build preserves prior enrichment shards and merges concept/page nodes", async () => {
    const root = await repository();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });

    const resolved = await resolveGraphStorage(root, home);
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const conceptId = createGraphNodeId("concept", "concepts/worker.md", "worker");
    const runId = createGraphNodeId("symbol", "src/worker.ts", "run", "function", "1");
    const shard = {
      sourcePath: "architecture.md",
      sourceContentHash: "a".repeat(64),
      nodes: [
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: conceptId, kind: "concept", path: "concepts/worker.md", name: "worker" },
      ],
      edges: [
        { id: createGraphEdgeId("describes", pageId, conceptId, "extracted"), kind: "describes", from: pageId, to: conceptId, confidence: "extracted" },
        { id: createGraphEdgeId("mentions", pageId, runId, "inferred"), kind: "mentions", from: pageId, to: runId, confidence: "inferred" },
      ],
      enrichedAt: "2026-07-14T00:00:00.000Z",
    };
    await writeGraph(resolved.storage, seedGraph(resolved.workspaceId), [], [shard]);

    const rebuilt = await buildGraph({ root, homeDir: home });
    assert.equal(rebuilt.nodeCount >= 4, true);

    const indexAfter = await openGraphIndex((await resolveGraphStorage(root, home)).storage);
    assert.ok(await indexAfter.node(pageId));
    assert.ok(await indexAfter.node(conceptId));
    const edgesAfter = await indexAfter.allEdges();
    assert.equal(edgesAfter.some((edge) => edge.kind === "describes" && edge.from === pageId && edge.to === conceptId), true);
    assert.equal(edgesAfter.some((edge) => edge.kind === "mentions" && edge.to === runId), true);
  });

  test("a graph build prunes a mention edge whose target symbol was removed, recording a dangling diagnostic", async () => {
    const root = await repository();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const resolved = await resolveGraphStorage(root, home);
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const shard = {
      sourcePath: "architecture.md",
      sourceContentHash: "a".repeat(64),
      nodes: [{ id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" }],
      edges: [{ id: createGraphEdgeId("mentions", pageId, "0".repeat(64), "inferred"), kind: "mentions", from: pageId, to: "0".repeat(64), confidence: "inferred" }],
      enrichedAt: "2026-07-14T00:00:00.000Z",
    };
    await writeGraph(resolved.storage, seedGraph(resolved.workspaceId), [], [shard]);

    const rebuilt = await buildGraph({ root, homeDir: home });
    assert.equal(rebuilt.diagnosticCount >= 1, true);
    const edgesAfter = await (await openGraphIndex((await resolveGraphStorage(root, home)).storage)).allEdges();
    assert.equal(edgesAfter.some((edge) => edge.to === "0".repeat(64)), false);
  });

  test("a pre-2a schemaVersion:1 snapshot degrades the next build to an explicit full rescan, never a crash or a false-fresh claim", async () => {
    const root = await repository();
    const home = await temporaryRoot("home");
    const first = await buildGraph({ root, homeDir: home });
    assert.equal(first.buildMode, "full");

    const resolved = await resolveGraphStorage(root, home);
    const manifest = JSON.parse(await readFile(resolved.storage.manifestPath, "utf8"));
    const snapshotPath = path.join(resolved.storage.generationRoot, manifest.snapshot);
    const legacySnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    await writeFile(snapshotPath, `${JSON.stringify({ ...legacySnapshot, schemaVersion: 1 })}\n`, "utf8");

    const second = await buildGraph({ root, homeDir: home });
    assert.equal(second.buildMode, "full");
    assert.equal(second.fullRebuild, true);
    assert.deepEqual(second.changedPaths.sort(), ["src/worker.ts"]);
  });
});
