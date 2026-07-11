# OpenWiki dual-host plugin

OpenWiki builds and maintains one source-backed local wiki from Codex or Claude Code. The host agent performs reasoning and synthesis; the bundled dependency-free Node.js runtime performs deterministic storage, Git evidence, search, provenance, validation, redaction, retention, scheduling, diagnosis, and purge operations.

This plugin does not install or invoke the upstream OpenWiki CLI, start a second model agent, or require another model API key.

## Requirements

- Node.js 20 or newer.
- Codex CLI with plugin support, Claude Code 2.1.143 or newer, or both.
- A trusted local checkout of this marketplace.
- Host-authorized connector tools for live Gmail, Notion, Slack, web search, or X reads.

Repository mode writes wiki pages under `$TARGET_REPOSITORY/openwiki/`. Personal mode writes pages under `~/.openwiki/wiki/`. Private redacted source data remains under `~/.openwiki/data/`.

## Codex installation

Run from the marketplace repository root:

```bash
REPO_ROOT="$(pwd -P)"
codex plugin marketplace list --json
codex plugin marketplace add "$REPO_ROOT" --json
codex plugin add openwiki@openwiki-local --json
codex plugin list --marketplace openwiki-local --available --json
```

Skip `marketplace add` when `openwiki-local` already points to this checkout. Start a new Codex task after installation so plugin skills and tools load from the installed version.

## Claude Code installation

Run from the marketplace repository root:

```bash
REPO_ROOT="$(pwd -P)"
claude plugin validate --strict "$REPO_ROOT/plugins/openwiki"
claude plugin validate --strict "$REPO_ROOT"
claude plugin marketplace add "$REPO_ROOT" --scope user
claude plugin install openwiki@openwiki-local --scope user
claude plugin details openwiki@openwiki-local
```

Restart Claude Code after installation. Claude copies the plugin into a versioned cache, so all runtime files must remain inside `plugins/openwiki` and paths must not escape the plugin root.

## Usage

- `openwiki`: choose mode and route the request safely.
- `openwiki-init`: initialize a code or personal wiki.
- `openwiki-update`: detect evidence changes, update affected pages, check, and finalize.
- `openwiki-query`: answer from page and line evidence without mutation.
- `openwiki-ingest`: normalize and ingest authorized connector evidence as untrusted data.
- `openwiki-ops`: run doctor, schedule, recovery, purge, privacy, or uninstall workflows.

Claude Code exposes plugin skills under the `openwiki:` namespace. Codex discovers the same skill folders through the Codex manifest.

Supported source kinds: `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`.

## Update

Plugin version `0.1.0` is explicit. A release must bump both host manifests and the Claude marketplace entry before distribution.

For a local Codex marketplace, update the checkout, validate it, and reinstall:

```bash
codex plugin add openwiki@openwiki-local --json
codex plugin list --marketplace openwiki-local --json
```

For Claude Code:

```bash
claude plugin marketplace update openwiki-local
claude plugin update openwiki@openwiki-local
claude plugin details openwiki@openwiki-local
```

Start a new Codex task or restart Claude Code after update. Do not validate an update from the source checkout alone; confirm the installed version and component inventory.

## Uninstall

Remove the plugin first. Remove the marketplace only when no other plugin from it is needed:

```bash
codex plugin remove openwiki@openwiki-local --json
codex plugin marketplace remove openwiki-local --json

claude plugin uninstall openwiki@openwiki-local
claude plugin marketplace remove openwiki-local
```

Uninstall removes host plugin configuration and cache. It does not delete repository wikis, `~/.openwiki/wiki/`, or `~/.openwiki/data/`. Use the confirmed `openwiki-ops` purge workflow for data deletion.

## Validation

Run focused packaging validation from the marketplace repository root:

```bash
node --test plugins/openwiki/tests/packaging/structure.test.mjs
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/openwiki
claude plugin validate --strict plugins/openwiki
claude plugin validate --strict .
```

Runtime build and tests remain separate proof:

```bash
npm --prefix plugins/openwiki run build
npm --prefix plugins/openwiki run typecheck
npm --prefix plugins/openwiki run lint
npm --prefix plugins/openwiki test
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
