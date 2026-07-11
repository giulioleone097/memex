# OpenWiki Dual-Host Plugin Objective

## Central objective

Deliver a production-quality, self-contained OpenWiki plugin repository for Codex and Claude Code. Both hosts must use one interoperable local wiki and one deterministic runtime while keeping their manifests, marketplace lifecycle, hooks, and path rules separate.

The host agent performs all reasoning and synthesis. The plugin must not install or invoke the upstream OpenWiki CLI, start a second LLM agent, require an additional model API key, or depend on source files outside the installed plugin.

## Expected final result

- Repository-local marketplaces install `plugins/openwiki` into Codex and Claude Code.
- A dependency-free Node.js 20+ runtime is already compiled in the plugin archive.
- Code mode creates and maintains `<repository>/openwiki/`.
- Personal mode creates and maintains `~/.openwiki/wiki/`.
- Codex and Claude Code can initialize, update, query, ingest, audit, diagnose, schedule, and purge the same wiki state.
- Seven upstream logical source types are supported through host-native read adapters and one validated ingestion envelope: `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`.
- No secret is persisted in repository files, raw metadata, logs, or tool output.

## Required deliverables

1. Codex manifest plus repository marketplace.
2. Claude Code manifest plus repository marketplace, MCP config, and read-only freshness hook.
3. Shared skills for routing, init, update, query, ingestion, and operations.
4. Strict TypeScript domain/application runtime compiled to dependency-free ESM.
5. CLI and MCP adapters with the same validated contracts and typed errors.
6. Atomic storage, path confinement, Git evidence, source provenance, redaction, retention, schedules, doctor, purge, and instruction-file synchronization.
7. Installer, uninstaller, validator, security/privacy/license documentation, and upstream attribution pinned to commit `326a307203345128a60b92a356978c46e2992df3`.
8. Unit, integration, real filesystem/Git/process E2E, plugin validation, and available live-host smoke evidence.
9. Final verification report and two consecutive clean reviews.

## Priorities

1. Correct behavior and data integrity.
2. Security, privacy, and path confinement.
3. Zero additional LLM/runtime dependency.
4. Codex/Claude interoperability.
5. Installability and recovery.
6. User experience and documentation.

## Constraints

- Node.js `>=20`; no runtime npm dependencies.
- Runtime artifacts must be inside `plugins/openwiki`; no `../` references or external checkout dependency.
- Separate Codex and Claude manifests/configuration; shared core and skills only.
- Runtime validation at every external boundary; no `any`, ignored errors, silent fallback, or unsafe casts.
- Writes limited to the selected wiki root, OpenWiki private data root, and explicitly requested instruction/schedule files.
- Raw connector data stays outside repositories under `~/.openwiki/data/` and is treated as untrusted.
- External authentication remains host-native; plugin never implements or stores provider OAuth tokens.
- MIT terms and upstream attribution preserved; no claim of upstream endorsement.
- Meaningful user-facing behavior requires non-mocked E2E proof. External authenticated services may only be claimed when live credentials and tools are actually available.
- Full quality gate runs after integration, not after every parallel slice.

## Completion conditions

Work succeeds only when all applicable conditions hold:

- Clean-checkout build, typecheck, lint, format check, unit, integration, E2E, and packaging validation pass.
- Codex validator accepts the plugin and Codex installs it from the repository marketplace.
- Claude `plugin validate --strict` accepts plugin and marketplace; local load/install exposes skills, MCP, bin, and hook.
- Init, no-op update, changed update, grounded query, seven source envelopes, doctor, schedule state, purge, and cross-host state compatibility are proven.
- Path traversal, symlink escape, malformed state, duplicate writes, concurrent writes, prompt-injection-shaped source data, secret redaction, retention, and partial-failure recovery are covered.
- Installed plugin works after original source checkout is unavailable.
- No dead code, debug output, stale duplicate implementation, secret, or unexpected generated file remains.
- Review cycle 1 is clean after fixes; review cycle 2 is consecutively clean.
- Limitations distinguish local deterministic proof, plugin-client proof, and unavailable external authenticated proof.

## Execution ownership

| Workstream | Owner | Complexity role | Output | Dependency |
|---|---|---|---|---|
| Upstream assessment | `upstream_architecture` | architecture/high | Verified transformation boundary | Complete |
| Codex surface | `codex_surface` | integration/moderate | Manifest, marketplace, install contract | Complete |
| Claude surface | `claude_surface` | integration/moderate | Manifest, MCP, hook, cache contract | Complete |
| Core runtime | `upstream_architecture` continuation | architecture/high | Domain/application modules and unit tests | Shared contracts |
| Plugin packaging and skills | `codex_surface` continuation | integration/moderate | Both marketplaces/manifests, skills, docs | Repository scaffold |
| Host adapters | `claude_surface` continuation | integration/moderate | CLI, MCP, hook, bin, adapter tests | Shared contracts |
| Sources, ops, E2E, integration | Main orchestrator | architecture/high | Secure source/ops services and final proof | Parallel slices |

Model names requested by the user are recorded as complexity roles. Current collaboration tooling does not expose per-thread model selection, so no unverifiable model assignment is claimed.

