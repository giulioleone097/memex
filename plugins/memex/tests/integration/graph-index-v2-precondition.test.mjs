import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { createGraphEdgeId, createGraphNodeId } from "../../dist/graph-contracts.js";
import { openGraphIndex, resolveGraphStorage, writeGraph } from "../../dist/graph-store.js";
import { MemexError } from "../../dist/errors.js";

const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-graph-index-v2-precondition-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph analytics: precondition (slice 2a schema-v2 index widening)", () => {
  test("precondition: the lazy bucketed graph index reads back schema-v2 node kinds, edge kinds, and agent confidences without INVALID_STATE", async () => {
    const root = await temporaryRoot("repository");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);

    const repositoryId = createGraphNodeId("repository", ".", "repository");
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const conceptId = createGraphNodeId("concept", "concepts/x.md", "x");
    const sourceId = createGraphNodeId("source", "docs/spec.md", "spec");
    const describesId = createGraphEdgeId("describes", pageId, conceptId, "extracted");
    const mentionsId = createGraphEdgeId("mentions", conceptId, repositoryId, "inferred");
    const relatedId = createGraphEdgeId("related", conceptId, sourceId, "ambiguous");
    const memberOfId = createGraphEdgeId("member-of", conceptId, repositoryId, "exact");

    const graph = {
      schemaVersion: 2,
      workspaceId: resolved.workspaceId,
      generatedAt: "2026-07-14T00:00:00.000Z",
      source: { dirtyFingerprint: "a".repeat(64), scannerVersion: "memex-graph-v1" },
      files: [],
      nodes: [
        { id: repositoryId, kind: "repository", path: ".", name: "repository" },
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: conceptId, kind: "concept", path: "concepts/x.md", name: "x" },
        { id: sourceId, kind: "source", path: "docs/spec.md", name: "spec" },
      ],
      edges: [
        { id: describesId, kind: "describes", from: pageId, to: conceptId, confidence: "extracted" },
        { id: mentionsId, kind: "mentions", from: conceptId, to: repositoryId, confidence: "inferred" },
        { id: relatedId, kind: "related", from: conceptId, to: sourceId, confidence: "ambiguous" },
        { id: memberOfId, kind: "member-of", from: conceptId, to: repositoryId, confidence: "exact" },
      ],
      diagnostics: [],
    };

    try {
      await writeGraph(resolved.storage, graph, []);
      const index = await openGraphIndex(resolved.storage);
      await index.node(conceptId);
      await index.edge(describesId);
      await index.edge(mentionsId);
      await index.edge(relatedId);
      await index.edge(memberOfId);
      await index.inbound(conceptId, 10);
      await index.outbound(conceptId, 10);
      await index.architectureSummary();
    } catch (error) {
      if (error instanceof MemexError && error.code === "INVALID_STATE") {
        throw new Error(
          "PRECONDITION FAILED: graph-index.ts's lazy-index kind/confidence guards do not yet accept the schema-v2 " +
            "vocabulary (concept/page/source node kinds; mentions/describes/grounds/related/member-of edge kinds; " +
            "extracted/inferred/ambiguous agent confidences). Slice 2c's report/explain actions cannot pass without " +
            "this. This plan does not widen those guards itself — that is owned by slice 2a's plan " +
            "(docs/superpowers/plans/2026-07-14-memex-plan-2a.md, Task 3, which imports isGraphNodeKind/isGraphEdgeKind/" +
            "isGraphConfidence from graph-contracts.ts). Land slice 2a's Task 3 first, then re-run this test before " +
            "proceeding with Task 6's Step 1 or any later task in this plan.",
          { cause: error },
        );
      }
      throw error;
    }
  });
});
