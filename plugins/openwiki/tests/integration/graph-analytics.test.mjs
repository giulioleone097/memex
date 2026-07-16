import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { OpenWikiError } from "../../dist/errors.js";
import { buildGraph, renderGraphReport } from "../../dist/graph.js";
import { readPage } from "../../dist/wiki.js";
import { initializeWiki } from "../../dist/wiki.js";
import { resolveWikiLocation } from "../../dist/paths.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-graph-analytics-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await temporaryRoot("repository");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "hub.ts"), "export function hub() { return 1; }\n");
  await writeFile(path.join(root, "src", "leaf.ts"), "import { hub } from './hub'; export function leaf() { return hub(); }\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "initial graph"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph analytics: report action", () => {
  test("graph: report computes communities, persists member-of edges, and writes graph-report.md", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const result = await renderGraphReport({ root, homeDir });
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.action, "report");
    assert.equal(result.page, "graph-report.md");
    assert.equal(result.written, true);
    assert.ok(result.communityCount >= 1);
    assert.ok(result.godNodeCount >= 1);
    assert.equal(typeof result.coverageRatio, "number");
    assert.match(result.generation, /^g-[a-f0-9]{64}$/u);
    assert.equal(Number.isNaN(Date.parse(result.generatedAt)), false);

    const location = await resolveWikiLocation({ mode: "code", root, homeDir });
    const page = await readPage(location, "graph-report.md");
    assert.match(page.content, /^# Graph Report/u);
    assert.match(page.content, /## God nodes/u);
    assert.match(page.content, /## Communities/u);
    assert.match(page.content, /## Surprising connections/u);
    assert.match(page.content, /## Suggested questions/u);
    assert.match(page.content, /## Coverage/u);
    assert.match(page.content, /## Ambiguous edges pending review/u);
  });

  test("graph: report is idempotent — a second run with no repository changes reuses the same generation", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const first = await renderGraphReport({ root, homeDir });
    const second = await renderGraphReport({ root, homeDir });
    assert.equal(first.generation, second.generation);
    assert.equal(first.communityCount, second.communityCount);
  });

  test("graph: report fails with NOT_INITIALIZED when no graph has been built yet", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await assert.rejects(renderGraphReport({ root, homeDir }), (error) => error instanceof OpenWikiError && error.code === "NOT_INITIALIZED");
  });
});
