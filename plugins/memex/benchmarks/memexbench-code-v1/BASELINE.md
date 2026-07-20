# MemexBench-Code v1 baseline

This directory is the immutable MX-04-01 benchmark baseline. The fixture manifests, query JSONL, qrels JSONL, and frozen split assignments are versioned inputs. `baseline.json` records their SHA-256 fingerprints and the minimum recall gate; `splitsSha256` hashes the exact `splits.json` bytes, so even a semantically equivalent split-file edit fails until a new revision and separately reviewed baseline are recorded.

The gate is intentionally local and deterministic: it does not download a model or contact a connector. The vector ablation uses the versioned `deterministic-hash-vector` model revision declared in `manifest.json`, so a clean checkout exercises the same algorithm on the same bytes. The graph ablation fuses bounded ranked lexical/vector seeds under the same fixed-cap concept used by production retrieval, maps fixture edges through stable node identities, and expands at most two hops; it never seeds every fixture document. Timings are observed per run and are not used as exact equality assertions.

## Reproduce

From the repository root on Node.js 20 or newer:

```bash
npm --prefix plugins/memex ci
npm --prefix plugins/memex run memexbench -- --check
```

To retain the raw result schema for review:

```bash
npm --prefix plugins/memex run memexbench -- --check --output /tmp/memexbench-code-v1.json
```

`--check` fails if the dataset shape, qrels, citation references, quality-rate limits, or minimum recall gate is violated. The output includes cold and warm timings, index bytes, update cost, token count, model revision, and duplicate/stale/unsupported/unresolved-edge rates.

Evidence-quality checks are part of the same report. Each hit carries a content-versioned `evidenceId` and provenance; `metrics.evidenceIdentity` counts stable IDs and computes duplicate rate from those IDs. Top-k fusion deduplicates by that stable identity while retaining the changed-source provenance link. The report also runs the lexical/graph/hybrid path with vectors disabled twice and records `metrics.noVector.deterministic` plus a result fingerprint. Lexical scoring indexes stable source metadata and applies deterministic stemming plus a bounded retrieval-domain concept map (for example, blast-radius/downstream terms normalize to impact) so representative semantic and impact queries are resolved structurally rather than by lowering their gate.

Category and signal ablations are available under `metrics.byCategory` and `metrics.bySignal`. Any dimension below the same `minimumRecallAt5` baseline is listed in `gate.failuresByCategory` or `gate.failuresBySignal`, copied into the aggregate failure list, and makes `gate.passed` false. A green aggregate configuration can therefore never hide a red category or signal cell. The dataset inputs and their recorded hashes remain unchanged by this scorer/gate correction.

To inspect the explicit no-vector path directly:

```bash
npm --prefix plugins/memex run memexbench -- --check --no-vector
```
