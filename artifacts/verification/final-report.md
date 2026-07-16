# Memex — T9.1 final verification report

## Verification target

- Evidence date: 2026-07-16
- Implementation SHA (after this task's own dogfooding fix): `0645b6d4c076f261f7bdd93efe20c7b8d41c87f7`
- Base SHA verified (MEMEXHEAD, rename + slices 2a/2b/2c + vendor + DF-H1/DF-H2 + migration): `5cfb71532df3914ef734c2271a68efe449f6d9c0`
- Repository: this worktree, isolated from the orchestrator's main tree
- Runtime versions: Node.js `v25.9.0`, npm `11.12.1`
- This report supersedes the pre-rename OpenWiki final-verification report for final-state claims. Earlier reports remain historical evidence only.

This is the final Definition-of-Done evidence gate (T9.1) for the Memex project: the rename from OpenWiki to Memex, the unified code/concept/wiki graph (slice 2a), local embeddings and hybrid lexical+vector+graph retrieval (slice 2b), graph analytics and reporting — communities, god nodes, surprising connections, coverage, suggested questions (slice 2c) — and the two prior dogfooding-hardening fixes (DF-H1, DF-H2).

## What shipped

- **Rename**: the plugin is packaged as `memex` for both Codex and Claude Code (`plugins/memex/.claude-plugin`, `plugins/memex/.codex-plugin`), with a one-time `migrate` operation moving `~/.openwiki` storage to `~/.memex` and leaving a tombstone.
- **Slice 2a — unified graph**: a single dependency-free, segmented, immutable-on-generation code/concept/wiki graph under `~/.memex/data/<workspace-id>/graph`, built from real Git evidence (`git ls-files`/`ls-tree`/`status`), with incremental rebuilds keyed on a dirty fingerprint. Exposes `build`, `status`, `query`, `context`, `impact`, `changes`, `map`, `path`, `explain`.
- **Slice 2b — embeddings + hybrid retrieval**: a vendored, chunked ONNX tokenizer/embedding model (`plugins/memex/vendor/model`) powers a local vector store; `search` and `ask` combine lexical, vector, and graph signals into a single ranked, cited evidence bundle.
- **Slice 2c — analytics + report**: `communities`, god-node detection, surprising-connection detection, coverage statistics, and suggested questions, persisted in an analysis store and rendered as a `graph-report.md` wiki page via the `report` action.
- **DF-H1 / DF-H2** (from Task T0.2's dogfooding campaign against a real private repository, "Husme", per `docs/superpowers/specs/2026-07-15-memex-execution-status.md`):
  - **DF-H1**: `context` previously collapsed every Git failure mode into one generic `GIT_FAILURE`, including the legitimate "brand-new repo, no commits yet" (unborn HEAD) state. Fixed so `collectGitContext` returns a successful result with `hasCommits: false` and an explicit `noCommitsReason` for unborn HEAD, while genuine Git failures still raise `GIT_FAILURE`.
  - **DF-H2**: `graph build` silently dropped embedded/nested Git repositories (a directory containing its own `.git`, not a registered submodule) with zero disclosure. Fixed so the scanner emits an explicit `EMBEDDED_GIT_REPOSITORY_SKIPPED` diagnostic (path + reason), and `buildGraph`/`status`/`query`/`context`/`impact`/`changes`/`map` all now expose the full diagnostics array (not just a count). Covered by `tests/integration/graph-repository.test.mjs` ("graph: surfaces an embedded git repository as an explicit scan diagnostic instead of silently skipping it").

## Gate results

| Surface | Command | Result |
| --- | --- | --- |
| Build | `node plugins/memex/node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json` | PASS, exit 0, `plugins/memex/dist/cli.js` present |
| Type safety | `tsc --noEmit -p plugins/memex/tsconfig.json` | PASS, exit 0, 0 errors |
| Lint | `node plugins/memex/node_modules/eslint/bin/eslint.js plugins/memex` | PASS, exit 0, 0 problems |
| Tests | `node --test --test-concurrency=1` (run in 4 chunks by directory to fit tool time budgets; identical to a single invocation) | **308 tests, 305 pass, 0 fail, 3 skip** |

Test breakdown by directory:

| Suite | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- |
| `tests/unit/**` | 163 | 163 | 0 | 0 |
| `tests/integration/**` | 115 | 115 | 0 | 0 |
| `tests/packaging/**` + `tests/fixtures/**` | 12 | 12 | 0 | 0 |
| `tests/e2e/**` | 18 | 15 | 0 | 3 |
| **Total** | **308** | **305** | **0** | **3** |

The 3 skips are the pre-existing, intentionally-gated live client smoke tests (`MEMEX_RUN_CLIENT_SMOKE is not 1`) in `tests/e2e/plugin-clients.e2e.test.mjs` — install/list/remove against the real Codex and Claude clients, and the disposable-marketplace-removal check. This matches the expected ~300+ pass / 0 fail / 3 skip shape.

No flakes were observed. The p95 perf e2e test (`search/ask p95 < 1s @ 5k chunks including query embedding`) passed on the first run both before and after the dogfooding fix below, with real samples of 373–544 ms against a 2000 ms (2x CI margin) budget. The MCP stdio integration suite also passed cleanly on both runs; an early run of the unsplit full suite appeared to "hang" only because several individual tests legitimately take 15–90 s (full-repository builds, install/uninstall lifecycle with real timeouts) — the suite is long, not flaky, and no test needed an isolated re-run to confirm a false failure.

## A real defect found by dogfooding this repository, and its fix

Running the real dogfood lifecycle (below) against **this repository** — required by T9.1 — immediately surfaced a genuine, previously-undetected defect: `graph build` reported only **24 files / 793 nodes / 929 edges**, and none of `plugins/memex/**` (the plugin's own source) appeared anywhere in the graph.

Root cause: `graph-store.ts`'s `excluded()` filter treated **any path segment** named `memex` or `.memex` as excluded, intending to skip the wiki's own generated content directory. Since `paths.ts`'s `resolveWikiLocation` always places that directory at `<workspaceRoot>/memex` (a direct child of the scanned root, never nested), the anywhere-match was over-broad. After the rename, this project's own plugin lives at `plugins/memex/` — so the filter silently blackholed the plugin's entire source tree from every graph build, search, ask, impact, and report run against this repository, with no diagnostic or error surfaced.

Fix (commit `0645b6d`, following TDD — regression test written and confirmed red before the fix, then green after):
- Split the exclusion list into `ANYWHERE_EXCLUDED_DIRS` (`.git`, `node_modules`, `vendor`, `dist`, `build`, `coverage` — genuine build/dependency artifacts, correctly excluded at any depth) and `ROOT_ONLY_EXCLUDED_DIRS` (`memex`, `.memex` — the wiki's own content, which by construction is only ever a direct child of the scanned root).
- Added `tests/integration/graph-repository.test.mjs` test: "graph: excludes only the top-level wiki content directory named memex, not a nested source directory sharing that name" — proves a nested `plugins/memex/src/index.ts` is scanned and its symbol indexed, while the top-level `memex/` wiki content directory remains excluded.
- Full gate re-run after the fix: build/typecheck/lint clean; all 308 tests still pass (163+115+12+18, 0 fail, 3 pre-existing skips — the new test is the +1 versus the pre-fix count).
- Real-repo impact of the fix: `graph build --root <this repo>` went from **24 files / 793 nodes / 929 edges / 741 diagnostics** to **172 files / 5,997 nodes / 8,433 edges / 8,917 diagnostics**, and `graph query --query dispatchGraph` now correctly resolves to `plugins/memex/src/adapter.ts:282`.

This is exactly the class of defect DF-H1/DF-H2 were designed to catch (silent, undisclosed scan incompleteness) — this time triggered by dogfooding the tool against its own post-rename repository rather than a third-party one.

## Real dogfood lifecycle (this repository)

All commands run via `node plugins/memex/dist/cli.js <op> --mode code --root <this repo> --json` against this actual worktree, after the fix above. JSON bodies are truncated to key codes/counts/hashes/timings.

| Op | Result | Evidence |
| --- | --- | --- |
| `status` (pre-init) | PASS | `{"ok":false,"error":{"code":"NOT_INITIALIZED","message":"Memex is not initialized."}}` — correct pre-init behavior |
| `init` | PASS | `{"ok":true,"data":{"changed":true,"createdPages":["quickstart.md","architecture.md","source-map.md","workflows.md","domain-concepts.md","operations.md","integrations.md","testing.md"],"location":{"workspaceId":"ff186f86bf...","dataRoot":"~/.memex/data/ff186f86bf..."}}}` |
| `graph build` (initial, pre-fix) | PARTIAL — surfaced the defect above | `fileCount:24, nodeCount:793, edgeCount:929, diagnosticCount:741` |
| `graph build --force` (post-fix) | PASS | `fileCount:172, nodeCount:5997, edgeCount:8433, diagnosticCount:8917, head:"5cfb715..."` |
| `graph status` | PASS | `{"available":true,"fresh":true,"indexedHead":"5cfb715...","currentHead":"5cfb715...","counts":{"files":172,"nodes":5997,"edges":8433,"diagnostics":8917}}` |
| `graph query --query dispatchGraph` | PASS | resolves to `plugins/memex/src/adapter.ts` symbol `dispatchGraph`, `startLine:282` |
| `graph context --target dispatchGraph` | PASS | returns real neighborhood nodes (`dispatchUnsafe`, `loadGraph`, `readOptionalBoundedInteger`, ...) |
| `graph impact --target dispatchGraph --direction inbound --depth 2` | PASS | returns real inbound-impact nodes in `plugins/memex/src/adapter.ts` |
| `graph map` | PASS | returns real modules (`plugins/memex/src/lexical-index.ts`, `plugins/memex/eslint.config.js`, ...) |
| `enrich` (real concept batch from `plugins/memex/README.md`) | PASS | envelope with 2 concept nodes (`"deterministic storage"`, `"one source-backed local wiki"`) + 1 `mentions` edge to the real `dispatchGraph` symbol node → `{"applied":true,"nodesWritten":3,"edgesWritten":3}` |
| `search --query "how does memex build the code graph incrementally"` | PASS | hybrid lexical+vector+graph evidence citing `plugins/memex/src/graph.ts#L97`, `#L303`, `#L65`, and test files, with per-signal ranks |
| `ask --query "how does the migrate operation detect a migration conflict"` | PASS | evidence citing `plugins/memex/src/migrate.ts#L58`, `#L35`, plus related-node graph context |
| `graph path --from dispatchGraph --to buildGraph` | PASS | `found:true`, real 4-hop call path: `dispatchGraph → has → scanSourceFile → buildGraph`, all in real source files |
| `graph explain --target buildGraph` | PASS | real neighborhood (`writeGraph`, `MemexError`, `scanSourceFile`, ...) |
| `graph communities` (before `report`) | STALE/EMPTY (expected) | `{"communities":[],"stale":true}` — analytics cache not yet populated for this generation |
| `graph report` | PASS | writes `graph-report.md`; `{"communityCount":5108,"godNodeCount":20,"surprisingConnectionCount":3,"ambiguousEdgeCount":0,"coverageRatio":0.000173}` |
| `graph communities` (after `report`) | PASS | now returns real communities, e.g. one with `memberCount:542`, `topTerms:["memex","plugins","src","ts","graph"]` |
| MCP stdio: `initialize` | PASS | `protocolVersion:"2025-11-25"`, `capabilities:{"tools":{"listChanged":false}}`, `serverInfo:{"name":"memex","version":"0.1.0"}` |
| MCP stdio: `notifications/initialized` → `tools/list` | PASS | 16 tools returned: `init, status, context, search, ask, read, write, ingest, enrich, finalize, check, doctor, schedule, purge, graph, migrate` |
| MCP stdio: `tools/call` (`ask`) | PASS | `isError:false`, real evidence citing `plugins/memex/src/enrich.ts#L130` |
| MCP stdio: `tools/call` (`search`) | PASS | `isError:false`, real evidence citing `plugins/memex/scripts/validate.mjs#L576`, `plugins/memex/src/graph.ts#L147` |

**Operational notes on ordering dependencies** (not defects): `search`/`ask` require a prior `graph build` for the graph signal to be available (`NOT_INITIALIZED` otherwise, by design). `graph communities` requires a prior `graph report` (or equivalent analyze pass) to populate the analysis-store cache for the current graph generation — before that it returns an empty, explicitly `stale:true` result rather than failing or returning stale data silently.

## Token-efficiency (Karpathy-wiki value metric)

Ten representative real questions about this codebase were run through `ask --root <this repo> --limit 8 --json`. For each, the evidence-bundle JSON size was compared against the combined size of the distinct source files the evidence cited (i.e., the files an agent would otherwise have had to open in full to get equivalent grounding). Token counts are a consistent ~4-bytes/token approximation applied uniformly to both sides — not a real BPE count, but a fair like-for-like ratio.

| # | Question | Files cited | Evidence tokens (approx) | Raw file tokens (approx) | Ratio |
| --- | --- | --- | --- | --- | --- |
| 1 | How does the graph scanner exclude directories from the repository scan? | 5 | 1,828 | 22,201 | 12.14x |
| 2 | How does the migrate operation detect a migration conflict between openwiki and memex roots? | 7 | 1,802 | 26,013 | 14.44x |
| 3 | What does the MCP server return for tools/list and how are input schemas closed? | 6 | 1,877 | 21,039 | 11.21x |
| 4 | How does enrich ground a wiki page node in the code graph? | 6 | 1,798 | 58,861 | 32.74x |
| 5 | How does hybrid retrieval combine lexical, vector, and graph signals for search? | 4 | 1,831 | 75,134 | 41.03x |
| 6 | How does the tokenizer handle out-of-vocabulary text? | 6 | 1,790 | 71,271 | 39.82x |
| 7 | What does doctor check and how does it avoid exposing secrets? | 6 | 1,898 | 80,155 | 42.23x |
| 8 | How does purge avoid deleting a code wiki when scope is all? | 5 | 1,738 | 13,826 | 7.96x |
| 9 | How does the CLI parse flags and reject unknown arguments? | 1 | 1,774 | 2,391 | 1.35x |
| 10 | How does graph impact analysis bound traversal depth and direction? | 4 | 1,896 | 78,695 | 41.51x |

**Median ratio: 23.59x.** Range: 1.35x (a question answerable from a single small file, where a raw read would already be cheap) to 42.23x (questions whose grounding is scattered across several large files, where the graph-and-embeddings-backed evidence bundle avoids opening any of them in full). All 10 evidence bundles carried real file/line citations (`path#Lstart-Lend`) resolvable back to this repository's actual source.

## Migration proof (isolated — real `~/.openwiki`/`~/.memex` never touched)

All four scenarios ran against a temporary `HOME=T` (under this session's scratch directory), never the real host home. The real `~/.openwiki` (dated 2026-07-14, pre-existing, no `MIGRATED.md`) and `~/.memex` were inspected before and after and confirmed unaffected by these runs.

1. **No legacy root → no-op**: `{"ok":true,"data":{"migrated":false,"from":".../T/.openwiki","to":".../T/.memex","entries":0}}`
2. **Real legacy root with a marker file → real migration**: created `T/.openwiki/data/x/marker.txt`; `migrate` returned `{"migrated":true,"entries":1,"tombstonePath":".../T/.openwiki/MIGRATED.md"}`; the marker file was verified moved byte-for-byte to `T/.memex/data/x/marker.txt`, and `T/.openwiki/MIGRATED.md` was written.
3. **Idempotent re-run**: running `migrate` again against the same `T` returned `{"migrated":false,"entries":0,"tombstonePath":".../MIGRATED.md"}` with the marker file's content unchanged and unmoved.
4. **Conflict**: a fresh `T2` with non-empty data under *both* `T2/.openwiki/data/legacy/` and `T2/.memex/data/existing/` returned `{"ok":false,"error":{"code":"MIGRATION_CONFLICT","message":"Both the legacy ~/.openwiki root and the new ~/.memex root contain data; resolve manually before migrating."}}`; both roots were verified untouched afterward.

**Migration proof: PASS (4/4 scenarios).**

## Dead-code sweep

`grep -rn '\bopenwiki\b' plugins/memex/src plugins/memex/skills` → **12 matches, all in the 3 allowlisted legacy-path files**: `src/migrate.ts` (4), `src/doctor.ts` (5), `src/paths.ts` (3) — all referencing the legacy `~/.openwiki` storage-root name itself (comments and the `legacyStorageRoot()` helper), which is required and correct. No stray identity strings elsewhere; this is also covered by the packaging test "no stray openwiki identity strings remain outside the allowed legacy-path files" (passing).

Spot-checked exports from the slice-2c analytics modules (`analyze.ts`, `analysis-store.ts`, `report.ts`) for dead code: every exported function is referenced by 4-9 call sites elsewhere (`computeShortestPath`, `computeCoverageStats`, `writeCommunitiesSnapshot`, `readCommunitiesSnapshot`, `renderGraphReportMarkdown`, etc.). A handful of exported `interface`/`type` declarations (`GraphPathResult`, `GraphPlane`, `SurprisingConnection`, `CoverageStats`, `CommunityQuestionInput`, `CommunitiesSnapshotV1`, `AnalysisStorage`, `GraphReportInputV1`) show 0 *literal* references outside their own file under a naive grep — this is expected TypeScript structural typing (consumers of the referenced, actively-used functions receive these types via inference without re-stating the type name), not dead code. No removals were needed.

## Honest limitations and unverified items

- **Live client smoke tests** (installing/listing/removing the plugin against the real Codex and Claude Code binaries) remain intentionally skipped in this environment (`MEMEX_RUN_CLIENT_SMOKE` not set to `1`), consistent with pre-existing project convention — not run as part of this verification.
- **Token-efficiency ratios are approximate**: the ~4-bytes/token heuristic is not a real BPE tokenizer count for either side of the comparison. The ratio is directionally solid (both sides use the identical approximation) but should not be read as an exact token count.
- **This report's own dogfooding fix** (the `memex`-directory-exclusion scoping bug) was found and fixed live during this verification run, following TDD (red test, then fix, then green), with a full gate re-run (build/typecheck/lint/all 308 tests) confirming zero regressions. It is committed separately (`0645b6d`) from this report for a clean audit trail.
- **Dogfood-generated wiki content** (`<repo>/memex/` and the `~/.memex/data/<workspace-id>` entry created for this repository's workspace ID during this verification) was left in the real `~/.memex` data directory as normal, expected product behavior of running the real CLI against this repository (not cleaned up, since that is real usage state, not test residue); the in-repo `memex/` wiki-page directory was removed before committing so it is not tracked in Git.
- No new flakes, hangs, or environment-specific failures were observed in this run beyond the already-known long wall-clock time of the full suite (a few minutes, dominated by full-repository graph builds and install/uninstall lifecycle tests with real timeouts), which required splitting the single `node --test` invocation across several tool calls purely to fit this environment's per-command time budget — it does not reflect any test-suite defect.

## Verification matrix summary

| Gate | Status |
| --- | --- |
| Build (`tsc`) | PASS |
| Typecheck (`tsc --noEmit`) | PASS |
| Lint (`eslint`) | PASS |
| Full test suite | 308 tests, 305 pass, 0 fail, 3 pre-existing skips |
| Real dogfood lifecycle (CLI) | PASS, including a real defect found and fixed live |
| Real dogfood (MCP stdio) | PASS |
| Token-efficiency (10 questions) | Median 23.59x, range 1.35x–42.23x |
| Migration proof (isolated) | PASS (4/4 scenarios) |
| Dead-code sweep | PASS (12/12 openwiki refs allowlisted; no unused slice-2c exports) |
