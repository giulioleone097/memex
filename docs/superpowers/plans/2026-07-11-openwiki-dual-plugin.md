# OpenWiki Dual-Host Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained, agent-native OpenWiki plugin that Codex and Claude Code install separately while sharing one deterministic runtime, wiki state, and native code graph.

**Architecture:** Repository-local marketplaces point to one plugin root. Strict TypeScript domain/application services compile to dependency-free Node.js ESM; CLI, MCP, Claude hook, and skills are adapters. Codex/Claude perform synthesis, while the runtime confines writes, validates state/source data, and supplies grounded wiki and code-graph evidence.

**Tech Stack:** Node.js 20+, TypeScript 5.x, Node standard library, Node test runner, ESLint, Prettier, Codex CLI 0.142+, Claude Code 2.1.207+.

## Global Constraints

- Runtime has zero npm dependencies and no first-use network installation.
- The graph is implemented entirely in OpenWiki: no GitNexus package, binary, service, provider, fallback, data-format coupling, or download.
- Graph APIs never mutate repository source and never store source bodies; only private atomic indexes are written.
- Installed plugin contains every executable artifact under `plugins/openwiki`.
- Codex and Claude manifests/configuration stay separate; core and skills stay shared.
- State schema version is exactly `1`; unknown versions fail closed.
- Source kinds are exactly `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`.
- Runtime never stores OAuth/model credentials and never starts another LLM.
- All writes are atomic, path-confined, symlink-safe, idempotent where declared, and covered by tests.
- Final full quality gate and two consecutive reviews run only after integration.

---

### Task 1: Repository and contract scaffold

**Files:**
- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/openwiki/package.json`
- Create: `plugins/openwiki/tsconfig.json`
- Create: `plugins/openwiki/eslint.config.js`
- Create: `plugins/openwiki/src/contracts.ts`
- Create: `plugins/openwiki/src/errors.ts`
- Create: `plugins/openwiki/tests/unit/contracts.test.mjs`

**Interfaces:**
- Produces: `WikiMode`, `SourceKind`, `WikiStateV1`, `SourceEnvelopeV1`, `OpenWikiError`, `parseWikiState`, `parseSourceEnvelope`, and JSON-result types used by every later task.

- [ ] **Step 1: Scaffold the canonical Codex plugin and repository marketplace**

Run the official local creator with plugin name `openwiki`, parent `plugins`, marketplace `.agents/plugins/marketplace.json`, and optional skills/scripts/MCP directories. Expected: plugin root and valid baseline Codex manifest exist.

- [ ] **Step 2: Write failing contract tests**

Cover valid state/envelope, unknown keys allowed only in item metadata, unknown schema, invalid timestamps, duplicate external IDs, size/item limits, and stable error JSON.

Run: `npm --prefix plugins/openwiki test -- --test-name-pattern=contracts`
Expected: FAIL because compiled contract modules do not exist.

- [ ] **Step 3: Implement strict contracts and typed errors**

Use discriminated unions and type guards. Validation returns typed values or throws `OpenWikiError`; no unchecked cast or `any`.

- [ ] **Step 4: Build and rerun contract tests**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki test -- --test-name-pattern=contracts`
Expected: PASS.

- [ ] **Step 5: Commit scaffold and contracts**

```bash
git add .agents .claude-plugin plugins/openwiki/package.json plugins/openwiki/tsconfig.json plugins/openwiki/eslint.config.js plugins/openwiki/src/contracts.ts plugins/openwiki/src/errors.ts plugins/openwiki/tests/unit/contracts.test.mjs
git commit -m "feat: scaffold dual-host OpenWiki contracts"
```

### Task 2: Confined wiki storage and Git evidence

**Files:**
- Create: `plugins/openwiki/src/paths.ts`
- Create: `plugins/openwiki/src/atomic.ts`
- Create: `plugins/openwiki/src/state.ts`
- Create: `plugins/openwiki/src/wiki.ts`
- Create: `plugins/openwiki/src/git.ts`
- Create: `plugins/openwiki/templates/code/*.md`
- Create: `plugins/openwiki/templates/personal/*.md`
- Test: `plugins/openwiki/tests/unit/storage.test.mjs`
- Test: `plugins/openwiki/tests/integration/git-wiki.test.mjs`

**Interfaces:**
- Consumes: Task 1 contracts and errors.
- Produces: `resolveWikiLocation(options)`, `withWikiLock(root, operation)`, `readState(location)`, `initializeWiki(options)`, `readPage(location, page)`, `writePage(location, page, content)`, `searchWiki(location, query)`, `collectGitContext(root, previousHead)`, `finalizeRun(options)`, and `checkWiki(location)`.

- [ ] **Step 1: Write failing path, atomicity, state, search, and Git tests**

Use real temporary directories and real `git init`, commits, modifications, symlinks, and concurrent child processes. Expected failures: modules missing.

- [ ] **Step 2: Implement path resolution and lock/atomic write primitives**

Reject `..`, absolute page paths, non-`.md` pages, existing symlink escapes, and stale lock ambiguity. Use same-directory temp files and rename.

- [ ] **Step 3: Implement state and wiki lifecycle**

Initialize standard pages without overwriting user content; preserve no-op metadata; return line-addressed ranked search results.

- [ ] **Step 4: Implement bounded Git evidence**

Use `spawn` with argument arrays, 15-second timeout, 1 MiB combined output cap, and sanitized `GIT_FAILURE` errors.

- [ ] **Step 5: Run focused tests**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/storage.test.mjs plugins/openwiki/tests/integration/git-wiki.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit storage slice**

```bash
git add plugins/openwiki/src plugins/openwiki/templates plugins/openwiki/tests/unit/storage.test.mjs plugins/openwiki/tests/integration/git-wiki.test.mjs
git commit -m "feat: add confined wiki storage and Git evidence"
```

### Task 3: Source ingestion, redaction, schedules, doctor, and purge

**Files:**
- Create: `plugins/openwiki/src/redact.ts`
- Create: `plugins/openwiki/src/sources.ts`
- Create: `plugins/openwiki/src/schedules.ts`
- Create: `plugins/openwiki/src/doctor.ts`
- Create: `plugins/openwiki/tests/unit/sources.test.mjs`
- Create: `plugins/openwiki/tests/integration/operations.test.mjs`

**Interfaces:**
- Consumes: Task 1 contracts/errors and Task 2 atomic/path/state primitives.
- Produces: `redactSensitive(value)`, `ingestSource(options)`, `listSources(location)`, `purgeData(options)`, `setSchedule(options)`, `listSchedules(location)`, `removeSchedule(options)`, and `runDoctor(options)`.

- [ ] **Step 1: Write failing source and operations tests**

Include all seven kinds, dedupe, latest-20 retention, secret patterns, 2 MiB cap, 500-item cap, prompt-injection-shaped text, malformed schedules, purge symlink, and doctor failures.

- [ ] **Step 2: Implement recursive redaction and canonical hashing**

Redact authorization headers, API keys, bearer tokens, private keys, common token names, and secret-shaped metadata before hashing or disk.

- [ ] **Step 3: Implement source persistence and retention**

Store redacted envelopes under private data root. Never place connector material inside repository wiki directories.

- [ ] **Step 4: Implement schedules, doctor, and purge**

Schedule persistence is host-neutral and idempotent. Doctor is read-only. Purge requires explicit `raw`, `schedules`, `personal-wiki`, or `all` scope and never follows symlinks.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/sources.test.mjs plugins/openwiki/tests/integration/operations.test.mjs`
Expected: PASS.

```bash
git add plugins/openwiki/src plugins/openwiki/tests/unit/sources.test.mjs plugins/openwiki/tests/integration/operations.test.mjs
git commit -m "feat: add secure OpenWiki source operations"
```

### Task 3B: Native incremental code graph

**Files:**
- Create: `plugins/openwiki/src/graph-contracts.ts`
- Create: `plugins/openwiki/src/graph-scan.ts`
- Create: `plugins/openwiki/src/graph-store.ts`
- Create: `plugins/openwiki/src/graph-query.ts`
- Create: `plugins/openwiki/src/graph.ts`
- Test: `plugins/openwiki/tests/unit/graph.test.mjs`
- Test: `plugins/openwiki/tests/integration/graph-repository.test.mjs`

**Interfaces:**
- Consumes: Task 1 contracts/errors and Task 2 atomic/path/Git primitives.
- Produces: `parseCodeGraph(value)`, `buildGraph(options)`, `getGraphStatus(options)`, `queryGraph(options)`, `getGraphContext(options)`, `analyzeGraphImpact(options)`, `analyzeGraphChanges(options)`, and `getArchitectureMap(options)`.

- [ ] **Step 1: Write failing graph contract and scanner tests**

Cover deterministic IDs/order, corrupt/unknown schema, language detection, comment/literal isolation, declarations, imports/exports, calls, inheritance, references, ambiguity confidence, binary/generated/vendor exclusions, symlink escape, file and repository caps, and serialization caps.

- [ ] **Step 2: Implement deterministic scanners and module resolution**

Use dependency-free lexical scanners with language adapters. Never execute repository code or store source bodies. Resolve exact paths first, conventional module candidates second, unique symbols third, and mark every non-exact relationship with explicit confidence.

- [ ] **Step 3: Implement atomic incremental graph persistence**

Enumerate tracked and non-ignored untracked files with Git argument arrays. Hash bounded content, reuse unchanged immutable file shards, atomically swap the manifest/snapshot, recover the prior graph after interrupted builds, and garbage-collect only unreachable shards.

- [ ] **Step 4: Implement compact graph operations**

Implement freshness/status, lexical plus structural query, bounded context, inbound/outbound impact, Git change-impact, and architecture map. Enforce default/max entity, traversal, file, repository-byte, and serialized-response budgets; report truncation and unresolved relationships.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs`
Expected: PASS.

```bash
git add plugins/openwiki/src/graph-*.ts plugins/openwiki/src/graph.ts plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs
git commit -m "feat: add native incremental code graph"
```

### Task 4: CLI, MCP, and Claude hook adapters

**Files:**
- Create: `plugins/openwiki/src/cli.ts`
- Create: `plugins/openwiki/src/mcp.ts`
- Create: `plugins/openwiki/src/hook.ts`
- Create: `plugins/openwiki/bin/openwiki`
- Create: `plugins/openwiki/bin/openwiki.cmd`
- Create: `plugins/openwiki/.codex-plugin/mcp.json`
- Create: `plugins/openwiki/.claude-plugin/mcp.json`
- Create: `plugins/openwiki/hooks/hooks.json`
- Create: `plugins/openwiki/tests/integration/cli.test.mjs`
- Create: `plugins/openwiki/tests/integration/mcp.test.mjs`
- Create: `plugins/openwiki/tests/integration/hook.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-3B application operations.
- Produces: CLI commands named after each operation, MCP server methods `initialize`, `ping`, `tools/list`, `tools/call`, and SessionStart hook JSON.

- [ ] **Step 1: Write failing process-level adapter tests**

Spawn real Node processes. Assert JSON stdout, silent stderr on success, stable non-zero errors, newline-delimited MCP lifecycle, 13-operation inventory including `graph`, tool annotations, path-with-spaces behavior, and read-only hook behavior.

- [ ] **Step 2: Implement CLI parsing without a dependency**

Reject unknown/repeated flags, validate required values, accept envelope from file or stdin, and never interpolate shell text.

- [ ] **Step 3: Implement MCP server**

Negotiate client protocol version when supported, expose static tools, validate every tool input, return tool failures with `isError: true`, and never write protocol diagnostics to stdout.

- [ ] **Step 4: Implement hook and launchers**

Hook emits additional context only for initialized wiki. POSIX and Windows launchers resolve their own plugin directory.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/cli.test.mjs plugins/openwiki/tests/integration/mcp.test.mjs plugins/openwiki/tests/integration/hook.test.mjs`
Expected: PASS.

```bash
git add plugins/openwiki/src plugins/openwiki/bin plugins/openwiki/.codex-plugin/mcp.json plugins/openwiki/.claude-plugin/mcp.json plugins/openwiki/hooks plugins/openwiki/tests/integration
git commit -m "feat: expose OpenWiki through CLI and MCP"
```

### Task 5: Native plugin surfaces, skills, and documentation

**Files:**
- Create or modify: `plugins/openwiki/.codex-plugin/plugin.json`
- Create: `plugins/openwiki/.claude-plugin/plugin.json`
- Create: `plugins/openwiki/skills/openwiki/SKILL.md`
- Create: `plugins/openwiki/skills/openwiki-init/SKILL.md`
- Create: `plugins/openwiki/skills/openwiki-update/SKILL.md`
- Create: `plugins/openwiki/skills/openwiki-query/SKILL.md`
- Create: `plugins/openwiki/skills/openwiki-graph/SKILL.md`
- Create: `plugins/openwiki/skills/openwiki-ingest/SKILL.md`
- Create: `plugins/openwiki/skills/openwiki-ops/SKILL.md`
- Create: `plugins/openwiki/README.md`
- Create: `plugins/openwiki/SECURITY.md`
- Create: `plugins/openwiki/PRIVACY.md`
- Create: `plugins/openwiki/UPSTREAM.md`
- Create: `plugins/openwiki/UPSTREAM_LICENSE`
- Create: `plugins/openwiki/THIRD_PARTY_NOTICES.md`
- Create: `plugins/openwiki/CHANGELOG.md`
- Create: `plugins/openwiki/LICENSE`
- Test: `plugins/openwiki/tests/packaging/structure.test.mjs`

**Interfaces:**
- Consumes: CLI/MCP operations from Task 4.
- Produces: discoverable Codex/Claude skills and valid marketplace-installable plugin metadata.

- [ ] **Step 1: Write failing packaging and skill-contract test**

Assert manifests, relative paths, skill frontmatter, no placeholders, no external runtime references, exact source kinds, privacy/injection rules, and pinned upstream commit.

- [ ] **Step 2: Finalize both manifests and marketplaces**

Use plugin name `openwiki`, plugin version `0.1.0`, publisher `Giulio Leone`, marketplace `openwiki-local`, and no asset fields until real assets exist.

- [ ] **Step 3: Write complete host-neutral skills**

Each skill defines triggers, preconditions, exact operation sequence, evidence, error recovery, mutation boundary, and completion proof. Include Codex root derivation and Claude `${CLAUDE_PLUGIN_ROOT}` paths. The graph skill must prefer fresh compact graph evidence before broad scans and disclose heuristic confidence, diagnostics, and truncation.

- [ ] **Step 4: Write security, privacy, install, update, uninstall, and attribution docs**

Separate local deterministic proof from authenticated external connector proof. Preserve upstream MIT license and deny endorsement.

- [ ] **Step 5: Validate and commit surfaces**

Run: `node --test plugins/openwiki/tests/packaging/structure.test.mjs`
Expected: PASS.

```bash
git add .agents .claude-plugin plugins/openwiki/.codex-plugin plugins/openwiki/.claude-plugin plugins/openwiki/skills plugins/openwiki/*.md plugins/openwiki/LICENSE plugins/openwiki/UPSTREAM_LICENSE plugins/openwiki/tests/packaging
git commit -m "feat: package OpenWiki for Codex and Claude Code"
```

### Task 6: Installer and real end-to-end journeys

**Files:**
- Create: `plugins/openwiki/scripts/install.mjs`
- Create: `plugins/openwiki/scripts/uninstall.mjs`
- Create: `plugins/openwiki/scripts/validate.mjs`
- Create: `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs`
- Create: `plugins/openwiki/tests/e2e/plugin-clients.e2e.test.mjs`
- Create: `plugins/openwiki/tests/fixtures/sample-repo/`

**Interfaces:**
- Consumes: complete plugin.
- Produces: idempotent `--codex`, `--claude`, `--all`, `--dry-run`, validation, and uninstall flows plus objective E2E artifacts.

- [ ] **Step 1: Write failing installer and journey tests**

Use isolated config/data homes. Runtime journey: real multi-language Git repo, native graph build/status/query/context/map/impact/changes, incremental graph refresh, init, write content, finalize, grounded search, source ingestion for seven kinds, source change, update, no-op, doctor, schedule, cross-process query, purge.

- [ ] **Step 2: Implement safe installer/uninstaller**

Invoke documented client commands with argument arrays, detect existing marketplace ownership, never overwrite unrelated configuration, and support dry-run JSON.

- [ ] **Step 3: Implement repository validator**

Run build-artifact freshness, manifest/marketplace structure, executable bits, license, placeholder, secret, external-path, and generated-file checks.

- [ ] **Step 4: Run real client validation/smoke**

Run Codex official validator and marketplace install/list in an isolated or safely named configuration. Run `claude plugin validate --strict`, `claude --plugin-dir`, and install/details when authentication permits. Record exact blockers instead of substituting mock proof.

- [ ] **Step 5: Run E2E and commit**

Run: `npm --prefix plugins/openwiki run test:e2e`
Expected: PASS for deterministic runtime and every available client smoke; authenticated remote connector checks may be SKIP only with explicit reason.

```bash
git add plugins/openwiki/scripts plugins/openwiki/tests/e2e plugins/openwiki/tests/fixtures
git commit -m "test: prove OpenWiki installation and journeys"
```

### Task 7: Final quality gate and two clean reviews

**Files:**
- Modify only files required by findings.
- Create: `artifacts/verification/final-report.md`

**Interfaces:**
- Consumes: integrated repository.
- Produces: final objective evidence and clean-review record.

- [ ] **Step 1: Run complete gate**

```bash
npm --prefix plugins/openwiki ci
npm --prefix plugins/openwiki run format:check
npm --prefix plugins/openwiki run lint
npm --prefix plugins/openwiki run typecheck
npm --prefix plugins/openwiki run build:check
npm --prefix plugins/openwiki test
npm --prefix plugins/openwiki run test:e2e
node plugins/openwiki/scripts/validate.mjs
```

Expected: every command exits `0`.

- [ ] **Step 2: Run plugin-client validators and inspect generated evidence**

Expected: Codex validator/install/list and Claude strict validator/load details match manifests; unavailable live auth checks are explicitly separated.

- [ ] **Step 3: Review cycle 1**

Review security, correctness, architecture, dead code, UX contracts, tests, packaging, docs, and diff. Fix every finding and restart full gate.

- [ ] **Step 4: Review cycle 2**

Repeat fresh review. If any finding appears, fix it, restart full gate, and require two new consecutive clean reviews.

- [ ] **Step 5: Write and commit final evidence**

```bash
git add .
git commit -m "chore: complete OpenWiki dual-host verification"
```

Expected report: changes, architecture, command results, artifacts, regression scope, both review outcomes, and exact limitations.

### Task 8: Private GitHub publication

**External target:** `giulioleone097/openwiki-codex-claude-plugin`

**Interfaces:**
- Consumes: final clean local history and Task 7 evidence.
- Produces: private GitHub repository, canonical `origin`, integrated default branch, and remote SHA/visibility proof.

- [ ] **Step 1: Verify publication preconditions**

Confirm `gh` authentication, active owner, clean intended scope, validator/secret scan, remote ownership, and target repository visibility. Existing conflicting remote or non-private target is a hard stop.

- [ ] **Step 2: Create or reuse only the authorized private repository**

Create without generated README/license/gitignore when absent. Never delete, overwrite, make public, rewrite unrelated history, create releases, or add secrets.

- [ ] **Step 3: Push the integrated history without force**

Push the completed branch, fast-forward the canonical `main` branch only after final verification, set upstream tracking, and make `main` the default branch.

- [ ] **Step 4: Verify remote truth**

Use GitHub API/CLI plus `git ls-remote` to prove owner/name, `PRIVATE` visibility, description, default branch, remote URL, and exact local/remote commit equality.
