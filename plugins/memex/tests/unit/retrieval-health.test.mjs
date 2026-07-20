import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { readRetrievalHealth, RETRIEVAL_HEALTH_SCHEMA } from "../../dist/retrieval-health.js";
import { openLexicalIndex } from "../../dist/lexical-index.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import { openVectorStore } from "../../dist/vector-store.js";
import { initializeWiki } from "../../dist/wiki.js";

const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-health-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const REF = {
  id: "a".repeat(64),
  plane: "wiki",
  path: "architecture.md",
  startLine: 1,
  endLine: 2,
  contentHash: "b".repeat(64),
};

async function writeVendor(vendorRoot, { modelId = "health-model", revision = "rev-1", corrupt = false } = {}) {
  const relative = path.join("model", modelId, "model.bin");
  const body = Buffer.from("verified model fixture", "utf8");
  await mkdir(path.join(vendorRoot, "model", modelId), { recursive: true });
  await writeFile(path.join(vendorRoot, relative), body);
  await writeFile(path.join(vendorRoot, "MANIFEST.json"), JSON.stringify({
    assets: [{
      path: relative,
      sha256: corrupt ? "0".repeat(64) : createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
      license: "MIT",
      upstream: "fixture",
      revision,
    }],
  }));
}

async function initializedPersonal(label, model = { modelId: "health-model", modelRevision: "rev-1", dims: 4 }) {
  const home = await temporaryRoot(`${label}-home`);
  const vendorRoot = await temporaryRoot(`${label}-vendor`);
  await writeVendor(vendorRoot, { modelId: model.modelId, revision: model.modelRevision });
  await initializeWiki({ mode: "personal", homeDir: home, now: "2026-07-20T00:00:00.000Z", runId: `${label}-init` });
  const location = await resolveWikiLocation({ mode: "personal", homeDir: home });
  await (await openLexicalIndex(path.join(location.dataRoot, "lexical"))).upsert([{ ref: REF, text: "health retrieval fixture" }]);
  await (await openVectorStore(path.join(location.dataRoot, "vectors"), model)).upsert([{ ref: REF, vector: Float32Array.from([1, 0, 0, 0]) }]);
  return { home, vendorRoot, location };
}

test("retrieval health is truthful and keeps proof layers distinct when indexes are empty", async () => {
  const home = await temporaryRoot("home");
  await initializeWiki({ mode: "personal", homeDir: home, now: "2026-07-20T00:00:00.000Z", runId: "health-init" });
  const location = await resolveWikiLocation({ mode: "personal", homeDir: home });
  const health = await readRetrievalHealth(location, {
    now: "2026-07-20T00:00:01.000Z",
    lastUpdate: { noOp: true, graphGenerated: false, reembedded: false },
  });

  assert.equal(health.schema, RETRIEVAL_HEALTH_SCHEMA);
  assert.equal(health.ready, false);
  assert.equal(health.coverage.expected, 0);
  assert.equal(health.coverage.indexed, 0);
  assert.equal(health.identity.wikiHash === null, false);
  assert.equal(health.graphGeneration, null);
  assert.ok(Object.hasOwn(health, "modelRevision"));
  assert.equal(health.lastError === null, false);
  assert.equal(health.proofLayers.source.status, "proven");
  assert.equal(health.proofLayers.installedCache.status, "failed");
  assert.equal(health.proofLayers.liveCall.status, "failed");
  assert.deepEqual(health.lastUpdate, { noOp: true, graphGenerated: false, reembedded: false });
  assert.ok(Array.isArray(health.benchmarkFailures.byCategory.liveCall));
  assert.ok(Array.isArray(health.benchmarkFailures.bySignal.lexical));
  assert.ok(health.benchmarkFailures.details.bySignal.lexical[0].input.signal === "lexical");
  assert.ok(health.recovery.required);
});

test("retrieval health performs no directory creation when every private cache is absent", async () => {
  const home = await temporaryRoot("read-only-home");
  const vendorRoot = path.join(home, "missing-vendor");
  const location = await resolveWikiLocation({ mode: "personal", homeDir: home });
  const health = await readRetrievalHealth(location, { vendorRoot, now: "2026-07-20T00:00:00.000Z" });
  assert.equal(health.ready, false);
  await assert.rejects(stat(location.dataRoot), { code: "ENOENT" });
  await assert.rejects(stat(vendorRoot), { code: "ENOENT" });
});

test("retrieval health becomes ready only after source, real indexes, registry, host, and live proofs pass", async () => {
  const { location, vendorRoot } = await initializedPersonal("ready");
  const health = await readRetrievalHealth(location, { vendorRoot, now: "2026-07-20T00:00:00.000Z" });
  assert.equal(health.ready, true, JSON.stringify(health));
  assert.equal(health.identity.repositoryIdentity, "memex:personal");
  assert.equal(health.identity.hostLocalStorageKey, "personal");
  assert.equal(health.coverage.lexical.ready, true);
  assert.equal(health.coverage.vector.ready, true);
  assert.equal(health.modelId, "health-model");
  assert.equal(health.modelRevision, "rev-1");
  assert.equal(health.lastError, null);
});

test("retrieval health opens real lexical/vector stores and rejects corrupt vector data", async () => {
  const { location, vendorRoot } = await initializedPersonal("corrupt-vector");
  await writeFile(path.join(location.dataRoot, "vectors", "segments", "b.bin"), Buffer.from("corrupt"));
  const health = await readRetrievalHealth(location, { vendorRoot, now: "2026-07-20T00:00:00.000Z" });
  assert.equal(health.ready, false);
  assert.ok(health.benchmarkFailures.bySignal.vector.includes("VECTOR_CACHE_READ_FAILED"));
});

test("retrieval health rejects a corrupt graph without repairing or replacing it", async () => {
  const root = await temporaryRoot("corrupt-graph-repo");
  const home = await temporaryRoot("corrupt-graph-home");
  const vendorRoot = await temporaryRoot("corrupt-graph-vendor");
  await writeVendor(vendorRoot);
  await initializeWiki({ mode: "code", root, homeDir: home, now: "2026-07-20T00:00:00.000Z", runId: "graph-init" });
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const manifestPath = path.join(location.dataRoot, "graph", "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, "{not-json");
  const health = await readRetrievalHealth(location, {
    projectScope: "git:example.test/org/repo",
    vendorRoot,
    now: "2026-07-20T00:00:00.000Z",
  });
  assert.equal(health.ready, false);
  assert.ok(health.benchmarkFailures.bySignal.graph.includes("GRAPH_CACHE_READ_FAILED"));
  assert.equal(await readFile(manifestPath, "utf8"), "{not-json");
});

test("retrieval health verifies vendor checksums and rejects model identity mismatch", async () => {
  const mismatch = await initializedPersonal("model-mismatch", { modelId: "vector-model", modelRevision: "rev-1", dims: 4 });
  await writeVendor(mismatch.vendorRoot, { modelId: "registry-model", revision: "rev-1" });
  const mismatched = await readRetrievalHealth(mismatch.location, { vendorRoot: mismatch.vendorRoot, now: "2026-07-20T00:00:00.000Z" });
  assert.equal(mismatched.ready, false);
  assert.ok(mismatched.benchmarkFailures.byCategory.registry.includes("MODEL_ID_MISMATCH"));

  await writeVendor(mismatch.vendorRoot, { modelId: "vector-model", revision: "rev-1", corrupt: true });
  const corrupt = await readRetrievalHealth(mismatch.location, { vendorRoot: mismatch.vendorRoot, now: "2026-07-20T00:00:00.000Z" });
  assert.equal(corrupt.ready, false);
  assert.ok(corrupt.benchmarkFailures.byCategory.registry.includes("MODEL_REGISTRY_READ_FAILED"));
});

test("retrieval health treats changed wiki content as stale source evidence", async () => {
  const { location, vendorRoot } = await initializedPersonal("stale-wiki");
  await writeFile(path.join(location.wikiRoot, "architecture.md"), "# Changed after finalize\n");
  const health = await readRetrievalHealth(location, { vendorRoot, now: "2026-07-20T00:00:00.000Z" });
  assert.equal(health.ready, false);
  assert.equal(health.freshness.status, "stale");
  assert.ok(health.benchmarkFailures.byCategory.source.includes("WIKI_SOURCE_STALE"));
});
