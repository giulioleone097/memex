import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  createGraphEdgeId,
  createGraphNodeId,
} from "../../dist/graph-contracts.js";
import {
  openGraphIndex,
  readGraphShard,
  probeGraphStorage,
  resolveGraphStorage,
  withGraphWriteLock,
  writeGraph,
  changedRepositoryPaths,
} from "../../dist/graph-store.js";

const roots = [];
const execFile = promisify(execFileCallback);

async function temporaryRoot(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-v2-${name}-`));
  roots.push(root);
  return root;
}

async function git(root, ...args) {
  return execFile("git", args, { cwd: root, windowsHide: true });
}

function graph(label) {
  const repository = createGraphNodeId("repository", ".", "repository");
  const worker = createGraphNodeId("symbol", "src/worker.ts", `worker-${label}`, "function", "1");
  const app = createGraphNodeId("symbol", "src/app.ts", `app-${label}`, "function", "1");
  const edge = createGraphEdgeId("calls", app, worker, "exact");
  return {
    schemaVersion: 2,
    workspaceId: "a".repeat(64),
    generatedAt: `2026-07-11T00:00:0${label}.000Z`,
    source: { dirtyFingerprint: label.repeat(64), scannerVersion: "openwiki-graph-v1" },
    files: [
      { path: "src/app.ts", language: "typescript", contentHash: "b".repeat(64), size: 20 },
      { path: "src/worker.ts", language: "typescript", contentHash: "c".repeat(64), size: 20 },
    ],
    nodes: [
      { id: repository, kind: "repository", path: ".", name: "repository" },
      { id: worker, kind: "symbol", path: "src/worker.ts", name: `worker-${label}`, symbolKind: "function", startLine: 1, endLine: 1 },
      { id: app, kind: "symbol", path: "src/app.ts", name: `app-${label}`, symbolKind: "function", startLine: 1, endLine: 1 },
    ].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [{ id: edge, kind: "calls", from: app, to: worker, confidence: "exact" }],
    diagnostics: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph store v2", () => {
  test("stores immutable buckets and serves exact, ranked, and bounded adjacency reads without its compatibility snapshot", async () => {
    const root = await temporaryRoot("lazy");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    const first = graph("1");
    await writeGraph(resolved.storage, first, []);

    const manifest = JSON.parse(await readFile(resolved.storage.manifestPath, "utf8"));
    await unlink(path.join(resolved.storage.generationRoot, manifest.snapshot));
    const index = await openGraphIndex(resolved.storage);
    const worker = first.nodes.find((node) => node.name === "worker-1");
    const app = first.nodes.find((node) => node.name === "app-1");
    assert.ok(worker);
    assert.ok(app);
    assert.deepEqual(await index.node(worker.id), worker);
    assert.deepEqual(await index.rankedCandidates("worker", 1), [worker.id]);
    assert.equal((await index.outbound(app.id, 1)).edges.length, 1);
    assert.equal((await index.inbound(worker.id, 1)).edges.length, 1);
    assert.equal(index.metrics().filesRead <= 1 + manifest.index.nodeBuckets.length + manifest.index.outboundBuckets.length + manifest.index.inboundBuckets.length + manifest.index.symbolBuckets.length, true);
  });

  test("falls back only to a valid previous generation and reports recovery", async () => {
    const root = await temporaryRoot("recovery");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    await writeGraph(resolved.storage, graph("1"), []);
    await writeGraph(resolved.storage, graph("2"), []);
    await writeFile(resolved.storage.manifestPath, "{ broken", "utf8");

    const index = await openGraphIndex(resolved.storage);
    assert.equal(index.status().recovered, true);
    assert.deepEqual(await index.rankedCandidates("worker-1", 1), [graph("1").nodes.find((node) => node.name === "worker-1").id]);
  });

  test("preserves qualified scopes and relation sites in reusable scan shards", async () => {
    const root = await temporaryRoot("shard-contract");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    const source = graph("1");
    const shard = {
      path: "src/service.ts",
      language: "typescript",
      contentHash: "d".repeat(64),
      size: 40,
      sourceId: `worktree:${"d".repeat(64)}`,
      scan: {
        symbols: [{ name: "run", qualifiedName: "Service.run", scope: "Service", kind: "method", startLine: 2, endLine: 2, exported: false }],
        relations: [{ kind: "calls", fromQualifiedName: "Service.run", target: "helper", line: 3, confidence: "resolved" }],
        imports: [], exports: [], calls: ["helper"], inherits: [], implements: [], references: [], diagnostics: [],
      },
    };
    await writeGraph(resolved.storage, source, [shard]);
    const manifest = JSON.parse(await readFile(resolved.storage.manifestPath, "utf8"));
    const restored = await readGraphShard(resolved.storage, manifest.shards[0].shard);
    assert.deepEqual(restored.scan.symbols[0], shard.scan.symbols[0]);
    assert.deepEqual(restored.scan.relations[0], shard.scan.relations[0]);
  });

  test("probe does not create storage and the graph writer lock rejects active ownership", async () => {
    const root = await temporaryRoot("probe");
    const home = await temporaryRoot("home");
    const initial = await probeGraphStorage(root, home);
    assert.equal(initial.initialized, false);
    await assert.rejects(readFile(path.join(home, ".openwiki", "data")), { code: "ENOENT" });

    const resolved = await resolveGraphStorage(root, home);
    let release;
    const entered = new Promise((resolve) => { release = resolve; });
    const owner = withGraphWriteLock(resolved.storage, async () => {
      release();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    });
    await entered;
    await assert.rejects(withGraphWriteLock(resolved.storage, async () => undefined), { code: "LOCKED" });
    await owner;
  });

  test("reports committed, staged, working-tree, renamed, deleted, and untracked paths since a base", async () => {
    const root = await temporaryRoot("changes");
    await git(root, "init");
    await git(root, "config", "user.email", "openwiki@example.test");
    await git(root, "config", "user.name", "OpenWiki Tests");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "tracked.ts"), "export const oldValue = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "deleted.ts"), "export const deleted = 1;\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    const { stdout } = await git(root, "rev-parse", "HEAD");
    const base = stdout.trim();
    await git(root, "mv", "src", "src-renamed");
    await writeFile(path.join(root, "src-renamed", "tracked.ts"), "export const changed = 2;\n", "utf8");
    await rm(path.join(root, "src-renamed", "deleted.ts"));
    await writeFile(path.join(root, "untracked.ts"), "export const untracked = true;\n", "utf8");

    assert.deepEqual(await changedRepositoryPaths(root, base), ["src/deleted.ts", "src/tracked.ts", "src-renamed/deleted.ts", "src-renamed/tracked.ts", "untracked.ts"].sort((left, right) => left.localeCompare(right)));
  });
});
