import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  GRAPH_DEFAULTS,
  createGraphEdgeId,
  createGraphNodeId,
  parseCodeGraph,
} from "../../dist/graph-contracts.js";
import { detectLanguage, scanSourceFile } from "../../dist/graph-scan.js";
import { MemexError } from "../../dist/errors.js";
import { queryGraph } from "../../dist/graph-query.js";

const SOURCE = {
  gitHead: "a".repeat(40),
  dirtyFingerprint: "b".repeat(64),
  scannerVersion: "memex-graph-v1",
};

function graph(overrides = {}) {
  return {
    schemaVersion: 2,
    workspaceId: "workspace",
    generatedAt: "2026-07-11T00:00:00.000Z",
    source: SOURCE,
    files: [],
    nodes: [],
    edges: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("graph contracts and scanners", () => {
  test("graph: parses only canonical deterministic CodeGraphV1 values", () => {
    const fileId = createGraphNodeId("file", "src/index.ts", "index.ts");
    const repositoryId = createGraphNodeId("repository", ".", "workspace");
    const edgeId = createGraphEdgeId("contains", repositoryId, fileId, "exact");
    const parsed = parseCodeGraph(
      graph({
        files: [{ path: "src/index.ts", language: "typescript", contentHash: "c".repeat(64), size: 12 }],
        nodes: [
          { id: fileId, kind: "file", path: "src/index.ts", name: "index.ts" },
          { id: repositoryId, kind: "repository", path: ".", name: "workspace" },
        ],
        edges: [{ id: edgeId, kind: "contains", from: repositoryId, to: fileId, confidence: "exact" }],
      }),
    );
    assert.deepEqual(parsed.nodes.map((node) => node.id), [fileId, repositoryId]);
    assert.deepEqual(parsed.edges.map((edge) => edge.id), [edgeId]);
    assert.throws(() => parseCodeGraph({ ...graph(), schemaVersion: 1 }), MemexError);
    assert.throws(() => parseCodeGraph({ ...graph(), schemaVersion: 3 }), MemexError);
    assert.throws(() => parseCodeGraph({ ...graph(), unexpected: true }), MemexError);
  });

  test("graph: detects language tiers and strips comments and literal bodies", () => {
    assert.equal(detectLanguage("src/app.ts"), "typescript");
    assert.equal(detectLanguage("README.md"), "markdown");
    assert.equal(detectLanguage("unknown.data"), "text");
    const scan = scanSourceFile({
      path: "src/app.ts",
      language: "typescript",
      content: `// fake export function ignored() {}\nconst fake = "import nope from 'nope'; callGhost()";\nexport class App extends Base implements Runner { run() { helper(); } }\nimport { helper } from "./helper";\n`,
    });
    assert.deepEqual(scan.symbols.map((symbol) => symbol.name), ["fake", "App", "run"]);
    assert.deepEqual(scan.imports, ["./helper"]);
    assert.deepEqual(scan.calls, ["helper"]);
    assert.deepEqual(scan.inherits, ["Base"]);
    assert.deepEqual(scan.implements, ["Runner"]);
    assert.equal(JSON.stringify(scan).includes("fake export"), false);
    assert.equal(JSON.stringify(scan).includes("import nope"), false);
  });

  test("graph: extracts declarations relationships and ambiguity diagnostics without source bodies", () => {
    const scan = scanSourceFile({
      path: "pkg/service.py",
      language: "python",
      content: `from pkg.worker import Worker\nclass Service(Base):\n    def run(self):\n        Worker().start()\n        unknown()\n`,
    });
    assert.deepEqual(scan.symbols.map((symbol) => symbol.name), ["Service", "run"]);
    assert.deepEqual(scan.imports, ["pkg.worker"]);
    assert.deepEqual(scan.inherits, ["Base"]);
    assert.deepEqual(scan.calls, ["Worker", "start", "unknown"]);
    assert.equal("content" in scan, false);
  });

  test("graph: differentiates repeated symbol declarations with stable declaration scope", () => {
    const scan = scanSourceFile({
      path: "src/repeated.ts",
      language: "typescript",
      content: "function run() {}\nfunction run() {}\n",
    });
    assert.equal(scan.symbols.filter((symbol) => symbol.name === "run").length, 2);
    const ids = scan.symbols.map((symbol) => createGraphNodeId("symbol", "src/repeated.ts", symbol.name, symbol.kind, String(symbol.startLine)));
    assert.equal(new Set(ids).size, 2);
  });

  test("graph: returns explicit query truncation before serialized response cap", () => {
    const nodes = Array.from({ length: 30 }, (_, index) => ({
      id: `n-${index}`,
      kind: "symbol",
      path: "src/app.ts",
      name: `target${index}`,
      symbolKind: "function",
      startLine: index + 1,
      endLine: index + 1,
    }));
    const result = queryGraph(graph({ nodes }), { query: "target", limit: 3, responseByteLimit: 1024 });
    assert.equal(result.truncated, true);
    assert.equal(result.nodes.length, 3);
    assert.equal(GRAPH_DEFAULTS.defaultEntityLimit, 20);
  });
});
