import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadBenchmark,
  runBenchmark,
  validateDataset,
} from "../../scripts/memexbench.mjs";

test("MemexBench-Code v1 is frozen, stratified, and complete", async () => {
  const dataset = await loadBenchmark();
  assert.deepEqual(validateDataset(dataset), []);
  assert.equal(dataset.fixtures.length, 4);
  assert.equal(dataset.queries.length, 224);
  assert.equal(dataset.qrels.length, dataset.queries.length);
  assert.deepEqual(
    [...new Set(dataset.queries.map((query) => query.category))].sort(),
    ["change", "decision", "exact", "global", "impact", "semantic", "temporal"],
  );
  for (const split of ["train", "dev", "test"]) assert.ok(dataset.splits[split].length > 0, `${split} split is populated`);
  assert.equal(dataset.baseline.immutable, true);
  assert.match(dataset.baseline.splitsSha256, /^[a-f0-9]{64}$/u);

  const driftRoot = await mkdtemp(join(tmpdir(), "memexbench-splits-"));
  try {
    await cp(dataset.root, driftRoot, { recursive: true });
    const splitsPath = join(driftRoot, dataset.manifest.splits);
    await writeFile(splitsPath, `${await readFile(splitsPath, "utf8")}\n`, "utf8");
    const driftReport = await runBenchmark(await loadBenchmark(driftRoot));
    assert.equal(driftReport.gate.passed, false);
    assert.ok(driftReport.gate.failures.includes("splitsSha256 differs from immutable baseline"));
  } finally {
    await rm(driftRoot, { recursive: true, force: true });
  }
});

test("MemexBench-Code v1 runs every signal and strategy ablation on the same queries", async () => {
  const dataset = await loadBenchmark();
  const report = await runBenchmark(dataset);
  assert.equal(report.schema, "memexbench.raw-result.v1");
  assert.equal(report.gate.passed, true, report.gate.failures.join("; "));
  assert.equal(report.queries, 224);
  assert.equal(report.categories, 7);
  assert.equal(report.results.length, 224 * 4 * 4);
  assert.equal(Object.keys(report.metrics.byConfiguration).length, 16);
  assert.ok(report.metrics.indexSizeBytes > 0);
  assert.ok(report.metrics.updateCostMs >= 0);
  assert.equal(report.metrics.modelRevision, "memexbench-vector-v1");
  assert.equal(report.fingerprints.splitsSha256, dataset.baseline.splitsSha256);
  assert.ok(report.metrics.quality.duplicateRate >= 0);
  assert.ok(report.metrics.quality.staleRate >= 0);
  assert.ok(report.metrics.quality.unsupportedRate >= 0);
  assert.ok(report.metrics.quality.unresolvedEdgeRate >= 0);
  assert.deepEqual(report.metrics.evidenceIdentity, {
    total: 29,
    unique: 28,
    duplicateRate: 1 / 29,
  });
  assert.equal(report.metrics.quality.duplicateRate, report.metrics.evidenceIdentity.duplicateRate);
  assert.match(report.results[0].hits[0].evidenceId, /^ev1:[a-f0-9]{64}$/u);
  assert.equal(report.results[0].hits[0].provenance.projectScope, report.results[0].hits[0].provenance.projectScope.trim());
  assert.equal(report.metrics.noVector.deterministic, true);
  assert.equal(report.metrics.noVector.queryCount, 224);
  assert.match(report.metrics.noVector.fingerprintSha256, /^[a-f0-9]{64}$/u);
  assert.ok(report.metrics.noVector.minimumRecallAt5 >= 0.8);
  assert.deepEqual(Object.keys(report.metrics.byCategory).sort(), ["change", "decision", "exact", "global", "impact", "semantic", "temporal"]);
  assert.deepEqual(Object.keys(report.metrics.bySignal).sort(), ["graph", "hybrid", "lexical", "vector"]);
  assert.deepEqual(Object.keys(report.gate.failuresByCategory).sort(), ["change", "decision", "exact", "global", "impact", "semantic", "temporal"]);
  assert.deepEqual(Object.keys(report.gate.failuresBySignal).sort(), ["graph", "hybrid", "lexical", "vector"]);
  assert.ok(Math.min(...Object.values(report.metrics.byConfiguration).map((value) => value.recallAt5)) >= 0.8);
  const lexicalRanks = new Map(report.results.filter((result) => result.signal === "lexical" && result.strategy === "rrf").map((result) => [result.queryId, result.hits.map((hit) => hit.evidenceId)]));
  const graphRanks = report.results.filter((result) => result.signal === "graph" && result.strategy === "rrf");
  assert.ok(graphRanks.some((result) => JSON.stringify(result.hits.map((hit) => hit.evidenceId)) !== JSON.stringify(lexicalRanks.get(result.queryId))), "graph ablation must not be a lexical all-document clone");

  const breakdownDataset = await loadBenchmark();
  breakdownDataset.baseline = { ...breakdownDataset.baseline, minimumRecallAt5: 0.9 };
  const breakdownReport = await runBenchmark(breakdownDataset);
  assert.ok(Math.min(...Object.values(breakdownReport.metrics.byConfiguration).map((value) => value.recallAt5)) >= 0.9);
  assert.equal(breakdownReport.gate.passed, false, "a category failure must make the gate fail even when aggregate configurations pass");
  assert.ok(breakdownReport.gate.failuresByCategory.exact.length > 0);
  assert.ok(breakdownReport.gate.failures.some((failure) => failure.startsWith("category exact:")));
});

test("MemexBench no-vector mode is explicit and excludes vector retrieval", async () => {
  const dataset = await loadBenchmark();
  const report = await runBenchmark(dataset, { vectorEnabled: false });
  assert.equal(report.gate.passed, true, report.gate.failures.join("; "));
  assert.equal(report.results.length, 224 * 3 * 4);
  assert.equal(report.results.some((result) => result.signal === "vector"), false);
  assert.equal(report.metrics.noVector.deterministic, true);
  assert.equal(report.metrics.noVector.fingerprintSha256, (await runBenchmark(dataset, { vectorEnabled: false })).metrics.noVector.fingerprintSha256);
});
