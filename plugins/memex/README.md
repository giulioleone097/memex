# Memex dual-host plugin

Memex builds and maintains one source-backed local wiki from Codex or Claude Code. The host agent performs reasoning and synthesis; the bundled dependency-free Node.js runtime performs deterministic storage, Git evidence, search, provenance, validation, redaction, retention, scheduling, diagnosis, and purge operations.

This plugin does not install or invoke the upstream OpenWiki CLI, start a second model agent, or require another model API key.

## Requirements

- Node.js 20 or newer.
- Codex CLI with plugin support, Claude Code 2.1.143 or newer, or both.
- A trusted local checkout of this marketplace.
- Host-authorized connector tools for live Gmail, Notion, Slack, web search, or X reads.

Repository mode writes wiki pages under `$TARGET_REPOSITORY/memex/`. Personal mode writes pages under `~/.memex/wiki/`. Private redacted source data remains under `~/.memex/data/`.

## Codex installation

Run from the marketplace repository root:

```bash
REPO_ROOT="$(pwd -P)"
codex plugin marketplace list --json
codex plugin marketplace add "$REPO_ROOT" --json
codex plugin add memex@memex-local --json
codex plugin list --marketplace memex-local --available --json
```

Skip `marketplace add` when `memex-local` already points to this checkout. Start a new Codex task after installation so plugin skills and tools load from the installed version.

## Claude Code installation

Run from the marketplace repository root:

```bash
REPO_ROOT="$(pwd -P)"
claude plugin validate --strict "$REPO_ROOT/plugins/memex"
claude plugin validate --strict "$REPO_ROOT"
claude plugin marketplace add "$REPO_ROOT" --scope user
claude plugin install memex@memex-local --scope user
claude plugin details memex@memex-local
```

Restart Claude Code after installation. Claude copies the plugin into a versioned cache, so all runtime files must remain inside `plugins/memex` and paths must not escape the plugin root.

## Usage

- `memex`: choose mode and route the request safely.
- `memex-init`: initialize a code or personal wiki.
- `memex-update`: detect evidence changes, update affected pages, check, and finalize.
- `memex-query`: answer from page and line evidence without mutation.
- `memex-graph`: inspect a code repository with the private Memex-native graph before broad source reads.
- `memex-ingest`: normalize and ingest authorized connector evidence as untrusted data.
- `memex-ops`: run doctor, schedule, recovery, purge, privacy, or uninstall workflows.

Claude Code exposes plugin skills under the `memex:` namespace. Codex discovers the same skill folders through the Codex manifest.
Its manifest resolves the bundled MCP server through the canonical root `.mcp.json`; Claude keeps its separate `.claude-plugin/mcp.json` contract.

Supported source kinds: `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`.

## Native code graph

Code mode stores the private graph under `~/.memex/data/<workspace-id>/graph/`. Graph construction reads bounded repository source, never executes repository code, and stores metadata, hashes, nodes, edges, and diagnostics—not source-file bodies. It does not write source, wiki, instruction, dependency, or credential files. Personal mode has no repository graph.

The graph CLI grammar is:

```text
node "<plugin-root>/dist/cli.js" graph --mode code --root <repository> --action <build|status|query|context|impact|changes|map> [flags] --json
```

Seven actions are available:

- `build`: initial or incremental private-index refresh; `--force` is the only action-specific flag and requests a clean rebuild.
- `status`: report schema, counts, diagnostics, Git fingerprint, scanner version, and freshness.
- `query`: bounded lexical/structural retrieval; requires `--query "<terms>"`.
- `context`: bounded file/symbol neighborhood; requires `--target "<file-or-symbol>"`.
- `impact`: bounded traversal; requires `--target`, accepts `--direction inbound|outbound|both` and `--depth 1..5`.
- `changes`: map a Git diff or working-tree delta; accepts optional `--base <git-ref>`.
- `map`: return compact modules, entry points, hubs, cycles, and cross-module flows.

Query-like actions accept bounded `--limit 1..100`; the runtime defaults are compact. The workflow runs graph `status` first, refreshes only when missing/stale and authorized, then prefers `map`, `query`, `context`, `impact`, or `changes` before any targeted source read. Results disclose exact, resolved, or heuristic confidence, diagnostics, unresolved edges, and truncation; a healthy index does not prove complete semantic coverage.

MCP hosts use the same graph contract: JSON-RPC `initialize`, `notifications/initialized`, `tools/list`, then `tools/call` for the graph operation advertised by `tools/list`. Arguments mirror the CLI action and flags. The tool name is discovered from the configured server; it is not hard-coded in this documentation.

## Migrating from OpenWiki

This plugin was previously distributed as `openwiki` and stored data under `~/.openwiki/`. Run the `migrate` operation once to move existing local storage to `~/.memex/` before using any other operation:

```bash
node "<plugin-root>/dist/cli.js" migrate --json
```

Migration is idempotent: it moves `~/.openwiki/` to `~/.memex/` atomically when only the legacy root exists, leaves a `~/.openwiki/MIGRATED.md` tombstone pointing at the new root, and reports `migrated: false` as a safe no-op on every later run. It returns `MIGRATION_CONFLICT` if both roots already contain data and refuses to guess which one is authoritative. `doctor` reports an un-migrated legacy root as a warning with the same instruction.

## Update

Plugin version `0.2.0` is explicit. A release must bump both host manifests and the Claude marketplace entry before distribution.

For a local Codex marketplace, update the checkout, validate it, and reinstall:

```bash
codex plugin add memex@memex-local --json
codex plugin list --marketplace memex-local --json
```

For Claude Code:

```bash
claude plugin marketplace update memex-local
claude plugin update memex@memex-local
claude plugin details memex@memex-local
```

Start a new Codex task or restart Claude Code after update. Do not validate an update from the source checkout alone; confirm the installed version and component inventory.

## Uninstall

Remove the plugin first. Remove the marketplace only when no other plugin from it is needed:

```bash
codex plugin remove memex@memex-local --json
codex plugin marketplace remove memex-local --json

claude plugin uninstall memex@memex-local
claude plugin marketplace remove memex-local
```

Uninstall removes host plugin configuration and cache. It does not delete repository wikis, `~/.memex/wiki/`, or `~/.memex/data/`. Use the confirmed `memex-ops` purge workflow for data deletion.

## Validation

Run focused packaging validation from the marketplace repository root:

```bash
node --test plugins/memex/tests/packaging/structure.test.mjs
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/memex
claude plugin validate --strict plugins/memex
claude plugin validate --strict .
```

Runtime build and tests remain separate proof:

```bash
npm --prefix plugins/memex run build
npm --prefix plugins/memex run typecheck
npm --prefix plugins/memex run lint
npm --prefix plugins/memex test
```

## Proof boundaries

- Local deterministic proof covers manifests, paths, state, Git evidence, source-envelope validation, redaction, retention, search, schedules, doctor, purge boundaries, CLI, MCP, and host loading when their tests run.
- Authenticated external connector proof exists only when the current host actually reads the named account/service with user authorization.
- A locally validated source envelope does not prove a live Gmail, Notion, Slack, web-search, or X retrieval.
- Installation proof, source-checkout proof, and installed-cache runtime proof are separate claims.

## Security, privacy, and origin

Read [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), and [UPSTREAM.md](UPSTREAM.md). Upstream OpenWiki attribution and license are preserved in [UPSTREAM_LICENSE](UPSTREAM_LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Limitations

- Live external reads depend on host capabilities and user authorization.
- The plugin stores host-neutral schedule intent; creation of host automation is a separate authorized action.
- The agent-native transformation preserves OpenWiki outcomes and formats, not the upstream Ink interface, provider onboarding, LangChain/DeepAgents runtime, OAuth implementation, or SQLite checkpoint engine.
