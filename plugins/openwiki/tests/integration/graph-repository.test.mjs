import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { OpenWikiError } from "../../dist/errors.js";
import {
  analyzeGraphChanges,
  analyzeGraphImpact,
  buildGraph,
  getArchitectureMap,
  getGraphContext,
  getGraphStatus,
} from "../../dist/graph.js";
import { readStoredGraph, resolveGraphStorage } from "../../dist/graph-store.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-graph-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

async function repository() {
  const root = await temporaryRoot("repository");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "helper.ts"), "export function helper() { return 1; }\n");
  await writeFile(path.join(root, "src", "app.ts"), "import { helper } from './helper'; export function app() { return helper(); }\n");
  await writeFile(path.join(root, "worker.py"), "class Worker:\n    def run(self):\n        return app()\n");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "initial graph"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph repository", () => {
  test("graph: builds a real multi-language repository and maps impact", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    const first = await buildGraph({ root, homeDir, now: "2026-07-11T00:00:00.000Z" });
    const storage = await resolveGraphStorage(root, homeDir);
    const persisted = await readStoredGraph(storage.storage);
    assert.equal(persisted.files.some((file) => file.path === "ignored.txt"), false);
    assert.equal(persisted.files.some((file) => file.path === "src/app.ts"), true);
    assert.equal(persisted.nodes.some((node) => node.name === "app"), true);
    assert.equal(persisted.edges.some((edge) => edge.kind === "imports"), true);
    assert.equal(persisted.edges.some((edge) => edge.kind === "calls"), true);
    const second = await buildGraph({ root, homeDir, now: "2026-07-11T00:01:00.000Z" });
    assert.equal(second.buildMode, "incremental");
    assert.equal("graph" in second, false);
    const context = await getGraphContext({ root, homeDir, target: "app", limit: 10 });
    assert.equal(context.nodes.some((node) => node.name === "app"), true);
    const impact = await analyzeGraphImpact({ root, homeDir, target: "helper", direction: "inbound", depth: 3 });
    assert.equal(impact.nodes.some((node) => node.name === "app"), true);
    const map = await getArchitectureMap({ root, homeDir, limit: 10 });
    assert.equal(map.modules.length > 0, true);
    assert.equal(first.buildMode, "full");
  });

  test("graph: handles dirty fingerprints, renames and deletes with private atomic recovery", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    const initial = await buildGraph({ root, homeDir });
    await git(root, ["mv", "src/helper.ts", "src/utility.ts"]);
    await writeFile(path.join(root, "src", "app.ts"), "import { helper } from './utility'; export function app() { return helper(); }\n");
    await rm(path.join(root, "worker.py"));
    const updated = await buildGraph({ root, homeDir });
    assert.notEqual(updated.dirtyFingerprint, initial.dirtyFingerprint);
    assert.equal(updated.changedPaths.includes("src/helper.ts"), true);
    assert.equal(updated.changedPaths.includes("src/utility.ts"), true);
    const changes = await analyzeGraphChanges({ root, homeDir, limit: 20 });
    assert.equal(changes.changedPaths.includes("src/utility.ts"), true);
    const storage = await resolveGraphStorage(root, homeDir);
    await writeFile(storage.storage.manifestPath, "{broken", "utf8");
    const status = await getGraphStatus({ root, homeDir });
    assert.equal(status.counts.files > 0, true);
  });

  test("graph: considers an unchanged dirty build fresh and detects the next dirty edit", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await writeFile(path.join(root, "src", "app.ts"), "import { helper } from './helper'; export function app() { return helper() + 1; }\n");
    const first = await buildGraph({ root, homeDir });
    const immediate = await getGraphStatus({ root, homeDir });
    assert.equal(immediate.fresh, true);
    const second = await buildGraph({ root, homeDir });
    assert.equal(second.scannedFileCount, 0);
    assert.equal(second.dirtyFingerprint, first.dirtyFingerprint);
    await writeFile(path.join(root, "src", "app.ts"), "import { helper } from './helper'; export function app() { return helper() + 2; }\n");
    assert.equal((await getGraphStatus({ root, homeDir })).fresh, false);
  });

  test("graph: skips tracked and dirty binary files without changing graph freshness", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await writeFile(path.join(root, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    await git(root, ["add", "asset.bin"]);
    await git(root, ["commit", "-m", "binary fixture"]);
    const built = await buildGraph({ root, homeDir });
    assert.equal(built.fileCount > 0, true);
    assert.equal((await getGraphStatus({ root, homeDir })).fresh, true);
    await writeFile(path.join(root, "asset.bin"), Buffer.from([0, 4, 5, 6]));
    assert.equal((await getGraphStatus({ root, homeDir })).fresh, true);
  });

  test("graph: rejects symlink escapes and hard caps rather than silently storing partial graphs", async () => {
    const root = await repository();
    const outside = await temporaryRoot("outside");
    const homeDir = await temporaryRoot("home");
    await writeFile(path.join(outside, "escape.ts"), "export const escape = 1;\n");
    await symlink(path.join(outside, "escape.ts"), path.join(root, "src", "escape.ts"));
    await assert.rejects(buildGraph({ root, homeDir }), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "SYMLINK_ESCAPE");
      return true;
    });
    await rm(path.join(root, "src", "escape.ts"));
    await assert.rejects(buildGraph({ root, homeDir, limits: { maxFiles: 1 } }), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "SOURCE_TOO_LARGE");
      return true;
    });
  });
});
