import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { OpenWikiError } from "../../dist/errors.js";
import { buildGraph, explainGraphNode, getGraphPath, listGraphCommunities, renderGraphReport } from "../../dist/graph.js";
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

async function twoClusterRepository() {
  const root = await temporaryRoot("repository");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a1.ts"), "export function a1() { return a2(); }\n");
  await writeFile(path.join(root, "src", "a2.ts"), "export function a2() { return 1; }\n");
  await writeFile(path.join(root, "src", "b1.ts"), "export function b1() { return b2(); }\n");
  await writeFile(path.join(root, "src", "b2.ts"), "export function b2() { return 2; }\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "two disjoint semantic clusters"]);
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

describe("graph analytics: communities action", () => {
  test("graph: communities lists the persisted snapshot with a fresh flag when generations match", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    const report = await renderGraphReport({ root, homeDir });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.equal(communities.schemaVersion, 1);
    assert.equal(communities.action, "communities");
    assert.equal(communities.stale, false);
    assert.equal(communities.generation, report.generation);
    assert.ok(communities.communities.length >= 1);
    for (const community of communities.communities) {
      assert.equal(typeof community.id, "string");
      assert.ok(Number.isInteger(community.memberCount) && community.memberCount >= 1);
      assert.ok(Array.isArray(community.topTerms));
    }
  });

  test("graph: communities reports stale when the graph is rebuilt after the last report", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await renderGraphReport({ root, homeDir });

    await writeFile(path.join(root, "src", "leaf.ts"), "import { hub } from './hub'; export function leaf() { return hub() + 1; }\n");
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "-m", "second commit"]);
    await buildGraph({ root, homeDir, force: true });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.equal(communities.stale, true);
  });

  test("graph: communities returns an empty, stale result before any report has run", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.deepEqual(communities.communities, []);
    assert.equal(communities.stale, true);
  });

  test("graph: communities separates two disjoint semantic clusters into at least two distinct communities on a real build", async () => {
    const root = await twoClusterRepository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await renderGraphReport({ root, homeDir });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.ok(
      communities.communities.length >= 2,
      `expected at least two distinct communities for two unrelated call-clusters sharing only a directory, got ${String(communities.communities.length)}`,
    );

    // The two clusters must not have been merged into a single community purely because
    // their files share a "src" directory (structural containment must not drive community
    // membership after the semantic-edge-only fix).
    const clusterA = communities.communities.find((community) => community.topTerms.some((term) => term === "a1" || term === "a2"));
    const clusterB = communities.communities.find((community) => community.topTerms.some((term) => term === "b1" || term === "b2"));
    assert.ok(clusterA !== undefined, "expected a community whose top terms mention a1/a2");
    assert.ok(clusterB !== undefined, "expected a community whose top terms mention b1/b2");
    assert.notEqual(clusterA.id, clusterB.id);
  });
});

describe("graph analytics: path action", () => {
  test("graph: path finds a deterministic confidence-weighted route between two symbols", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const first = await getGraphPath({ root, homeDir, from: "leaf", to: "hub" });
    const second = await getGraphPath({ root, homeDir, from: "leaf", to: "hub" });
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.action, "path");
    assert.equal(first.found, true);
    assert.ok(first.nodes.some((candidate) => candidate.name === "leaf"));
    assert.ok(first.nodes.some((candidate) => candidate.name === "hub"));
    assert.deepEqual(first, second);
  });

  test("graph: path reports found:false for two real but disconnected targets", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await writeFile(path.join(root, "src", "island.ts"), "export function island() { return 0; }\n");
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "-m", "add island"]);
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const result = await getGraphPath({ root, homeDir, from: "island", to: "hub" });
    assert.equal(result.found, false);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
  });

  test("graph: path rejects an unknown endpoint with NOT_FOUND", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await assert.rejects(getGraphPath({ root, homeDir, from: "hub", to: "doesNotExist" }), (error) => error instanceof OpenWikiError && error.code === "NOT_FOUND");
  });
});

describe("graph analytics: explain action", () => {
  test("graph: explain returns the node, its neighborhood, and its community after a report has run", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await renderGraphReport({ root, homeDir });

    const explanation = await explainGraphNode({ root, homeDir, target: "hub" });
    assert.equal(explanation.schemaVersion, 1);
    assert.equal(explanation.action, "explain");
    assert.equal(explanation.node.name, "hub");
    assert.ok(explanation.neighborhood.nodes.some((candidate) => candidate.name === "leaf"));
    assert.equal(explanation.communityStale, false);
    assert.ok(explanation.community !== undefined);
    assert.ok(Number.isInteger(explanation.community.memberCount) && explanation.community.memberCount >= 1);
    assert.deepEqual(explanation.citingPages, []);
  });

  test("graph: explain reports communityStale before any report has run and omits community", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const explanation = await explainGraphNode({ root, homeDir, target: "hub" });
    assert.equal(explanation.community, undefined);
    assert.equal(explanation.communityStale, true);
  });
});
