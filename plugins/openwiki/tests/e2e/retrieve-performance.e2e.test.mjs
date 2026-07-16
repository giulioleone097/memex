import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { dispatch } from "../../dist/adapter.js";
import { chunkMarkdown } from "../../dist/chunk.js";
import { defaultVendorRoot, loadEmbedder } from "../../dist/embedder.js";
import { openLexicalIndex } from "../../dist/lexical-index.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import { openVectorStore } from "../../dist/vector-store.js";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_DIR = join(PLUGIN_ROOT, "vendor", "model", "multilingual-e5-small-int8");
// The real vendored model ships chunked (model.onnx.part0/.part1, per PRD §16
// amendment 2) and the flat, unsplit "model.onnx" logical path never exists
// on disk (see embedder.ts's loadModelBuffer, which assembles parts in
// memory and never writes them back). Detect either shape — same fix as
// Task 5's embedder.test.mjs real-asset guard.
const MODEL_PRESENT = existsSync(join(MODEL_DIR, "model.onnx")) || existsSync(join(MODEL_DIR, "model.onnx.part0"));
const CHUNK_TARGET = 5_000;

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(join(os.tmpdir(), `openwiki-perf-${label}-`));
  roots.push(root);
  return root;
}

// dispatch() resolves its homeDir exclusively from process.env.HOME
// (adapter.ts's hostHomeDir(), no per-call override seam), but seedCorpus /
// the determinism fixture write directly to an isolated temp `home`
// directory's dataRoot. Without this, dispatch("search") would look under
// the *real* host home directory, where the corpus was never written, and
// silently return zero evidence regardless of correctness (confirmed: this
// exact gap made the p95 test fail on "evidence.length > 0" and made the
// determinism test pass vacuously — comparing two empty arrays, not two
// equal *real* result sets). Same fix as Task 11's retrieve-wiring.test.mjs.
async function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initGitRepo(root) {
  const run = (...args) => execFileAsync("git", args, { cwd: root });
  await run("init", "-q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "# fixture\n");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}

// Populates ~5,000 real embedded chunks directly against the lexical + vector
// stores (bypassing per-page writePage() calls, whose wiki-lock + per-call
// overhead would dominate the timing this test cares about: read-path
// latency, not write-path throughput — write-path timing is Task 10's/this
// same file's "incremental reindex" test below, which does go through the
// real writePage() for exactly one page, matching the PRD target's wording).
async function seedCorpus(dataRoot, embedder) {
  const lexicalIndex = await openLexicalIndex(join(dataRoot, "lexical"));
  const vectorStore = await openVectorStore(join(dataRoot, "vectors"), { modelId: embedder.modelId, modelRevision: "perf-fixture", dims: embedder.dims });
  const BATCH = 100;
  for (let batchStart = 0; batchStart < CHUNK_TARGET; batchStart += BATCH) {
    const texts = [];
    const refs = [];
    for (let index = batchStart; index < Math.min(batchStart + BATCH, CHUNK_TARGET); index += 1) {
      const text = `Synthetic passage number ${String(index)} about catalog architecture, retrieval fusion, and graph proximity ranking.`;
      const [ref] = chunkMarkdown(`fixtures/passage-${String(index)}.md`, `# Passage ${String(index)}\n\n${text}\n`);
      texts.push(text);
      refs.push({ ref, text });
    }
    await lexicalIndex.upsert(refs);
    const vectors = await embedder.embedPassages(texts);
    await vectorStore.upsert(refs.map(({ ref }, index) => ({ ref, vector: vectors[index] })));
  }
}

test("search/ask p95 < 1s @ 5k chunks including query embedding (asserted with 2x CI margin: < 2000ms)", { skip: !MODEL_PRESENT }, async (t) => {
  t.diagnostic(`chunk target: ${String(CHUNK_TARGET)}`);
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  await initGitRepo(root);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const embedder = await loadEmbedder(defaultVendorRoot());
  await seedCorpus(location.dataRoot, embedder);

  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    const startedAt = process.hrtime.bigint();
    const result = await withHome(home, () => dispatch({ operation: "search", input: { mode: "code", root, query: "catalog architecture retrieval fusion", limit: 10, signals: ["lexical", "vector"] } }));
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.equal(result.ok, true);
    assert.ok(result.data.evidence.length > 0);
    samples.push(elapsedMs);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  t.diagnostic(`search samples (ms): ${JSON.stringify(sorted)}`);
  assert.ok(p95 < 2000, `p95 ${String(p95)}ms exceeded the 2x-margin budget of 2000ms (target: <1000ms)`);
});

test("incremental reindex of one changed wiki page < 2s (asserted with 2x CI margin: < 4000ms)", { skip: !MODEL_PRESENT }, async () => {
  const root = await temporaryRoot("repo-incremental");
  const home = await temporaryRoot("home-incremental");
  await initGitRepo(root);
  const { initializeWiki, writePage } = await import("../../dist/wiki.js");
  await initializeWiki({ mode: "code", root, homeDir: home });

  const startedAt = process.hrtime.bigint();
  await writePage(
    await resolveWikiLocation({ mode: "code", root, homeDir: home }),
    "notes/perf.md",
    "# Performance note\n\nA short changed page used to measure incremental reindex latency end to end.\n",
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  assert.ok(elapsedMs < 4000, `incremental reindex took ${String(elapsedMs)}ms, exceeding the 2x-margin budget of 4000ms (target: <2000ms)`);
});

test("full build of this repository < 60s (asserted with 2x CI margin: < 120000ms)", { skip: !MODEL_PRESENT }, async () => {
  const { buildGraph } = await import("../../dist/graph.js");
  const startedAt = process.hrtime.bigint();
  const result = await buildGraph({ root: PLUGIN_ROOT, homeDir: await mkdtemp(join(os.tmpdir(), "openwiki-perf-fullbuild-home-")), force: true });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  assert.ok(result.nodeCount > 0);
  assert.ok(elapsedMs < 120_000, `full build took ${String(elapsedMs)}ms, exceeding the 2x-margin budget of 120000ms (target: <60000ms)`);
});

test("determinism: the same store and query return the same result ids in the same order, twice", { skip: !MODEL_PRESENT }, async () => {
  const root = await temporaryRoot("repo-determinism");
  const home = await temporaryRoot("home-determinism");
  await initGitRepo(root);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const embedder = await loadEmbedder(defaultVendorRoot());
  const lexicalIndex = await openLexicalIndex(join(location.dataRoot, "lexical"));
  const vectorStore = await openVectorStore(join(location.dataRoot, "vectors"), { modelId: embedder.modelId, modelRevision: "determinism-fixture", dims: embedder.dims });
  const passages = ["catalog architecture overview", "retrieval fusion internals", "unrelated topic about weather"];
  const refs = passages.map((text, index) => ({ ref: chunkMarkdown(`fixtures/d-${String(index)}.md`, `# D${String(index)}\n\n${text}\n`)[0], text }));
  await lexicalIndex.upsert(refs);
  await vectorStore.upsert((await Promise.all(refs.map(({ text }) => embedder.embedPassages([text])))).map((vectors, index) => ({ ref: refs[index].ref, vector: vectors[0] })));

  const runOnce = () => withHome(home, () => dispatch({ operation: "search", input: { mode: "code", root, query: "catalog architecture retrieval", limit: 5, signals: ["lexical", "vector"] } }));
  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(first.data.evidence.length > 0, "the determinism check must compare real, non-empty result sets, not two vacuously equal empty arrays");
  assert.deepEqual(first.data.evidence.map((item) => item.ref.id), second.data.evidence.map((item) => item.ref.id));
});
