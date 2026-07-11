import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { openGraphIndex, resolveGraphStorage, withGraphWriteLock, writeGraph } from "../../dist/graph-store.js";

const roots = [];

async function temporaryRoot(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-concurrency-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("graph store: a real child-process writer excludes another writer", async () => {
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  const resolved = await resolveGraphStorage(root, home);
  const repository = createGraphNodeId("repository", ".", "repository");
  await writeGraph(resolved.storage, { schemaVersion: 1, workspaceId: "a".repeat(64), generatedAt: "2026-07-11T00:00:00.000Z", source: { dirtyFingerprint: "b".repeat(64), scannerVersion: "openwiki-graph-v1" }, files: [], nodes: [{ id: repository, kind: "repository", path: ".", name: "repository" }], edges: [], diagnostics: [] }, []);
  const moduleUrl = pathToFileURL(path.resolve("dist/graph-store.js")).href;
  const script = `import { once } from "node:events"; import { resolveGraphStorage, withGraphWriteLock } from ${JSON.stringify(moduleUrl)}; const resolved = await resolveGraphStorage(process.argv[1], process.argv[2]); await withGraphWriteLock(resolved.storage, async () => { process.stdout.write("locked\\n"); await once(process.stdin, "data"); process.stdin.destroy(); });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, root, home], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const [chunk] = await once(child.stdout, "data");
  assert.equal(chunk.toString("utf8"), "locked\n");
  const reader = await openGraphIndex(resolved.storage);
  assert.equal((await reader.architectureSummary()).nodeCount, 1);
  await assert.rejects(withGraphWriteLock(resolved.storage, async () => undefined), { code: "LOCKED" });
  child.stdin.end("release\n");
  const [code] = await once(child, "close");
  assert.equal(code, 0);
});
