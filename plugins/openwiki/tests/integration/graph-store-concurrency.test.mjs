import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { openGraphIndex, resolveGraphStorage, withGraphWriteLock, writeGraph } from "../../dist/graph-store.js";

const roots = [];
const PHASE_TIMEOUT_MS = 10_000;

async function temporaryRoot(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-concurrency-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function withinPhase(promise, phase) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`Timed out waiting for graph writer ${phase} after ${PHASE_TIMEOUT_MS}ms.`)), PHASE_TIMEOUT_MS);
    promise.then(resolve, reject).finally(() => globalThis.clearTimeout(timer));
  });
}

test("graph store: a real child-process writer excludes another writer", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  const resolved = await resolveGraphStorage(root, home);
  const repository = createGraphNodeId("repository", ".", "repository");
  await writeGraph(resolved.storage, { schemaVersion: 2, workspaceId: "a".repeat(64), generatedAt: "2026-07-11T00:00:00.000Z", source: { dirtyFingerprint: "b".repeat(64), scannerVersion: "openwiki-graph-v1" }, files: [], nodes: [{ id: repository, kind: "repository", path: ".", name: "repository" }], edges: [], diagnostics: [] }, []);
  const script = `import { once } from "node:events"; import { open, unlink } from "node:fs/promises"; const lockPath = process.argv[1]; const serialized = JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), token: "test-writer" }) + "\\n"; const handle = await open(lockPath, "wx", 0o600); await handle.writeFile(serialized, "utf8"); await handle.sync(); process.stdout.write("locked\\n"); await once(process.stdin, "data"); await handle.close(); await unlink(lockPath);`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, resolved.storage.writeLockPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed.catch(() => undefined);
    await unlink(resolved.storage.writeLockPath).catch(() => undefined);
  });
  const [chunk] = await withinPhase(once(child.stdout, "data"), "lock handshake");
  assert.equal(chunk.toString("utf8"), "locked\n");
  const reader = await openGraphIndex(resolved.storage);
  assert.equal((await reader.architectureSummary()).nodeCount, 1);
  await assert.rejects(withGraphWriteLock(resolved.storage, async () => undefined), { code: "LOCKED" });
  child.stdin.end("release\n");
  const [code] = await withinPhase(closed, "child close");
  assert.equal(code, 0);
});
