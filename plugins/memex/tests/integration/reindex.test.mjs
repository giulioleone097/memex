import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { openLexicalIndex } from "../../dist/lexical-index.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import { reindexCodeSymbols, reindexWikiPage } from "../../dist/reindex.js";
import { readVectorChunkDigest } from "../../dist/vector-store.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-reindex-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeEmbedder(dims = 384) {
  let calls = 0;
  return {
    modelId: "test-model",
    dims,
    async embedQuery() { throw new Error("not used by reindex"); },
    async embedPassages(texts) {
      return texts.map((text, index) => {
        calls += 1;
        const vector = new Float32Array(dims);
        vector[(text.length + index) % dims] = 1;
        return vector;
      });
    },
    get calls() { return calls; },
  };
}

function fakePorts(vendorRoot, embedder) {
  return { vendorRoot, loadEmbedder: async () => embedder };
}

async function writeVendorManifest(vendorRoot) {
  await mkdir(vendorRoot, { recursive: true });
  await writeFile(path.join(vendorRoot, "MANIFEST.json"), JSON.stringify({ assets: [{ path: "model/multilingual-e5-small-int8/model.onnx", sha256: "a".repeat(64), bytes: 1, license: "MIT", upstream: "test", revision: "rev-test" }] }));
}

function fakeLocation(dataRoot) {
  return { mode: "code", workspaceId: "w", workspaceRoot: "/repo", wikiRoot: "/repo/memex", statePath: "/repo/memex/.last-update.json", dataRoot };
}

test("reindex: writing a wiki page chunks it into both the lexical index and the vector store", async () => {
  const dataRoot = await temporaryRoot("data");
  const vendorRoot = await temporaryRoot("vendor");
  await writeVendorManifest(vendorRoot);
  const embedder = fakeEmbedder();
  const content = "# Title\n\nA paragraph with enough distinctive words to be searchable and embeddable for this test case here.\n";
  const result = await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(vendorRoot, embedder));
  assert.ok(result.chunked >= 1);
  assert.equal(result.embedded, result.chunked);
  assert.equal(result.reusedVectors, 0);
  const lexical = await openLexicalIndex(path.join(dataRoot, "lexical"));
  assert.ok((await lexical.search("distinctive", 5)).length > 0);
  const digest = await readVectorChunkDigest(path.join(dataRoot, "vectors"));
  assert.equal(digest.size, result.chunked);
});

test("reindex: re-writing the same page content is a no-op that never calls the embedder again", async () => {
  const dataRoot = await temporaryRoot("data");
  const vendorRoot = await temporaryRoot("vendor");
  await writeVendorManifest(vendorRoot);
  const embedder = fakeEmbedder();
  const content = "# Title\n\nStable unchanged content for the reindex no-op test case.\n";
  await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(vendorRoot, embedder));
  const callsAfterFirst = embedder.calls;
  const result = await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(vendorRoot, embedder));
  assert.equal(embedder.calls, callsAfterFirst, "the embedder must not be invoked again for unchanged content");
  assert.equal(result.embedded, 0);
  assert.equal(result.reusedVectors, result.chunked);
});

test("reindex: reindexCodeSymbols chunks every symbol node returned by allNodes", async () => {
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  const vendorRoot = await temporaryRoot("vendor");
  await writeVendorManifest(vendorRoot);
  const embedder = fakeEmbedder();
  const symbolId = createGraphNodeId("symbol", "src/a.ts", "run", "function", "1");
  const fakeIndex = {
    async allNodes(kind) {
      const node = { id: symbolId, kind: "symbol", path: "src/a.ts", name: "run", symbolKind: "function", startLine: 1, endLine: 3 };
      return kind === undefined || kind === "symbol" ? [node] : [];
    },
  };
  const result = await reindexCodeSymbols(root, fakeIndex, home, fakePorts(vendorRoot, embedder));
  assert.equal(result.chunked, 1);
  assert.equal(result.embedded, 1);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const digest = await readVectorChunkDigest(path.join(location.dataRoot, "vectors"));
  assert.equal(digest.size, 1);
});

// TP.2 review finding C2 (orchestrator adjudication): write paths must
// soft-degrade, never hard-fail, when vendor assets are absent/corrupt — the
// wiki page stays fully lexically searchable, and the skip is recorded
// non-silently (never swallowed) rather than thrown.
test("reindex: soft-degrades when vendor assets are absent — lexical still indexes, vector embedding is skipped and recorded non-silently", async () => {
  const dataRoot = await temporaryRoot("data-no-vendor");
  const missingVendorRoot = await temporaryRoot("vendor-missing"); // no MANIFEST.json written
  const embedder = fakeEmbedder();
  const content = "# Title\n\nA paragraph with enough distinctive words for the soft-degrade test case here.\n";
  const result = await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(missingVendorRoot, embedder));
  assert.equal(result.embeddingsAvailable, false);
  assert.equal(result.unavailableReason, "MODEL_ASSET_MISSING");
  assert.equal(embedder.calls, 0, "the embedder must never be invoked once the vendor manifest itself fails to load");
  const lexical = await openLexicalIndex(path.join(dataRoot, "lexical"));
  assert.ok((await lexical.search("distinctive", 5)).length > 0, "the wiki page must still be lexically searchable");
  const { openVectorStore } = await import("../../dist/vector-store.js");
  const vectorStore = await openVectorStore(path.join(dataRoot, "vectors"), { modelId: "multilingual-e5-small-int8", modelRevision: "unknown", dims: 384 });
  const status = await vectorStore.status();
  assert.equal(status.embeddingsAvailable, false);
  assert.equal(status.unavailableReason, "MODEL_ASSET_MISSING");
});
