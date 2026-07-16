import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { enrichGraph } from "../../dist/enrich.js";
import { buildGraph } from "../../dist/graph.js";
import { openGraphIndex, resolveGraphStorage } from "../../dist/graph-store.js";
import { OpenWikiError } from "../../dist/errors.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-enrich-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repositoryWithWikiPage() {
  const root = await temporaryRoot("repo");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "worker.ts"), "export function run() { return 1; }\n");
  await mkdir(path.join(root, "openwiki"));
  await writeFile(path.join(root, "openwiki", "architecture.md"), "# Architecture\n\nThe worker performs background runs.\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function pageHash(root, relativePath) {
  return createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(overrides = {}) {
  return {
    schema: "memex.enrich.v1",
    sourcePath: "openwiki/architecture.md",
    sourceContentHash: "",
    nodes: [{ kind: "page", name: "openwiki/architecture.md", path: "openwiki/architecture.md" }],
    edges: [],
    ...overrides,
  };
}

describe("enrich operation", () => {
  test("requires a prior graph build", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    const hash = await pageHash(root, "openwiki/architecture.md");
    await assert.rejects(enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }) }), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "NOT_INITIALIZED");
      return true;
    });
  });

  test("persists a page node grounded by an auto-synthesized source node", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const hash = await pageHash(root, "openwiki/architecture.md");

    const result = await enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }), now: "2026-07-14T00:00:00.000Z" });
    assert.equal(result.applied, true);
    assert.equal(result.nodesWritten, 2);

    const pageId = createGraphNodeId("page", "openwiki/architecture.md", "openwiki/architecture.md");
    const resolved = await resolveGraphStorage(root, home);
    const index = await openGraphIndex(resolved.storage);
    assert.ok(await index.node(pageId));
    const edges = await index.allEdges();
    assert.equal(edges.some((edge) => edge.kind === "grounds" && edge.to === pageId), true);
  });

  test("references an existing code symbol node by its graph id in a mentions edge", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const hash = await pageHash(root, "openwiki/architecture.md");
    const runId = createGraphNodeId("symbol", "src/worker.ts", "run", "function", "1");

    const result = await enrichGraph({
      root,
      homeDir: home,
      envelope: envelope({
        sourceContentHash: hash,
        edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: runId, confidence: "inferred" }],
      }),
    });
    assert.equal(result.applied, true);

    const resolved = await resolveGraphStorage(root, home);
    const edges = await (await openGraphIndex(resolved.storage)).allEdges();
    assert.equal(edges.some((edge) => edge.kind === "mentions" && edge.to === runId), true);
  });

  test("is a no-op on an unchanged sourceContentHash and rejects an unresolved edge reference", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const hash = await pageHash(root, "openwiki/architecture.md");

    await enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }) });
    const second = await enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }) });
    assert.equal(second.applied, false);

    await assert.rejects(
      enrichGraph({
        root,
        homeDir: home,
        envelope: envelope({ sourceContentHash: hash, edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: "f".repeat(64), confidence: "inferred" }] }),
      }),
      (error) => {
        assert.ok(error instanceof OpenWikiError);
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );
  });

  test("rejects a sourceContentHash that does not match the current file content", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });

    await assert.rejects(enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: "0".repeat(64) }) }), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
  });
});
