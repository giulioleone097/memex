# Slice 2c Execution Report — Structure Analytics and the Self-Maintaining Report

Plan: `docs/superpowers/plans/2026-07-14-memex-plan-2c.md` (14 tasks).
Worktree: `agent-a662582f7701e3bc7`.
Final status: **DONE** — all 14 tasks committed, plus one orchestrator-approved fix
commit. Full suite green at `--test-concurrency=1`: 293 tests, 290 pass, 0 fail, 3 skipped
(pre-existing, unrelated, gated behind `OPENWIKI_RUN_CLIENT_SMOKE=1`).

## Environment note (pre-Task-1)

The worktree's branch (`worktree-agent-a662582f7701e3bc7`) was found at commit `9962e19`,
a strict ancestor of `main` (`15f4c6c`) with zero unique commits — it predated slices
2a/2b and the vendored embedding assets entirely (no plan file, no schema-v2 graph
contracts, no vendor/). Verified safe (lossless, `git status` clean, `git merge-base
--is-ancestor` true) and fast-forwarded: `git merge --ff-only main`. `npm ci` and tree
materialization completed without any iCloud dataless-file stall.

## Task-by-task log

| Task | Description | Result | Commit |
|---|---|---|---|
| 1 | `analyze.ts`: `confidenceWeight`, `computeCommunities` (label propagation) | PASS (5 tests) | `56514d0` |
| 2 | `analyze.ts`: `computeGodNodes`, `computeShortestPath` | PASS (9 total) | `046e88a` |
| 3 | `analyze.ts`: `planeOf`, surprising connections, coverage, suggested questions, member-of synthesis, community summaries, citing pages | PASS (17 total) after one fix (Divergence 2) | `ef0381d` |
| — | chore: commit missed `dist/analyze.*` build output (self-caused; caught by full-suite installer test) | — | `d845626` |
| 4 | `analysis-store.ts`: persisted communities snapshot | PASS (4 tests) | `868e06c` |
| 5 | `report.ts`: `renderGraphReportMarkdown` | PASS (2 tests) | `4731c28` |
| 6 | `graph.ts`: wire `report` action; Step 0 precondition test (slice 2a schema-v2 index guard widening) | PASS (1 precondition + 3 report); full suite 280/283 green | `b4cdde7` |
| 7 | `graph.ts`: wire `communities` read action with staleness | PASS (+3, 6 total) | `cb2f0f4` |
| **fix** | **Orchestrator-ruled**: exclude structural edges (`contains`/`declares`/`exports`) from `computeShortestPath`/`computeCommunities` traversal input; shared `isSemanticEdgeKind` predicate in `analyze.ts`; strengthened community test (two disjoint semantic clusters → ≥2 communities on a real build) | PASS (20 unit + 7 integration); full suite 287/290 green | `39b5346` |
| 8 | `graph.ts`: wire `path` action | PASS (3, including corrected "disconnected" test) | `8167937` |
| 9 | `graph.ts`: wire `explain` action | PASS (+2, 12 total); full suite 292 total, 289 pass | `01d96ae` |
| 10 | `cli.ts` + `adapter.ts`: dispatch, flags, DTO fields for the four new actions | PASS (8 CLI tests); full suite 292/289 green | `4bb1894` |
| 11 | `mcp.ts`: schema branches, MCP parity | PASS (12 MCP tests); full suite 292/289 green | `78acb05` |
| 12 | `plugin-clients.e2e.test.mjs`: fix stale `GRAPH_ACTIONS` constant (test-only) | PASS; full suite 292/289 green | `271ffa8` |
| 13 | Skill docs: `openwiki-graph`, `openwiki-update` | Doc-only; full suite 292/289 green | `ef74002` |
| 14 | Final e2e: full lifecycle, determinism, MCP mirroring on bundled fixture repo | PASS (9/9 in file) after one test-only fix (Divergence 3); **final full suite: 293 tests, 290 pass, 0 fail, 3 skipped** | `bd9e884` |

Full-suite command used throughout: `node --test --test-concurrency=1` (from
`plugins/openwiki`), run synchronously in-turn. `npm run build`/`typecheck`/`lint` via
`npm run <script>` directly (no hangs observed on this machine).

## Orchestrator ruling applied (Task 1 amendment + Task 2/8 dependency)

**Finding (escalated, not self-resolved):** `computeShortestPath`/`getGraphPath` and
`computeCommunities` traversed *all* graph edges, including the structural containment
skeleton (`contains`/`declares`/`exports`) that `assembleGraph` always builds
(repository → directory → file → module → symbol). Because every node in a
single-repository graph descends from the same `repository` root via `contains`, *any*
two nodes were always "connected" and label-propagation could collapse a whole real
repository into one giant community — confirmed with a direct repro (returned path for
two intentionally-unrelated symbols: `declares → contains → contains → contains →
exports`, weight 6, all confidence `exact`). This made Task 8's own "disconnected real
targets" test permanently unsatisfiable, not flaky.

**Ruling (authoritative, applied verbatim):** `path` and `communities` traverse only the
semantic edge subgraph — `calls`, `imports`, `inherits`, `implements`, `references`,
`mentions`, `describes`, `grounds`, `related`. Structural (`contains`, `declares`,
`exports`) and `member-of` (a computed *output*, never a traversal input) are excluded
from both. Implemented as a single shared predicate, `isSemanticEdgeKind`, in
`analyze.ts`, consumed by both `computeShortestPath` and `computeCommunities` so they
cannot drift independently. `explain`'s neighborhood/context, the report's
coverage/structure stats, and slice 2b's `retrieve.ts` `graphProximity` were explicitly
left untouched per the ruling's scope limit (noted below as a possible T9.1 follow-up
for `graphProximity`, since its bounded depth-2 cap already limits containment bleed but
was not re-examined here).

Committed as `39b5346` — `fix(openwiki): exclude structural edges from path and
community traversal` — with: (a) a unit test proving `isSemanticEdgeKind`'s full 13-kind
classification; (b) a unit test proving `computeCommunities` keeps two modules that
share only a directory in separate communities; (c) a unit test proving
`computeShortestPath` returns `undefined` for two nodes connected only structurally; (d)
an integration test on a *real build* with two disjoint semantic clusters (four files,
two independent call-pairs sharing only a directory) asserting `communities.length >= 2`
and that each cluster's top terms are found in a distinct community — strengthening the
prior `communityCount >= 1` check exactly as ruled. Task 8's "disconnected real targets"
test then passed correctly (previously failing) with zero further changes to its own
assertions.

## Divergences from the plan (evidence-backed, all resolved)

1. **Plan's test-invocation syntax is invalid.** Every "Run:" line in the plan uses
   `node --prefix plugins/openwiki --test ...`; `--prefix` is an npm-only flag, not a
   Node flag (confirmed on Node v25.9.0). Substituted `cd plugins/openwiki && node --test
   ...` throughout — command-syntax fix only, no behavior change.

2. **`analyze.ts`'s `TERM_PATTERN` regex bug (Task 3).** Plan's literal
   `/[\p{L}\p{N}_$.-]+/gu` includes `.`/`-` as token characters, so
   `"catalog-service.ts"` matches as one token and `"catalog"` never appears standalone —
   making the plan's own test assertion (`topTerms.includes("catalog")`) unreachable.
   Verified directly in Node before fixing (not a transcription error). Fix: dropped
   `.`/`-` from the character class. Confined to a private tokenizer, zero interface
   impact; all 17 `analyze.test.mjs` tests pass.

3. **Task 14's own MCP-mirroring assertion was structurally guaranteed to fail
   (test-only).** The plan's final e2e test calls `report` a *second* time inside the
   MCP-mirroring batch (request id 2), which — per Task 6/7's own already-tested,
   documented design (idempotent `generation`, but `generatedAt` always reflects the
   real run time) — legitimately refreshes `communities.json`'s `generatedAt` even
   though the graph is unchanged. The very next assertion,
   `assert.deepEqual(parseEnvelope(3).data, communitiesFirst.json.data)`, then compares
   a `communities` read taken *after* that second `report` call against one captured
   *long before* it, on a field (`generatedAt`) that Task 6/7's own idempotency tests
   deliberately never compare across two `report` runs (they check `generation`
   equality only). Root-caused with a temporary debug-instrumented run proving
   back-to-back CLI `communities` reads are byte-identical (ruling out a production
   bug), then tracing the divergence precisely to the intervening MCP `report` call.
   Fix (test-only): compare all fields except `generatedAt` via destructuring, and
   separately assert `generatedAt` is a valid timestamp on both sides. No production
   code changed; no assertion weakened beyond excluding a field that the plan's own
   established pattern already treats as legitimately volatile across `report` re-runs.

## Confirmations requested by the coordinator

- (a) **Report→explain e2e is committed**: yes — `bd9e884`, `tests/e2e/runtime.e2e.test.mjs`,
  test `"slice 2c: report/communities/path/explain are deterministic across two runs and
  mirrored over MCP"`, covering CLI report → communities (×2, determinism) → explain
  (×2, determinism) → path (×2, determinism, plus a NOT_FOUND case) → full MCP mirror of
  report/communities/explain/path against the same repository.
- (b) **Communities test asserts ≥2 on the two-cluster fixture**: yes — integration test
  `"graph: communities separates two disjoint semantic clusters into at least two
  distinct communities on a real build"` in `tests/integration/graph-analytics.test.mjs`
  (committed in `39b5346`), plus unit-level proof in `tests/unit/analyze.test.mjs`.
- (c) **Path returns no-path for structurally-only-connected nodes**: yes — unit test
  `"analyze: shortest path does not traverse structural contains/declares/exports edges"`
  (`39b5346`) and integration test `"graph: path reports found:false for two real but
  disconnected targets"` (`8167937`), both passing.

## Final regression status

`node --test --test-concurrency=1` from `plugins/openwiki`: **293 tests, 290 pass, 0
fail, 3 skipped**. The 3 skips are pre-existing, gated live-client smoke tests
(`OPENWIKI_RUN_CLIENT_SMOKE=1` not set), unrelated to this slice. One transient OOM-kill
of a git `commit-msg` hook subprocess was observed once mid-session under heavy
concurrent load (a stray backgrounded run overlapping a synchronous one); re-ran clean
immediately after and every subsequent full-suite run was clean, consistent with the
task brief's noted pre-existing subprocess flake under concurrent load.

## Limitations / unverified items

- Task 12's fixed `GRAPH_ACTIONS` constant is verified by direct parity with Task 10/11's
  already-tested, identical action lists (adapter.ts, mcp.ts schema), by clean
  build/typecheck/lint, and by the full regression suite — but the specific assertion it
  corrects lives inside a live-client smoke test gated behind
  `OPENWIKI_RUN_CLIENT_SMOKE=1`, which was not exercised (consistent with every prior
  task's baseline run, and with the plan's own Task 12 steps, which do not ask for it).
- Per the ruling's explicit scope limit, slice 2b's `retrieve.ts` `graphProximity` was
  not re-examined for the same structural-edge-connectivity concern; its bounded depth-2
  cap already limits containment bleed, but a full audit is left as a possible follow-up
  (noted, not performed, per instruction).
