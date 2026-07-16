import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderGraphReportMarkdown } from "../../dist/report.js";

function node(id, kind, path, name) {
  return { id, kind, path, name };
}

describe("report: graph-report.md rendering", () => {
  test("report: renders every required section with real content", () => {
    const markdown = renderGraphReportMarkdown({
      root: "/repo",
      generation: "g-abc",
      generatedAt: "2026-07-14T00:00:00.000Z",
      godNodes: [{ node: node("hub", "symbol", "src/hub.ts", "hub"), degree: 7 }],
      communities: [{ id: "hub", memberCount: 3, topTerms: ["hub", "service"], members: ["hub"], membersTruncated: false }],
      surprisingConnections: [
        {
          from: node("concept-a", "concept", "concepts/a.md", "Catalog"),
          to: node("sym-a", "symbol", "src/catalog.ts", "listActiveProducts"),
          kind: "mentions",
          confidence: "extracted",
          priority: "concept-code",
        },
      ],
      suggestedQuestions: ["What depends on hub (src/hub.ts), and what would break if it changed?"],
      coverage: { totalCodeNodes: 10, describedCodeNodes: 4, coverageRatio: 0.4 },
      ambiguousEdges: [{ edge: { id: "e-amb", kind: "related", from: "concept-a", to: "concept-b", confidence: "ambiguous" }, from: node("concept-a", "concept", "concepts/a.md", "Catalog"), to: undefined }],
    });

    assert.match(markdown, /^# Graph Report/u);
    assert.match(markdown, /## God nodes/u);
    assert.match(markdown, /hub.*7/u);
    assert.match(markdown, /## Communities/u);
    assert.match(markdown, /hub, service/u);
    assert.match(markdown, /## Surprising connections/u);
    assert.match(markdown, /Catalog.*listActiveProducts|listActiveProducts.*Catalog/u);
    assert.match(markdown, /concept-code/u);
    assert.match(markdown, /## Suggested questions/u);
    assert.match(markdown, /What depends on hub/u);
    assert.match(markdown, /## Coverage/u);
    assert.match(markdown, /4 of 10 code nodes/u);
    assert.match(markdown, /## Ambiguous edges pending review/u);
    assert.match(markdown, /Catalog.*concept-b|concept-b.*Catalog/u);
    assert.match(markdown, /g-abc/u);
  });

  test("report: renders explicit empty-state text for every empty section", () => {
    const markdown = renderGraphReportMarkdown({
      root: "/repo",
      generation: "g-empty",
      generatedAt: "2026-07-14T00:00:00.000Z",
      godNodes: [],
      communities: [],
      surprisingConnections: [],
      suggestedQuestions: [],
      coverage: { totalCodeNodes: 0, describedCodeNodes: 0, coverageRatio: 0 },
      ambiguousEdges: [],
    });
    assert.match(markdown, /No god nodes identified yet\./u);
    assert.match(markdown, /No communities identified yet\./u);
    assert.match(markdown, /No cross-plane connections identified yet\./u);
    assert.match(markdown, /No suggested questions yet\./u);
    assert.match(markdown, /No ambiguous edges pending review\./u);
  });
});
