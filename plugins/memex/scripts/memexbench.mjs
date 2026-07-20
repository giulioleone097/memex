#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = resolve(SCRIPT_ROOT, "../benchmarks/memexbench-code-v1");
const SIGNALS = ["lexical", "vector", "graph", "hybrid"];
const NO_VECTOR_SIGNALS = ["lexical", "graph", "hybrid"];
const STRATEGIES = ["rrf", "lexical-first", "vector-first", "graph-first"];
const GRAPH_TEXT_SEED_LIMIT = 50;
const TOKEN_RE = /[A-Za-z0-9_]+/gu;
const VECTOR_DIMS = 64;
const LEXICAL_CONCEPTS = new Map([
  ["affect", "impact"],
  ["affected", "impact"],
  ["blast", "impact"],
  ["consume", "impact"],
  ["consumer", "impact"],
  ["dependency", "impact"],
  ["downstream", "impact"],
  ["radius", "impact"],
  ["meaning", "policy"],
  ["decision", "policy"],
  ["proximity", "neighbor"],
  ["rank", "fusion"],
  ["search", "retrieval"],
  ["signal", "fusion"],
]);

function tokens(value) {
  return String(value).toLocaleLowerCase("en-US").match(TOKEN_RE) ?? [];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonLines(path) {
  const text = (await readFile(path, "utf8")).trim();
  return text === "" ? [] : text.split(/\r?\n/u).map((line) => JSON.parse(line));
}

function hashToken(token) {
  const digest = createHash("sha256").update(token).digest();
  return digest.readUInt32BE(0);
}

function vectorize(value) {
  const vector = Array.from({ length: VECTOR_DIMS }, () => 0);
  for (const token of tokens(value)) {
    const hash = hashToken(token);
    vector[hash % VECTOR_DIMS] += 1;
    vector[(hash >>> 8) % VECTOR_DIMS] += 0.25;
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return norm === 0 ? vector : vector.map((item) => item / norm);
}

function cosine(left, right) {
  return left.reduce((sum, item, index) => sum + item * (right[index] ?? 0), 0);
}

function documentText(document) {
  return `${document.title} ${document.text}`;
}

function lexicalStem(token) {
  if (token === "auth") return "authorization";
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function lexicalTokens(value) {
  return tokens(value).map((token) => {
    const stem = lexicalStem(token);
    return LEXICAL_CONCEPTS.get(stem) ?? stem;
  });
}

function lexicalDocumentText(document) {
  return `${documentText(document)} ${document.citation ?? ""} ${document.nodeId ?? ""}`;
}

function excerptBoundaries(citation) {
  const match = String(citation ?? "").match(/#L(\d+)(?:-L?(\d+))?/u);
  return {
    startLine: match === null ? null : Number(match[1]),
    endLine: match === null ? null : Number(match[2] ?? match[1]),
  };
}

function projectScope(fixtureId, document) {
  return document.projectScope ?? fixtureId;
}

function sourceIdentity(document) {
  return document.sourceIdentity ?? document.sourceId ?? document.nodeId ?? document.id;
}

function evidenceId(fixtureId, document) {
  const boundaries = excerptBoundaries(document.citation);
  const sourceId = sourceIdentity(document);
  const contentHash = sha256(documentText(document));
  const tuple = ["ev1", projectScope(fixtureId, document), sourceId, contentHash, String(boundaries.startLine ?? 1), String(boundaries.endLine ?? boundaries.startLine ?? 1)];
  const encoded = tuple.map((part) => `${String(part.length)}:${part}`).join("");
  return `ev1:${sha256(encoded)}`;
}

function lexicalScore(query, document) {
  const queryTokens = lexicalTokens(query);
  const documentTokens = new Set(lexicalTokens(lexicalDocumentText(document)));
  let overlap = 0;
  for (const token of queryTokens) if (documentTokens.has(token)) overlap += 1;
  const phrase = documentText(document).toLocaleLowerCase("en-US").includes(String(query).toLocaleLowerCase("en-US"));
  return overlap / Math.max(queryTokens.length, 1) + (phrase ? 1 : 0);
}

function sortedEntries(scores) {
  return [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function buildIndexes(fixtures) {
  const documents = new Map();
  const documentKeyByNode = new Map();
  const adjacency = new Map();
  const edges = [];
  for (const fixture of fixtures) {
    for (const document of fixture.documents) {
      const evidence = evidenceId(fixture.fixtureId, document);
      const sourceId = sourceIdentity(document);
      const boundaries = excerptBoundaries(document.citation);
      const key = `${fixture.fixtureId}/${document.id}`;
      documents.set(key, {
        ...document,
        fixture: fixture.fixtureId,
        key: `${fixture.fixtureId}/${document.id}`,
        projectScope: projectScope(fixture.fixtureId, document),
        sourceId,
        evidenceId: evidence,
        dedupeEvidenceId: document.evidenceId ?? evidence,
        contentHash: sha256(documentText(document)),
        excerpt: boundaries,
        terms: new Set(tokens(documentText(document))),
        vector: vectorize(documentText(document)),
      });
      if (document.nodeId !== undefined) documentKeyByNode.set(`${fixture.fixtureId}/${document.nodeId}`, key);
    }
    for (const edge of fixture.edges) {
      edges.push({ ...edge, fixture: fixture.fixtureId });
      if (!edge.resolved) continue;
      const from = documentKeyByNode.get(`${fixture.fixtureId}/${edge.from}`) ?? `${fixture.fixtureId}/${edge.from}`;
      const to = documentKeyByNode.get(`${fixture.fixtureId}/${edge.to}`) ?? `${fixture.fixtureId}/${edge.to}`;
      const fromNeighbors = adjacency.get(from) ?? [];
      const toNeighbors = adjacency.get(to) ?? [];
      fromNeighbors.push(to);
      toNeighbors.push(from);
      adjacency.set(from, fromNeighbors);
      adjacency.set(to, toNeighbors);
    }
  }
  for (const document of documents.values()) {
    if (document.duplicateOf === undefined || document.duplicateOf === null) continue;
    const priorKey = `${document.fixture}/${document.duplicateOf}`;
    const prior = documents.get(priorKey);
    if (prior === undefined) continue;
    // `evidenceId` remains content-versioned; an explicit duplicate relation
    // provides the stable identity used to collapse equivalent top-k hits and
    // records the prior source identity for provenance.
    document.dedupeEvidenceId = prior.dedupeEvidenceId;
    document.previousEvidenceId = prior.evidenceId;
  }
  return { documents, adjacency, edges };
}

function signalScores(query, fixtureId, indexes, signal, vectorEnabled = true) {
  const documents = [...indexes.documents.values()].filter((document) => document.fixture === fixtureId);
  const lexical = new Map(documents.map((document) => [document.key, lexicalScore(query.query, document)]));
  if (signal === "lexical") return lexical;
  if (signal === "vector") {
    const queryVector = vectorize(query.query);
    return new Map(documents.map((document) => [document.key, cosine(queryVector, document.vector)]));
  }
  if (signal === "graph") {
    const scores = new Map();
    const seedRanks = new Map();
    const queryVector = vectorEnabled ? vectorize(query.query) : undefined;
    const seedSignals = vectorEnabled
      ? [lexical, new Map(documents.map((document) => [document.key, cosine(queryVector, document.vector)]))]
      : [lexical];
    for (const signalMap of seedSignals) {
      sortedEntries(signalMap).forEach(([key], index) => {
        seedRanks.set(key, (seedRanks.get(key) ?? 0) + 1 / (60 + index + 1));
      });
    }
    // Production bounds graph text seeds and starts from ranked lexical/vector
    // candidates. The benchmark uses the query top-k under the same fixed cap
    // so its small fixtures cannot silently seed every document.
    const seedLimit = Math.min(query.topK ?? 5, GRAPH_TEXT_SEED_LIMIT);
    for (const [key, score] of sortedEntries(seedRanks).slice(0, seedLimit)) {
      scores.set(key, Math.max(scores.get(key) ?? 0, 1 + score));
      const neighbors = indexes.adjacency.get(key) ?? [];
      for (const neighbor of neighbors) scores.set(neighbor, Math.max(scores.get(neighbor) ?? 0, 0.7 + score * 0.2));
      for (const second of neighbors) {
        for (const neighbor of indexes.adjacency.get(second) ?? []) {
          scores.set(neighbor, Math.max(scores.get(neighbor) ?? 0, 0.4 + score * 0.1));
        }
      }
    }
    return scores;
  }
  throw new Error(`Unknown signal: ${signal}`);
}

function strategyWeights(strategy) {
  if (strategy === "lexical-first") return { lexical: 0.6, vector: 0.25, graph: 0.15 };
  if (strategy === "vector-first") return { lexical: 0.2, vector: 0.6, graph: 0.2 };
  if (strategy === "graph-first") return { lexical: 0.2, vector: 0.2, graph: 0.6 };
  return { lexical: 1, vector: 1, graph: 1 };
}

function rank(query, fixtureId, indexes, signal, strategy, topK, vectorEnabled = true) {
  if (signal === "vector" && !vectorEnabled) return [];
  const selected = signal === "hybrid"
    ? (vectorEnabled ? ["lexical", "vector", "graph"] : ["lexical", "graph"])
    : [signal];
  const scoreMaps = new Map(selected.map((name) => [name, signalScores(query, fixtureId, indexes, name, vectorEnabled)]));
  const allKeys = new Set();
  for (const scoreMap of scoreMaps.values()) for (const key of scoreMap.keys()) allKeys.add(key);
  const weights = strategyWeights(strategy);
  const combined = new Map();
  const rankSignals = new Map();
  for (const key of allKeys) {
    let score = 0;
    const present = [];
    for (const name of selected) {
      const entries = sortedEntries(scoreMaps.get(name) ?? []);
      const position = entries.findIndex(([entryKey]) => entryKey === key);
      if (position === -1) continue;
      present.push(name);
      score += strategy === "rrf" ? 1 / (60 + position + 1) : (weights[name] ?? 0) * (entries[position][1] ?? 0);
    }
    combined.set(key, score);
    rankSignals.set(key, present);
  }
  const seenEvidence = new Set();
  const hits = [];
  for (const [key, score] of sortedEntries(combined)) {
    const document = indexes.documents.get(key);
    const identity = document?.dedupeEvidenceId ?? document?.evidenceId ?? key;
    if (seenEvidence.has(identity)) continue;
    seenEvidence.add(identity);
    hits.push({
      citation: document?.citation ?? key,
      evidenceId: document?.evidenceId ?? identity,
      score,
      rank: hits.length + 1,
      signals: rankSignals.get(key) ?? [],
      provenance: {
        projectScope: document?.projectScope,
        sourceIdentity: document?.sourceIdentity ?? document?.sourceId ?? document?.nodeId ?? document?.id,
        contentHash: document?.contentHash,
        startLine: document?.excerpt.startLine,
        endLine: document?.excerpt.endLine,
        ...(document?.previousEvidenceId === undefined ? {} : { priorEvidenceId: document.previousEvidenceId }),
      },
    });
    if (hits.length >= topK) break;
  }
  return hits;
}

function qualityRates(fixtures, indexes) {
  const documents = [...indexes.documents.values()];
  const evidenceGroups = new Map();
  for (const document of documents) {
    const identity = document.dedupeEvidenceId ?? document.evidenceId ?? document.key;
    const group = evidenceGroups.get(identity) ?? [];
    group.push(document.key);
    evidenceGroups.set(identity, group);
  }
  const duplicateEvidenceCount = [...evidenceGroups.values()]
    .reduce((count, group) => count + Math.max(group.length - 1, 0), 0);
  const duplicateEvidenceGroups = [...evidenceGroups.values()].filter((group) => group.length > 1);
  const edges = indexes.edges;
  return {
    duplicateRate: duplicateEvidenceCount / Math.max(documents.length, 1),
    duplicateEvidenceRate: duplicateEvidenceCount / Math.max(documents.length, 1),
    duplicateEvidenceCount,
    duplicateEvidenceGroups: duplicateEvidenceGroups.length,
    staleRate: documents.filter((document) => document.stale === true).length / Math.max(documents.length, 1),
    unsupportedRate: documents.filter((document) => document.support === "unsupported").length / Math.max(documents.length, 1),
    unresolvedEdgeRate: edges.filter((edge) => edge.resolved !== true).length / Math.max(edges.length, 1),
    fixtureCount: fixtures.length,
    documentCount: documents.length,
    edgeCount: edges.length,
  };
}

function scoreResults(results, relevant) {
  let hit = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  for (const result of results) {
    const expected = relevant.get(result.queryId) ?? new Set();
    const rank = result.hits.findIndex((item) => expected.has(item.citation));
    if (rank !== -1) {
      hit += 1;
      reciprocalRank += 1 / (rank + 1);
      ndcg += 1 / Math.log2(rank + 2);
    }
  }
  return {
    queryCount: new Set(results.map((result) => result.queryId)).size,
    recallAt5: hit / Math.max(results.length, 1),
    mrr: reciprocalRank / Math.max(results.length, 1),
    ndcgAt5: ndcg / Math.max(results.length, 1),
    coldLatencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0) / Math.max(results.length, 1),
    tokenCount: results.reduce((sum, result) => sum + result.tokens, 0),
  };
}

function retrievalMetrics(queries, qrels, runResults, minimumRecallAt5 = 0.8) {
  const relevant = new Map(qrels.map((qrel) => [qrel.queryId, new Set(qrel.expectedCitations)]));
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const grouped = new Map();
  for (const result of runResults) {
    const key = `${result.signal}/${result.strategy}`;
    const group = grouped.get(key) ?? [];
    group.push(result);
    grouped.set(key, group);
  }
  const byConfiguration = {};
  for (const [key, results] of grouped) {
    byConfiguration[key] = scoreResults(results, relevant);
  }
  const bySignal = {};
  for (const signal of SIGNALS) {
    const byStrategy = {};
    for (const strategy of STRATEGIES) {
      const results = runResults.filter((result) => result.signal === signal && result.strategy === strategy);
      if (results.length > 0) byStrategy[strategy] = scoreResults(results, relevant);
    }
    const canonical = byStrategy.rrf ?? Object.values(byStrategy)[0] ?? scoreResults([], relevant);
    bySignal[signal] = { ...canonical, byStrategy };
  }
  const categories = [...new Set(queries.map((query) => query.category))].sort();
  const byCategory = {};
  for (const category of categories) {
    const bySignalForCategory = {};
    for (const signal of SIGNALS) {
      const results = runResults.filter((result) => {
        const query = queryById.get(result.queryId);
        return query?.category === category && query?.category !== undefined && result.signal === signal && result.strategy === "rrf";
      });
      if (results.length > 0) bySignalForCategory[signal] = scoreResults(results, relevant);
    }
    const canonical = bySignalForCategory.hybrid ?? Object.values(bySignalForCategory)[0] ?? scoreResults([], relevant);
    byCategory[category] = { ...canonical, bySignal: bySignalForCategory };
  }
  const failuresByCategory = Object.fromEntries(categories.map((category) => [category, []]));
  for (const [category, value] of Object.entries(byCategory)) {
    for (const [signal, signalValue] of Object.entries(value.bySignal)) {
      if (signalValue.recallAt5 < minimumRecallAt5) {
        failuresByCategory[category].push(`${signal}/rrf recallAt5 ${signalValue.recallAt5.toFixed(3)} < ${minimumRecallAt5.toFixed(3)}`);
      }
    }
  }
  const failuresBySignal = Object.fromEntries(SIGNALS.map((signal) => [signal, []]));
  for (const [signal, value] of Object.entries(bySignal)) {
    for (const [strategy, strategyValue] of Object.entries(value.byStrategy)) {
      if (strategyValue.recallAt5 < minimumRecallAt5) {
        failuresBySignal[signal].push(`${strategy} recallAt5 ${strategyValue.recallAt5.toFixed(3)} < ${minimumRecallAt5.toFixed(3)}`);
      }
    }
  }
  return { byConfiguration, byCategory, bySignal, failuresByCategory, failuresBySignal, queryCount: queries.length };
}

function parseArgs(argv) {
  const options = { check: false, noVector: false, output: undefined, root: BENCHMARK_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--no-vector") options.noVector = true;
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else if (argument === "--root") options.root = resolve(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function loadBenchmark(root = BENCHMARK_ROOT) {
  const manifestPath = join(root, "manifest.json");
  const manifest = await readJson(manifestPath);
  const fixtures = await Promise.all(manifest.fixtures.map((fixture) => readJson(join(root, fixture))));
  const queries = await readJsonLines(join(root, manifest.queries));
  const qrels = await readJsonLines(join(root, manifest.qrels));
  const splits = await readJson(join(root, manifest.splits));
  const baseline = await readJson(join(root, manifest.baseline));
  const indexes = buildIndexes(fixtures);
  return { root, manifest, fixtures, queries, qrels, splits, baseline, indexes };
}

export function validateDataset(dataset) {
  const { manifest, fixtures, queries, qrels, splits, indexes } = dataset;
  const failures = [];
  if (fixtures.length < manifest.gates.minFixtures) failures.push(`fixtures=${fixtures.length} < ${manifest.gates.minFixtures}`);
  if (queries.length < manifest.gates.minQueries) failures.push(`queries=${queries.length} < ${manifest.gates.minQueries}`);
  if (manifest.queryCount !== queries.length) failures.push(`manifest queryCount=${manifest.queryCount} differs from queries=${queries.length}`);
  if (manifest.benchmark !== dataset.baseline.benchmark) failures.push("baseline benchmark does not match manifest");
  if (manifest.revision !== dataset.baseline.revision) failures.push("baseline revision does not match manifest");
  const categories = new Set(queries.map((query) => query.category));
  if (categories.size < manifest.gates.minCategories) failures.push(`categories=${categories.size} < ${manifest.gates.minCategories}`);
  if (new Set(queries.map((query) => query.id)).size !== queries.length) failures.push("query ids are not unique");
  const qrelIds = new Set(qrels.map((qrel) => qrel.queryId));
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const splitIds = [...splits.train, ...splits.dev, ...splits.test];
  if (new Set(splitIds).size !== splitIds.length) failures.push("frozen splits contain duplicate ids");
  if (splitIds.length !== queries.length || splitIds.some((id) => !queryById.has(id))) failures.push("frozen splits do not cover exactly the query ids");
  for (const query of queries) {
    if (!qrelIds.has(query.id)) failures.push(`missing qrel for ${query.id}`);
    const split = splits[query.split];
    if (!Array.isArray(split) || !split.includes(query.id)) failures.push(`query ${query.id} is not frozen in ${query.split}`);
  }
  const citationsByFixture = new Map();
  for (const document of indexes.documents.values()) {
    const citations = citationsByFixture.get(document.fixture) ?? new Set();
    citations.add(document.citation);
    citationsByFixture.set(document.fixture, citations);
  }
  for (const qrel of qrels) {
    const query = queryById.get(qrel.queryId);
    const citations = citationsByFixture.get(query?.fixture) ?? new Set();
    for (const citation of qrel.expectedCitations) if (!citations.has(citation)) failures.push(`unknown expected citation ${citation} for ${qrel.queryId}`);
  }
  if (qrels.length !== queries.length) failures.push(`qrels=${qrels.length} differs from queries=${queries.length}`);
  return failures;
}

function fingerprint(dataset) {
  const read = (relativePath) => readFile(join(dataset.root, relativePath));
  return Promise.all([read("manifest.json"), read(dataset.manifest.queries), read(dataset.manifest.qrels), read(dataset.manifest.splits)]).then(([manifest, queries, qrels, splits]) => ({
    manifestSha256: sha256(manifest),
    queriesSha256: sha256(queries),
    qrelsSha256: sha256(qrels),
    splitsSha256: sha256(splits),
    corpusSha256: sha256(JSON.stringify(dataset.fixtures)),
  }));
}

async function runRetrieval(dataset, vectorEnabled) {
  const signals = vectorEnabled ? SIGNALS : NO_VECTOR_SIGNALS;
  const results = [];
  const timing = {};
  for (const signal of signals) {
    for (const strategy of STRATEGIES) {
      const key = `${signal}/${strategy}`;
      const coldStart = performance.now();
      for (const query of dataset.queries) {
        const queryStart = performance.now();
        const hits = rank(query, query.fixture, dataset.indexes, signal, strategy, dataset.manifest.topK, vectorEnabled);
        results.push({ queryId: query.id, signal, strategy, latencyMs: Number((performance.now() - queryStart).toFixed(4)), tokens: tokens(query.query).length, hits });
      }
      const coldLatencyMs = performance.now() - coldStart;
      const warmStart = performance.now();
      for (let pass = 0; pass < 2; pass += 1) {
        for (const query of dataset.queries) rank(query, query.fixture, dataset.indexes, signal, strategy, dataset.manifest.topK, vectorEnabled);
      }
      const warmLatencyMs = (performance.now() - warmStart) / 2;
      timing[key] = { coldLatencyMs: Number(coldLatencyMs.toFixed(4)), warmLatencyMs: Number(warmLatencyMs.toFixed(4)) };
    }
  }
  return { results, timing };
}

function stableResultsFingerprint(results) {
  const stable = results.map((result) => ({
    queryId: result.queryId,
    signal: result.signal,
    strategy: result.strategy,
    hits: result.hits.map((hit) => ({
      citation: hit.citation,
      evidenceId: hit.evidenceId,
      score: hit.score,
      rank: hit.rank,
      signals: hit.signals,
    })),
  }));
  return sha256(JSON.stringify(stable));
}

function evidenceIdentityMetrics(indexes) {
  const identities = [...indexes.documents.values()].map((document) => document.dedupeEvidenceId ?? document.evidenceId ?? document.key);
  const unique = new Set(identities).size;
  return {
    total: identities.length,
    unique,
    duplicateRate: (identities.length - unique) / Math.max(identities.length, 1),
  };
}

export async function runBenchmark(dataset, options = {}) {
  const datasetFailures = validateDataset(dataset);
  if (datasetFailures.length > 0) throw new Error(`Dataset gate failed: ${datasetFailures.join("; ")}`);
  const startedAt = new Date().toISOString();
  const vectorEnabled = options.vectorEnabled !== false && options.noVector !== true;
  const retrievalRun = await runRetrieval(dataset, vectorEnabled);
  const { results, timing } = retrievalRun;
  const updateStart = performance.now();
  for (const fixture of dataset.fixtures) {
    const update = fixture.update;
    vectorize(`${update.citation} ${update.text}`);
    tokens(`${update.citation} ${update.text}`);
  }
  const updateCostMs = Number((performance.now() - updateStart).toFixed(4));
  const fingerprints = await fingerprint(dataset);
  const quality = qualityRates(dataset.fixtures, dataset.indexes);
  const minimumRecallBaseline = dataset.baseline.minimumRecallAt5 ?? 0;
  const retrieval = retrievalMetrics(dataset.queries, dataset.qrels, results, minimumRecallBaseline);
  for (const [key, value] of Object.entries(timing)) {
    retrieval.byConfiguration[key].coldLatencyMs = value.coldLatencyMs;
    retrieval.byConfiguration[key].warmLatencyMs = value.warmLatencyMs;
  }
  const noVectorFirst = vectorEnabled ? await runRetrieval(dataset, false) : retrievalRun;
  const noVectorSecond = vectorEnabled ? await runRetrieval(dataset, false) : retrievalRun;
  const noVectorFingerprint = stableResultsFingerprint(noVectorFirst.results);
  const noVectorRepeatFingerprint = stableResultsFingerprint(noVectorSecond.results);
  const noVectorMetrics = retrievalMetrics(dataset.queries, dataset.qrels, noVectorFirst.results, minimumRecallBaseline);
  const noVectorMinimumRecall = Math.min(...Object.values(noVectorMetrics.byConfiguration).map((value) => value.recallAt5));
  const metrics = {
    ...retrieval,
    quality,
    evidenceIdentity: evidenceIdentityMetrics(dataset.indexes),
    noVector: {
      deterministic: noVectorFingerprint === noVectorRepeatFingerprint,
      fingerprintSha256: noVectorFingerprint,
      queryCount: dataset.queries.length,
      minimumRecallAt5: noVectorMinimumRecall,
    },
    indexSizeBytes: Buffer.byteLength(JSON.stringify({ documents: [...dataset.indexes.documents.values()].map(({ terms, vector, ...document }) => document), edges: dataset.indexes.edges })),
    updateCostMs,
    tokenCount: dataset.queries.reduce((sum, query) => sum + tokens(query.query).length, 0),
    modelRevision: dataset.manifest.model.revision,
  };
  const minimumRecall = Math.min(...Object.values(metrics.byConfiguration).map((value) => value.recallAt5));
  const gateFailures = [];
  if (dataset.baseline.immutable !== true) gateFailures.push("baseline is not marked immutable");
  for (const name of ["manifestSha256", "queriesSha256", "qrelsSha256", "splitsSha256", "corpusSha256"]) {
    const expected = dataset.baseline[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) {
      gateFailures.push(`${name} is missing from immutable baseline`);
    } else if (expected !== fingerprints[name]) {
      gateFailures.push(`${name} differs from immutable baseline`);
    }
  }
  if (minimumRecall < (dataset.baseline.minimumRecallAt5 ?? 0)) gateFailures.push(`minimum recall@5 ${minimumRecall.toFixed(3)} below baseline ${(dataset.baseline.minimumRecallAt5 ?? 0).toFixed(3)}`);
  for (const [name, limit] of [["duplicateRate", dataset.manifest.gates.maxDuplicateRate], ["staleRate", dataset.manifest.gates.maxStaleRate], ["unsupportedRate", dataset.manifest.gates.maxUnsupportedRate], ["unresolvedEdgeRate", dataset.manifest.gates.maxUnresolvedEdgeRate]]) {
    if (quality[name] > limit) gateFailures.push(`${name} ${quality[name].toFixed(3)} > ${limit.toFixed(3)}`);
  }
  if (!metrics.noVector.deterministic) gateFailures.push("no-vector run is not deterministic");
  const failuresByCategory = retrieval.failuresByCategory;
  const failuresBySignal = retrieval.failuresBySignal;
  for (const [category, failures] of Object.entries(failuresByCategory)) {
    if (failures.length > 0) gateFailures.push(`category ${category}: ${failures.join("; ")}`);
  }
  for (const [signal, failures] of Object.entries(failuresBySignal)) {
    if (failures.length > 0) gateFailures.push(`signal ${signal}: ${failures.join("; ")}`);
  }
  return {
    schema: "memexbench.raw-result.v1",
    benchmark: dataset.manifest.benchmark,
    run: { revision: dataset.manifest.revision, startedAt, node: process.version, modelRevision: dataset.manifest.model.revision, cold: true, warm: true },
    queries: dataset.queries.length,
    categories: new Set(dataset.queries.map((query) => query.category)).size,
    results,
    metrics,
    gate: { passed: gateFailures.length === 0, failures: gateFailures, failuresByCategory, failuresBySignal },
    fingerprints,
  };
}

function summary(report, output) {
  return {
    ok: report.gate.passed,
    benchmark: report.benchmark,
    revision: report.run.revision,
    queries: report.queries,
    fixtures: report.metrics.quality.fixtureCount,
    categories: report.categories,
    modelRevision: report.metrics.modelRevision,
    indexSizeBytes: report.metrics.indexSizeBytes,
    updateCostMs: report.metrics.updateCostMs,
    quality: report.metrics.quality,
    evidenceIdentity: report.metrics.evidenceIdentity,
    noVector: report.metrics.noVector,
    minimumRecallAt5: Math.min(...Object.values(report.metrics.byConfiguration).map((value) => value.recallAt5)),
    output: output ?? null,
    failures: report.gate.failures,
    failuresByCategory: report.gate.failuresByCategory,
    failuresBySignal: report.gate.failuresBySignal,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/memexbench.mjs [--check] [--no-vector] [--output <raw-result.json>] [--root <benchmark-root>]\n");
    return;
  }
  const dataset = await loadBenchmark(options.root);
  const report = await runBenchmark(dataset, { vectorEnabled: !options.noVector });
  if (options.output !== undefined) await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary(report, options.output), null, 2)}\n`);
  if (options.check && !report.gate.passed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
