# Memex plugin

Memex builds a source-backed local wiki from Codex or Claude Code. Host agent performs synthesis; bundled Node.js runtime handles deterministic storage, Git evidence, retrieval, graph, provenance, validation, redaction, schedules, diagnostics, and purge.

Current source release: `0.3.3`.

Requirements: Node.js 20+, trusted marketplace checkout, and supported Codex or Claude Code client. Core is connector-free; host-authorized connectors are optional and needed only for live ingestion.

## Codex installation

Codex, from marketplace repository root:

```bash
REPO_ROOT="$(pwd -P)"
codex plugin marketplace list --json
codex plugin marketplace add "$REPO_ROOT" --json
codex plugin add memex@memex-local --json
codex plugin list --json
codex plugin list --marketplace memex-local --available --json
```

`plugin list --json` proves installed state; `--available` proves marketplace availability. Skip marketplace add when `memex-local` already targets this checkout. Start a new Codex task after install/update.

## Claude Code installation

Claude Code, from marketplace repository root:

```bash
REPO_ROOT="$(pwd -P)"
claude plugin validate --strict "$REPO_ROOT/plugins/memex"
claude plugin validate --strict "$REPO_ROOT"
claude plugin marketplace add "$REPO_ROOT" --scope user
claude plugin install memex@memex-local --scope user
claude plugin details memex@memex-local
```

Restart Claude Code after install/update.

## Validation

Seven skills should be available: `memex`, `memex-init`, `memex-update`, `memex-query`, `memex-graph`, `memex-ingest`, `memex-ops`.

Package declares no npm `bin`; no `memex` executable is installed on PATH. Use host skills or:

```bash
node "<plugin-root>/dist/cli.js" status --mode code --root "<repository>" --json
```

Derive `<plugin-root>` from loaded skill path. If catalog exposure is incomplete, start new task/restart host, then collect plugin-list and loaded skill-root evidence before reinstall or manifest edits. Cause remains unresolved host exposure boundary; truncation/filtering is not proven.

Run focused source validation from repository root:

```bash
npm --prefix plugins/memex run build
npm --prefix plugins/memex run typecheck
npm --prefix plugins/memex run lint
node --test plugins/memex/tests/e2e/plugin-clients.e2e.test.mjs
node --test plugins/memex/tests/packaging/structure.test.mjs
node plugins/memex/scripts/validate.mjs
```

Run validator after build so committed `dist/` is the runtime being checked. Version parity covers package, lockfile, Codex/Claude manifests, both repository marketplaces, dashboard initialize metadata, and MCP initialize response.

## MemexBench-Code v1

MemexBench-Code is a frozen local retrieval gate (MX-04-01) with four representative repositories, 224 stratified queries, qrels, expected citations, and immutable split files. It runs lexical, vector, graph, and hybrid retrieval with RRF and signal-first strategy ablations, reporting quality, cold/warm latency, index size, update cost, token count, model revision, and data-quality rates:

```bash
npm --prefix plugins/memex run memexbench -- --check
npm --prefix plugins/memex run memexbench -- --check --output /tmp/memexbench-code-v1.json
npm --prefix plugins/memex run memexbench -- --check --no-vector
```

The benchmark is dependency-free, network-free, and reproducible from a clean checkout with Node.js 20+. Evidence IDs are content-versioned from project/source identity and excerpt boundaries; top-k fusion deduplicates by ID and keeps prior-version provenance. Frozen split bytes are SHA-256 gated, and graph ablation expands from bounded ranked lexical/vector seeds mapped through stable node identities. The raw report exposes `metrics.evidenceIdentity`, a deterministic `metrics.noVector` run, `metrics.byCategory`, `metrics.bySignal`, and `gate.failuresByCategory`/`gate.failuresBySignal` for inspectable retrieval health. Any failing category or signal makes the overall gate fail even if aggregate recall passes. `benchmarks/memexbench-code-v1/BASELINE.md` documents the immutable baseline and update policy; benchmark outputs are raw evidence and are not committed.

## Optional MCP App dashboard

MCP clients may render a bundled, dependency-free Memex dashboard from `ui://memex/dashboard.html`. The existing 16 data tools and their dispatcher remain canonical and keep their text-content result envelope without output schemas or structured content. A separate read-only `render_memex_dashboard` tool accepts only a closed, bounded prepared view model; it does not run data operations or access workspace/private storage. Only that render tool links the UI resource and returns output-schema-shaped structured content.

The app uses the stable MCP Apps `ui/*` lifecycle first: it sends the exact `2026-01-26` initialize fields, becomes ready only after a successful response, and acknowledges host teardown before stopping lifecycle updates. Feature-detected `window.openai` compatibility remains optional. The UI has loading, empty, error, and success states; renders supplied text only through safe DOM APIs; and has no network dependency. Source validation proves the raw MCP resource/render handshake and executable local bridge lifecycle, not a public endpoint or ChatGPT developer-mode rendering.

`resources/read` accepts only the required `uri` plus an optional standard request `_meta` object. `_meta.progressToken`, when present, must be a string or finite number; namespaced extension entries remain inside `_meta`. Foreign top-level fields, non-object metadata, and malformed progress tokens return JSON-RPC invalid params.

Contract references: [Build an app](https://learn.chatgpt.com/docs/build-app), [decoupled UI pattern](https://developers.openai.com/apps-sdk/build/chatgpt-ui#decoupled-pattern), [tool descriptor metadata](https://developers.openai.com/apps-sdk/reference#_meta-fields-on-tool-descriptor), [MCP Apps relationship](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt#how-this-relates-to-the-apps-sdk), and the [stable MCP Apps lifecycle specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Graph lifecycle

When a build finds unchanged indexed content—including no-indexed-content repositories—it atomically refreshes Git/source identities in the manifest without changing graph generation. Existing enrichment, `member-of` community edges, analysis state, and a matching graph report remain valid. Strict wiki check emits `STALE_GRAPH_REPORT` when `memex/graph-report.md` and the current graph manifest disagree on generation.

## Update

Update marketplace checkout, reinstall `memex@memex-local`, then start a new Codex task or restart Claude Code. Verify installed plugin version and loaded skill root; source-checkout validation alone is insufficient.

## Documentation

- [Quickstart](../../memex/quickstart.md)
- [Architecture](../../memex/architecture.md)
- [Source map](../../memex/source-map.md)
- [Workflows](../../memex/workflows.md)
- [Domain concepts](../../memex/domain-concepts.md)
- [Operations and known limitations](../../memex/operations.md)
- [Integrations](../../memex/integrations.md)
- [Testing and release proof](../../memex/testing.md)

Code mode writes repository pages and portable state under `memex/`, canonical Memex blocks in repository `AGENTS.md`/`CLAUDE.md`, and private workspace data under `~/.memex/data/<workspace-id>/`. Personal mode writes `~/.memex/wiki/` plus private data under `~/.memex/data/personal/` and has no graph. Mutating wiki workflows use preflight check, one finalize, then strict check.

## Uninstall

```bash
codex plugin remove memex@memex-local --json
codex plugin marketplace remove memex-local --json

claude plugin uninstall memex@memex-local --scope user
claude plugin marketplace remove memex-local --scope user
```

Uninstall removes host configuration/cache, not repository wikis or private Memex data. Use confirmed `memex-ops` purge with explicit scope for data deletion.

## Proof boundaries

Local deterministic proof covers source, manifests, runtime operations, and tests actually run. Installed-cache proof requires execution from host cache. Authenticated connector proof requires current authorized host read; a validated envelope alone is insufficient.

## Security and privacy

Read [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), [UPSTREAM.md](UPSTREAM.md), [UPSTREAM_LICENSE](UPSTREAM_LICENSE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Never store credentials in wiki, envelopes, logs, screenshots, tests, or artifacts. Source-checkout proof, installed-cache proof, and authenticated connector proof are separate claims.
