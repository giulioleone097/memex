# Memex Implementation Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the existing plugin on real repositories, rename `openwiki` → `memex`, and internalize a unified code+concept+wiki knowledge graph with real embeddings and instant hybrid retrieval, per `docs/superpowers/specs/2026-07-14-memex-prd.md`.

**Architecture:** Compile-at-write / answer-at-read. Deterministic zero-external-runtime TypeScript core (Node >= 20) extended with: concept/page/source graph planes + `enrich` write operation; vendored WASM embedding inference (onnxruntime-web + multilingual-e5-small int8); segmented vector + BM25/trigram lexical stores; RRF hybrid retrieval with graph expansion; label-propagation communities and a self-maintained graph report page.

**Tech Stack:** TypeScript (strict), Node >= 20 built-ins only at runtime, `node --test`, eslint, tsc; vendored assets: onnxruntime-web WASM (Apache-2.0), intfloat/multilingual-e5-small int8 ONNX (MIT), tokenizer.json.

## Global Constraints

- Runtime forbids: network access, model credentials, native compilation, `npm install`, processes beyond Node >= 20 and Git. Vendored checksummed assets are the only third-party artifacts.
- Graph mutation boundary preserved verbatim: build/enrich/index never execute repository code, never write outside `~/.memex/data/<workspace-id>/` (post-rename), never store source-file bodies.
- All operations return bounded JSON with stable machine error codes; new codes: `MODEL_ASSET_MISSING`, `MODEL_ASSET_CORRUPT`, `EMBEDDING_FAILURE`, `INDEX_INCOMPATIBLE`, `MIGRATION_CONFLICT`.
- No `any`, no unchecked casts; discriminated unions + runtime validation for every new contract (existing `contracts.ts` style).
- Silent fallback forbidden: degraded retrieval only via explicit `--signals` request, and responses must label degradation.
- TDD per task: failing test → minimal implementation → pass → commit. Suite: `npm --prefix plugins/memex run build && npm --prefix plugins/memex test` (path is `plugins/openwiki` until Phase 1 lands).
- Performance targets (asserted in e2e with 2x CI margin): `search`/`ask` p95 < 1 s @ 5k chunks incl. query embedding; incremental reindex of one page < 2 s; full build of this repo < 60 s.
- Commits: no AI attribution trailers; concrete behavior-focused messages.
- e5 prefix discipline: `query: ` for queries, `passage: ` for passages, enforced inside the embedder, never left to callers.

## Execution Model (orchestrator)

Orchestrator (this session) dispatches dedicated Sonnet 5 sessions (`model: sonnet`), worktree-isolated when they write files. Two-stage review per task: spec-compliance review by orchestrator + code review before merge. Defect-fix and module tasks run in parallel waves; merges are serialized by the orchestrator.

```
Wave A (parallel, now):  T0.1 dogfood(this repo) · TV.1 vendor assets · TP.1/2/3 author detailed plans 2a/2b/2c
Wave B (parallel):       T0-fix.* one per defect from T0.1 report          [depends: T0.1]
Wave C (serial):         T1.1–T1.4 rename + migration                      [depends: B merged]
Wave D (serial):         Slice 2a per plan-2a                              [depends: C, TP.1]
Wave E (parallel):       2b modules: chunker · tokenizer · embedder · vector-store · lexical-index
                         then serial: retrieve/ask fusion + CLI/MCP        [depends: D, TV.1, TP.2]
Wave F (serial):         Slice 2c per plan-2c                              [depends: E, TP.3]
Wave G (serial):         T9.1 dogfood re-run + verification report         [depends: F]
T0.2 dogfood(second repo) runs when the owner names the repository — parallel to any wave.
```

---

## Phase 0 — Dogfooding campaign

### Task T0.1: Dogfood the current plugin on this repository (both hosts)

**Files:**
- Create: `artifacts/dogfooding/2026-07-14-openwiki-plugin-repo.md`
- Create: `artifacts/dogfooding/defects.md` (defect register: one `## DF-N` section per defect — symptom, exact command, JSON output, severity)

**Interfaces:**
- Consumes: built plugin (`npm --prefix plugins/openwiki run build`), repo installer tooling (discover canonical install path from `README.md`, ops skill, and `tests/integration/installer.test.mjs` / `tests/e2e/plugin-clients.e2e.test.mjs` — do not invent install commands).
- Produces: dogfooding report + defect register consumed by Wave B and by T9.1 as the baseline.

- [ ] **Step 1:** Build and run the full existing suite; record pass/fail counts verbatim in the report. Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`. Expected: PASS (any failure is defect DF-1..N, not a blocker to continue).
- [ ] **Step 2:** Install the plugin into Claude Code and Codex using the repository's own documented installer path; record the exact commands and outputs.
- [ ] **Step 3:** Execute the full CLI lifecycle on this repository with `--mode code --root <this repo> --json`: `status` → `context` → `init` → write standard pages → `check` → `finalize` → `graph build` → `graph status|query|context|impact|changes|map` (one recorded call each, bounded limits) → `ingest` one real source (this repo's PRD file as `git-repo` source) → make one real commit (e.g., a docs touch) → `update` → `doctor`. Record every JSON response (truncate bodies > 50 lines, keep codes/counts/hashes) and wall-clock timing per operation.
- [ ] **Step 4:** Repeat the read path through MCP from each host (JSON-RPC `initialize` → `notifications/initialized` → `tools/list` → `tools/call` for status + one graph query); verify the Git hook fires on the commit from Step 3. Record evidence.
- [ ] **Step 5:** Answer 5 representative questions about this codebase using only wiki + graph outputs (no source reading); grade each answer correct/partial/wrong against the source of truth; record token counts of evidence bundles vs. the raw files they replace.
- [ ] **Step 6:** File every anomaly as `DF-N` in `defects.md` with severity (blocker/major/minor); commit report + register: `git add artifacts/dogfooding && git commit -m "test: record dogfooding evidence for openwiki on its own repository"`.

### Task T0.2: Dogfood on a second production-scale repository — **blocked on owner naming the repo**; same steps as T0.1 with paths swapped; report `artifacts/dogfooding/2026-07-14-<repo>.md`.

### Wave B — Task template T0-fix.N (one per DF-N, parallel, worktree-isolated)

**Files:** per defect — Modify the implicated module under `plugins/openwiki/src/`; Test: matching file under `plugins/openwiki/tests/`.

- [ ] **Step 1:** Write a failing regression test reproducing DF-N exactly as observed (same operation, same input shape). Run it; expected: FAIL reproducing the recorded symptom.
- [ ] **Step 2:** Fix the root cause structurally (no workaround); run the test: PASS.
- [ ] **Step 3:** Run the full suite; expected: PASS, no regressions. Commit: `fix(openwiki): <root cause> (DF-N)`.

---

## Phase 1 — Rename `openwiki` → `memex` (single session, serial)

### Task T1.1: Mechanical rename of tree, manifests, skills, adapters

**Files:**
- Rename: `plugins/openwiki/` → `plugins/memex/` (`git mv`)
- Modify: `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `plugins/memex/.claude-plugin/plugin.json`, `plugins/memex/.codex-plugin/plugin.json` (name `memex`, version `0.2.0`, description "Self-sufficient agentic wiki with internalized code+knowledge graph.")
- Rename: `plugins/memex/skills/openwiki*` → `skills/memex*`; update every SKILL.md name/description/body reference and `<cli>` path.
- Modify: `src/cli.ts`, `src/mcp.ts`, `src/errors.ts`, `src/hook.ts` — product identity strings, server name, help text, message prefixes ("OpenWiki" → "Memex").

- [ ] **Step 1:** Write failing packaging test updates in `tests/packaging/structure.test.mjs` asserting the `memex` names/paths/version. Run: FAIL.
- [ ] **Step 2:** Apply the rename (git mv + programmatic replace with narrow regex `\bopenwiki\b`/`\bOpenWiki\b` reviewed via diff; historical docs under `docs/superpowers/` and `artifacts/` are excluded). Run packaging tests: PASS.
- [ ] **Step 3:** Full suite + build: PASS. Commit: `feat(memex)!: rename plugin from openwiki to memex`.

### Task T1.2: Storage root rename + migration operation

**Files:**
- Modify: `plugins/memex/src/paths.ts` (root `.openwiki` → `.memex`)
- Create: `plugins/memex/src/migrate.ts`
- Modify: `plugins/memex/src/doctor.ts` (legacy-root detection check), `src/contracts.ts` + `src/cli.ts` + `src/adapter.ts` (new `migrate` operation)
- Test: `plugins/memex/tests/unit/migrate.test.mjs`, `tests/integration/operations.test.mjs`

**Interfaces:**
- Produces: `runMigration(homeDir: string): Promise<MigrationResultV1>` where `MigrationResultV1 = { migrated: boolean; from: string; to: string; entries: number; tombstonePath?: string }`; error `MIGRATION_CONFLICT` when both roots exist with content.

- [ ] **Step 1:** Failing tests: (a) legacy root exists, new absent → migrated=true, all entries moved, tombstone `~/.openwiki/MIGRATED.md` written; (b) re-run → no-op migrated=false; (c) both roots non-empty → `MIGRATION_CONFLICT`; (d) neither exists → no-op; (e) symlinked legacy root → `SYMLINK_ESCAPE`. Run: FAIL.
- [ ] **Step 2:** Implement `migrate.ts` (atomic `rename` same-FS; fallback copy → verify (file count + content hashes) → remove; tombstone last). Tests: PASS.
- [ ] **Step 3:** Doctor check `legacy_root_present` failing test → implement → PASS. Full suite: PASS. Commit: `feat(memex): migrate legacy openwiki storage root`.

### Task T1.3: Repo docs + README rename sweep; **Step:** update `README.md` and current (non-historical) docs; add `grep -rn --include='*' -i openwiki` gate excluding `docs/superpowers/`, `artifacts/`, `src/migrate.ts`, tests fixtures for migration, `.worktrees/`, `.git/` to `tests/packaging/structure.test.mjs`; suite PASS; commit `docs: complete memex rename`.

### Task T1.4: Post-rename smoke — fresh install + migrated install both pass the T0.1 Step-3 lifecycle (abbreviated: status/init/check/finalize/graph status/doctor); evidence appended to `artifacts/dogfooding/2026-07-14-rename-smoke.md`; commit.

---

## Phase 2 — Intelligence layer

Detailed TDD plans are authored as `docs/superpowers/plans/2026-07-14-memex-plan-2a.md`, `-2b.md`, `-2c.md` (Tasks TP.1–TP.3 below) and reviewed by the orchestrator before execution. The contracts below are **binding** on those plans — exact names and types; deviation requires orchestrator approval.

### Binding contracts (all slices)

```ts
// graph-contracts.ts (schema v2; store stays shard-compatible, manifest gains schemaVersion: 2)
export type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol"
  | "concept" | "page" | "source";
export type GraphEdgeKind = "contains" | "declares" | "imports" | "exports" | "calls"
  | "inherits" | "implements" | "references"
  | "mentions" | "describes" | "grounds" | "related" | "member-of";
export type ScannerConfidence = "exact" | "resolved" | "heuristic";      // deterministic planes
export type AgentConfidence   = "extracted" | "inferred" | "ambiguous";  // agent-authored edges
export type GraphConfidence = ScannerConfidence | AgentConfidence;
// Validation rule: scanner edge kinds accept only ScannerConfidence; mentions|describes|grounds|related accept only AgentConfidence; member-of accepts only "exact" (computed).

// enrich.ts
export interface EnrichEnvelopeV1 {
  schema: "memex.enrich.v1";
  sourcePath: string;          // repo-relative origin of the extraction
  sourceContentHash: string;   // sha256 of that file at extraction time
  nodes: ReadonlyArray<{ kind: "concept" | "page"; name: string; path: string; summary?: string }>;
  edges: ReadonlyArray<{ kind: "mentions" | "describes" | "grounds" | "related";
                         from: string; to: string; confidence: AgentConfidence }>;
}
// Operation `enrich`: validate → redact → cap (≤ 200 nodes, ≤ 800 edges, ≤ 256 KiB) → atomic enrichment shard keyed by (sourcePath, sourceContentHash); unchanged hash → no-op.

// chunk.ts
export interface ChunkRef { id: string; path: string; startLine: number; endLine: number;
                            plane: "code" | "concept" | "wiki"; nodeId?: string; contentHash: string; }
export function chunkMarkdown(path: string, text: string): ChunkRef[];   // heading/paragraph bounds, 200–400 token target
export function chunkSymbols(nodes: readonly GraphNodeV1[]): ChunkRef[]; // signature+name+path metadata text only

// tokenizer.ts (pure TS, driven by vendored tokenizer.json)
export interface Tokenizer { encode(text: string): Int32Array; }
export function loadTokenizer(tokenizerJsonPath: string): Promise<Tokenizer>;

// embedder.ts (onnxruntime-web WASM, lazy-loaded)
export interface Embedder { readonly modelId: string; readonly dims: number; // "multilingual-e5-small-int8", 384
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: readonly string[]): Promise<Float32Array[]>; }
export function loadEmbedder(vendorRoot: string): Promise<Embedder>; // MODEL_ASSET_MISSING / MODEL_ASSET_CORRUPT on failure

// vector-store.ts (segments: 16-byte header {magic,dtype,dims,count} + int8 rows + id table; manifest.json {modelId, modelRevision, dims, dtype, segments[{file,contentHash,count}]})
export interface VectorStore {
  upsert(entries: ReadonlyArray<{ ref: ChunkRef; vector: Float32Array }>): Promise<{ written: number; reused: number }>;
  search(vector: Float32Array, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>;
  status(): Promise<{ modelId: string; dims: number; chunks: number; compatible: boolean }>; }
// Manifest modelId mismatch with loaded embedder → INDEX_INCOMPATIBLE.

// lexical-index.ts (BM25 k1=1.2 b=0.75 + trigram fallback; segments keyed by contentHash)
export interface LexicalIndex {
  upsert(chunks: ReadonlyArray<{ ref: ChunkRef; text: string }>): Promise<void>;
  search(query: string, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>; }

// retrieve.ts — RRF k=60 over (lexical, vector, graphProximity); graphProximity = BFS ≤ depth 2 from seed nodes, edge weight by confidence (exact/extracted 1.0, resolved/inferred 0.7, heuristic/ambiguous 0.4); deterministic tie-break by ChunkRef.id.
export interface SearchRequest { text: string; limit: number; signals?: ReadonlyArray<"lexical" | "vector" | "graph">; }
export interface EvidenceItem { ref: ChunkRef; score: number; ranks: { lexical?: number; vector?: number; graph?: number };
                                citation: string; /* "path#Lstart-Lend" */ confidence?: GraphConfidence; }
export interface AskResultV1 { schema: "memex.ask.v1"; question: string; evidence: EvidenceItem[];
                               relatedNodes: GraphNodeV1[]; degraded: boolean; stale: boolean; truncated: boolean; }

// analyze.ts — label propagation seeded by ascending node id, max 20 iterations, deterministic;
export function computeCommunities(graph: CodeGraphV1): Map<string, string>; // nodeId → communityId
export function computeGodNodes(graph: CodeGraphV1, limit: number): Array<{ nodeId: string; degree: number }>;
// report.ts renders wiki page `graph-report.md` (god nodes, communities, cross-plane "surprising connections", suggested questions, coverage stats, ambiguous edges).
```

New CLI operations: `enrich` (stdin envelope), `search --query --limit [--signals]`, `ask --query --limit [--signals]`; new graph actions: `path --from --to`, `explain --target`, `communities`, `report`. MCP mirrors every operation with identical JSON contracts.

### Task TV.1: Vendor assets acquisition (parallel with Wave A; network allowed at build time only)

**Files:** Create `plugins/openwiki/vendor/` (repathed by Phase 1 rename): `ort/` (onnxruntime-web WASM + minimal JS loader), `model/multilingual-e5-small-int8/model.onnx` + `tokenizer.json`, `licenses/` (Apache-2.0, MIT texts), `MANIFEST.json` `{ assets: [{ path, sha256, bytes, license, upstream, revision }] }`.

- [ ] **Step 1:** Failing test `tests/unit/vendor.test.mjs`: MANIFEST parses, every listed file exists, sha256 matches, total < 60 MB, licenses present. Run: FAIL.
- [ ] **Step 2:** Fetch pinned-revision assets from official upstreams (onnxruntime-web npm tarball — extract WASM only; huggingface intfloat/multilingual-e5-small ONNX int8 export + tokenizer.json), record revisions and checksums in MANIFEST. Test: PASS. Commit (binary-safe, each file < 100 MB).
- [ ] **Step 3:** Node smoke script `tests/integration/embedder-smoke.test.mjs` (skipped-if-assets-absent guard): load engine, embed "query: ciao mondo", assert Float32Array(384) with non-zero norm. PASS. Commit: `feat: vendor WASM embedding runtime and multilingual-e5-small model`.

### Tasks TP.1 / TP.2 / TP.3: Author detailed TDD plans for slices 2a / 2b / 2c

**Files:** Create `docs/superpowers/plans/2026-07-14-memex-plan-2a.md` (concept/wiki planes + enrich + check invariants), `-2b.md` (chunker, tokenizer, embedder, vector store, lexical index, retrieve/ask, CLI+MCP wiring, perf e2e), `-2c.md` (communities, god nodes, path/explain, report, MCP parity, final e2e).

- [ ] **Step 1:** Each planning session reads the PRD §7 slice + binding contracts above + the relevant existing modules, then writes a complete plan in the writing-plans format (bite-sized TDD tasks, full code in steps, no placeholders, exact paths, interfaces consistent with the binding contracts).
- [ ] **Step 2:** Orchestrator reviews each plan against PRD coverage, contract fidelity, and the No-Placeholders rule; revisions applied; plan committed: `docs: add memex slice plan <2a|2b|2c>`.

### Task T9.1: Final verification — re-run T0.1 protocol on this repository post-Phase-2 (now exercising enrich/search/ask/path/explain/communities/report), record token-efficiency for 10 questions, update `artifacts/verification/final-report.md`, run full gates (build/typecheck/lint/test/e2e), two consecutive clean review cycles, dead-code sweep (`openwiki` gate + unused exports scan). Commit: `docs: record memex final verification evidence`.

---

## Self-review (performed at authoring)

- **Spec coverage:** PRD §7 Phase 0 → T0.1/T0.2/Wave B; Phase 1 surfaces/migration/compat → T1.1–T1.4; Phase 2a/2b/2c → TP.1–3 + binding contracts + TV.1; §12 gates → embedded per task + T9.1; §14 acceptance → T9.1. Gap: none identified; PDF/vision et al. explicitly out of scope (PRD §15).
- **Placeholders:** slice detail intentionally delegated to TP.1–3 sub-plans (skill's per-subsystem split), with binding contracts preventing drift; no TBD markers remain in this document.
- **Type consistency:** contract names cross-checked (ChunkRef shared by chunk/vector/lexical/retrieve; AgentConfidence in enrich envelope and edge validation; AskResultV1 schema tag matches contracts.ts conventions).
