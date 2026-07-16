import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { enrichGraph } from "../../dist/enrich.js";
import { buildGraph } from "../../dist/graph.js";
import { openGraphIndex, resolveGraphStorage } from "../../dist/graph-store.js";
import { checkWiki, initializeWiki } from "../../dist/wiki.js";

const execFileAsync = promisify(execFile);
const roots = [];
const STANDARD_PAGES = ["quickstart.md", "architecture.md", "source-map.md", "workflows.md", "domain-concepts.md", "operations.md", "integrations.md", "testing.md"];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-wiki-graph-check-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("check enforces page-to-graph anchoring", () => {
  test("flags every standard page as missing a page node until enrichment grounds it", async () => {
    const root = await temporaryRoot("repo");
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "memex@example.test"]);
    await git(root, ["config", "user.name", "Memex Test"]);
    const home = await temporaryRoot("home");
    const initialized = await initializeWiki({ mode: "code", root, homeDir: home, now: "2026-07-14T00:00:00.000Z", runId: "init-1" });
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "wiki"]);
    await buildGraph({ root, homeDir: home });

    const withoutGraph = await checkWiki(initialized.location);
    assert.equal(withoutGraph.ok, true);

    const resolved = await resolveGraphStorage(root, home);
    const graphBeforeEnrich = await openGraphIndex(resolved.storage);
    const withGraphBeforeEnrich = await checkWiki(initialized.location, { graph: graphBeforeEnrich });
    assert.equal(withGraphBeforeEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_NODE" && issue.page === "quickstart.md"), true);

    for (const page of STANDARD_PAGES) {
      const content = await readFile(path.join(root, "memex", page));
      const hash = createHash("sha256").update(content).digest("hex");
      const isQuickstart = page === "quickstart.md";
      await enrichGraph({
        root,
        homeDir: home,
        envelope: {
          schema: "memex.enrich.v1",
          sourcePath: `memex/${page}`,
          sourceContentHash: hash,
          nodes: [
            { kind: "page", name: `memex/${page}`, path: `memex/${page}` },
            ...(isQuickstart ? [{ kind: "concept", name: "process model", path: "concepts/process-model.md" }] : []),
          ],
          edges: isQuickstart
            ? [{ kind: "describes", from: `page:memex/${page}:memex/${page}`, to: "concept:concepts/process-model.md:process model", confidence: "extracted" }]
            : [],
        },
      });
    }

    const resolvedAfter = await resolveGraphStorage(root, home);
    const graphAfter = await openGraphIndex(resolvedAfter.storage);
    const withGraphAfterEnrich = await checkWiki(initialized.location, { graph: graphAfter });
    assert.equal(withGraphAfterEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_NODE"), false);
    assert.equal(withGraphAfterEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_EDGE" && issue.page === "quickstart.md"), false);
    assert.equal(withGraphAfterEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_EDGE" && issue.page === "architecture.md"), true);
  });
});
