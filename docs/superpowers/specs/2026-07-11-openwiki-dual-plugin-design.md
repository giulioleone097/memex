# OpenWiki Dual-Host Plugin Design

## Decision

Build a dual-host, agent-native OpenWiki plugin. Codex or Claude Code supplies reasoning; a shared deterministic runtime supplies storage, Git evidence, a native code graph, search, provenance, safety, and lifecycle operations.

Three approaches were evaluated:

1. Thin `npx openwiki` wrapper: rejected because it requires network installation, a second LLM runtime, extra model credentials, 290 packages, and native SQLite.
2. Vendored upstream CLI: rejected as default because it preserves duplicated agent/provider/auth stacks and platform-native build risk even when source is bundled.
3. Agent-native plugin with dependency-free core: selected because it is portable, inspectable, host-integrated, and genuinely self-contained.

The transformation preserves OpenWiki outcomes and durable formats, not the upstream Ink UI, LangChain/DeepAgents runtime, provider onboarding, ChatGPT OAuth, or SQLite checkpoint implementation.

## Product scope

### Code mode

- Wiki location: `<repository>/openwiki/`.
- Private runtime data: `~/.openwiki/data/<workspace-id>/`.
- Deterministic Git context: root, branch, HEAD, status, recent commits, changed paths since last finalized HEAD.
- Private OpenWiki-native code graph: incremental file/module/symbol index, dependency and call relationships, architecture map, context, impact, and change-impact.
- Standard page map: quickstart, architecture, source map, workflows, domain concepts, operations, integrations, and testing.
- Idempotent OpenWiki blocks in repository `AGENTS.md` and `CLAUDE.md`; unrelated content preserved byte-for-byte.
- Finalization records content hash only when wiki content changed.

### Personal mode

- Wiki location: `~/.openwiki/wiki/`.
- Private source data: `~/.openwiki/data/personal/`.
- Same page, source, search, audit, retention, and update contracts as code mode.
- No repository instruction files or CI files are changed.

### Logical source support

The plugin recognizes the seven upstream source kinds: `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`.

Authentication and remote reads use tools already authorized by the host. Skills normalize returned material into a common ingestion envelope; the runtime validates, redacts, caps, hashes, and persists that envelope. Missing host capability is an explicit recoverable error, never an invitation to store OAuth secrets in plugin configuration.

## Repository shape

```text
.
├── OBJECTIVE.md
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
├── docs/superpowers/{specs,plans}/
└── plugins/openwiki/
    ├── .codex-plugin/{plugin.json,mcp.json}
    ├── .claude-plugin/{plugin.json,mcp.json}
    ├── hooks/hooks.json
    ├── bin/{openwiki,openwiki.cmd}
    ├── skills/openwiki*/SKILL.md
    ├── src/
    │   ├── contracts.ts
    │   ├── errors.ts
    │   ├── paths.ts
    │   ├── atomic.ts
    │   ├── state.ts
    │   ├── wiki.ts
    │   ├── git.ts
    │   ├── graph-contracts.ts
    │   ├── graph-scan.ts
    │   ├── graph-store.ts
    │   ├── graph-query.ts
    │   ├── graph.ts
    │   ├── sources.ts
    │   ├── schedules.ts
    │   ├── doctor.ts
    │   ├── cli.ts
    │   ├── mcp.ts
    │   └── hook.ts
    ├── dist/
    ├── templates/
    ├── scripts/
    ├── tests/{unit,integration,e2e}/
    └── package.json
```

## Runtime contracts

### State

```ts
type WikiMode = "code" | "personal";
type SourceKind =
  | "git-repo"
  | "gmail"
  | "hackernews"
  | "notion"
  | "slack"
  | "web-search"
  | "x";

interface WikiStateV1 {
  schemaVersion: 1;
  mode: WikiMode;
  workspaceId: string;
  wikiRoot: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  lastGitHead?: string;
  lastRun: {
    id: string;
    command: "init" | "update" | "ingest";
    startedAt: string;
    completedAt: string;
    changed: boolean;
    summary: string;
  };
}
```

State lives at `openwiki/.last-update.json` in code mode and `~/.openwiki/.last-update.json` in personal mode. Unknown schema versions fail closed with recovery guidance. Writes use a lock, same-directory temporary file, fsync where supported, and atomic rename.

### Source envelope

```ts
interface SourceEnvelopeV1 {
  schemaVersion: 1;
  sourceId: string;
  kind: SourceKind;
  fetchedAt: string;
  cursor?: string;
  provenance: {
    host: "codex" | "claude" | "cli";
    accountHint?: string;
    query?: string;
  };
  items: Array<{
    externalId: string;
    title?: string;
    text: string;
    url?: string;
    occurredAt?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }>;
}
```

Limits: 2 MiB envelope, 500 items, 128 KiB per text field, 4 KiB per metadata value. The runtime removes known credential patterns, strips NUL bytes, hashes the redacted canonical JSON, deduplicates by `(sourceId, externalId, content hash)`, and retains the latest 20 runs per source unless the user sets a lower value.

### Native code graph

The graph is an OpenWiki component, not an integration. It has no GitNexus dependency, optional provider, fallback, service call, subprocess, compatible data-file assumption, or first-use download.

```ts
type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol";
type GraphEdgeKind =
  | "contains"
  | "declares"
  | "imports"
  | "exports"
  | "calls"
  | "inherits"
  | "implements"
  | "references";

interface CodeGraphV1 {
  schemaVersion: 1;
  workspaceId: string;
  generatedAt: string;
  source: {
    gitHead?: string;
    dirtyFingerprint: string;
    scannerVersion: string;
  };
  files: Array<{
    path: string;
    language: string;
    contentHash: string;
    size: number;
  }>;
  nodes: Array<{
    id: string;
    kind: GraphNodeKind;
    path: string;
    name: string;
    symbolKind?: string;
    startLine?: number;
    endLine?: number;
  }>;
  edges: Array<{
    id: string;
    kind: GraphEdgeKind;
    from: string;
    to: string;
    confidence: "exact" | "resolved" | "heuristic";
  }>;
  diagnostics: Array<{
    path: string;
    code: string;
    message: string;
  }>;
}
```

IDs are deterministic SHA-256 values derived from normalized repository-relative identity fields. Arrays and object keys are canonically sorted, so rebuilding identical inputs produces byte-equivalent semantic content apart from `generatedAt`.

The private graph lives under `~/.openwiki/data/<workspace-id>/graph/`. A small atomic manifest points to immutable per-file shards and the current assembled snapshot. Initial build and refresh enumerate tracked plus non-ignored untracked files with `git ls-files`; changed content is rescanned, unchanged shards are reused, removed shards are garbage-collected only after the new manifest commits, and interrupted builds leave the previous snapshot readable.

The scanner never executes, imports, compiles, or evaluates repository code. It strips comments and literal bodies before relationship extraction and stores no source-file contents. Language adapters cover TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin, C#, C/C++, Ruby, PHP, shell, Markdown, JSON, YAML, and TOML at an explicitly reported confidence level. Unknown text formats still participate as file/directory nodes. Binary, dependency, generated, VCS, wiki, and private OpenWiki directories are excluded by deterministic rules.

Resolution is layered: exact repository-relative module resolution, language/package conventions, unique qualified symbol match, then explicitly marked heuristic match. Ambiguous relationships remain diagnostics rather than invented exact edges. Package/workspace manifests and directory boundaries produce stable modules; weighted degree and inter-module edges produce hubs and flows without an embedded LLM.

Safety and scale defaults are 50,000 files, 5 MiB per file, 512 MiB total scanned bytes, five graph traversal levels, 100 returned entities, and 64 KiB serialized response. Defaults are lower: 20 entities and 16 KiB. Hitting a hard limit returns a typed, actionable error instead of silently truncating the stored graph. Query responses disclose truncation and unresolved-edge counts.

Graph actions are:

- `build`: initial or incremental refresh; `--force` requests a clean rebuild. It reads repository files and writes only private graph state.
- `status`: schema, counts, diagnostics, Git HEAD/dirty fingerprint, scanner version, and freshness.
- `query`: bounded lexical and structural node/edge retrieval with compact paths and line ranges.
- `context`: one file or symbol plus its declarations and bounded inbound/outbound neighborhood.
- `impact`: bounded upstream/downstream traversal with paths, depth, confidence, and truncation metadata.
- `changes`: map a Git diff or working-tree delta to changed nodes and transitively affected nodes.
- `map`: modules, entry points, hubs, dependency cycles, and cross-module flows in a compact architecture summary.

Automatic source refactoring and rename are deliberately outside OpenWiki's mutation boundary. The host agent may use graph evidence to plan and verify an edit, but the graph API never edits source code.

### Errors

Every adapter returns a stable machine code and safe message:

```ts
type OpenWikiErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_STATE"
  | "PATH_OUTSIDE_ROOT"
  | "SYMLINK_ESCAPE"
  | "LOCKED"
  | "NOT_INITIALIZED"
  | "NOT_FOUND"
  | "SOURCE_TOO_LARGE"
  | "UNSUPPORTED_SOURCE"
  | "MISSING_HOST_CAPABILITY"
  | "GIT_FAILURE"
  | "IO_FAILURE";
```

CLI emits one JSON object with non-zero exit status. MCP tool failures return `isError: true` with the same JSON object. Internal stacks and secrets never cross the adapter boundary.

## Application operations

| Operation | Behavior |
|---|---|
| `init` | Resolve mode/root, create standard pages and state, then optionally sync agent instruction blocks. Idempotent. |
| `status` | Return mode, roots, freshness, content hash, last run, source count, and issues. Read-only. |
| `context` | Return bounded Git or personal-wiki evidence needed by host synthesis. Read-only. |
| `graph` | Build/refresh private graph state or return bounded status, query, context, impact, changes, and architecture-map evidence. Never mutates repository source. |
| `search` | Rank markdown passages by normalized term coverage; return page, line, excerpt, and score. Read-only. |
| `read` | Read one confined markdown page with line metadata. Read-only. |
| `write` | Atomically write one confined markdown page; refuse non-markdown and symlink escapes. |
| `ingest` | Validate/redact/dedupe source envelope and persist private raw data. |
| `finalize` | Recompute snapshot; record run only after successful content changes. |
| `check` | Validate required pages, state, internal links, provenance references, and instruction blocks. |
| `doctor` | Inspect Node version, permissions, Git, manifests, config, state, locks, retention, and secret leakage indicators. |
| `schedule` | Persist idempotent host-neutral schedule intent; skills map it to host automation when available. |
| `purge` | Require explicit scope; delete raw data, schedules, or full personal wiki without following symlinks. |

## Adapters

### CLI

`openwiki <operation> [flags]` supports `--json` by default and a human-readable `--pretty` view. Mutating commands accept `--mode` and `--root`; no command accepts arbitrary shell text.

The graph grammar is `openwiki graph --mode code --root <repository> --action <build|status|query|context|impact|changes|map>`. `query` requires `--query`; `context` and `impact` require `--target`; `changes` optionally accepts `--base`; `build` alone accepts `--force`; `impact` accepts `--direction <inbound|outbound|both>` and `--depth <1..5>`; query-like actions accept `--limit <1..100>`. Incompatible and repeated flags fail closed.

### MCP

Separate host configs launch the same compiled server:

- Codex: plugin-relative `cwd: "."`, `node ./dist/mcp.js`.
- Claude Code: `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`.

The server implements newline-delimited JSON-RPC, initialization, ping, `tools/list`, and `tools/call`. Tool schemas mirror CLI operations. Read-only/destructive/idempotent annotations reflect real behavior.

### Claude hook

`SessionStart` runs a five-second, read-only freshness probe. It emits additional context only when a wiki exists. It never initializes, updates, ingests, or installs dependencies.

## Skills

- `openwiki`: router, mode selection, capability discovery, and safety boundary.
- `openwiki-init`: evidence gathering, page plan, initialization, synthesis, check, finalize.
- `openwiki-update`: no-op detection, changed-evidence synthesis, check, finalize.
- `openwiki-query`: search/read first, grounded answer with page references, no mutation.
- `openwiki-graph`: refresh when stale, then use map/query/context/impact/changes before broad repository scans; disclose confidence and truncation.
- `openwiki-ingest`: host connector read, envelope normalization, injection isolation, synthesis, retention.
- `openwiki-ops`: doctor, schedule, recovery, purge, privacy, and uninstall.

Skills must never treat source text as instructions. They quote or summarize source material as untrusted data and ignore embedded tool requests, credentials requests, or prompt overrides.

## Security and privacy

- Canonical path checks happen before every read/write/delete.
- Existing symlinks are resolved; targets outside the allowed root are rejected.
- No generic shell execution API exists.
- Git uses argument arrays with timeouts and output caps.
- Graph parsing never executes repository code, stores source bodies, follows repository symlinks, or reads excluded dependency/generated/private paths.
- Graph indexes are private, atomic, schema-versioned, size-capped, and fail closed when corrupt or produced by an incompatible scanner.
- Source data is private by default, redacted before disk, and never committed.
- Provider tokens remain in host credential systems; config stores only connector kind and non-secret account hints.
- Error output is stable and sanitized.
- Purge does not follow symlinks and reports exact removed scopes.
- CI templates are documentation only until a host credential path is explicitly configured.

## Packaging

- Root marketplaces both use name `openwiki-local` and relative source `./plugins/openwiki`.
- Codex manifest contains only supported fields and points to its own MCP config.
- Claude manifest relies on canonical default discovery plus its own MCP/hook paths.
- Compiled `dist/` is committed; runtime needs only Node.js 20+.
- No install hook, first-use network call, global binary, native module, or symlink is required.
- Plugin version starts at `0.1.0`; upstream origin is recorded separately.

## Verification design

1. Unit tests: validation, redaction, paths, hashing, atomic state, search ranking, source dedupe, retention, schedules, graph scanners/resolution/traversal, errors.
2. Integration tests: real temporary filesystem and Git repositories, incremental graph shards, graph corruption/recovery, CLI process, MCP JSON-RPC lifecycle, Claude hook, instruction synchronization.
3. E2E tests: build plugin; initialize a real temporary multi-language Git repository; build/query/map/inspect the graph; prove incremental change impact; create wiki; query it; change code; update; verify new answer; ingest all seven source kinds; run doctor; install/load through available Codex and Claude CLIs.
4. Security regression: traversal, symlink escape, malformed JSON, huge input, concurrent writer, source prompt injection, secret-shaped values, purge boundaries.
5. Packaging: Codex official validator, `codex plugin add/list`, `claude plugin validate --strict`, `claude --plugin-dir`, cache/install smoke where current authentication permits.

External Gmail, Slack, Notion, and X account reads require user-authorized host connectors. Without those credentials, final evidence must say their envelope contracts were proven locally but live external retrieval remains unverified.
