# Privacy

## Data locations

- Code wiki: `<selected-repository>/memex/`.
- Personal wiki: `~/.memex/wiki/`.
- Private redacted source data and run history: `~/.memex/data/<workspace-id>/` or `~/.memex/data/personal/`.
- Private native code graph index: `~/.memex/data/<workspace-id>/graph/` in code mode only.
- Host-neutral schedule intent and private runtime state: under the corresponding `~/.memex/` scope.

Repository wikis may be committed by the user. Private source data is outside repositories by default and must not be committed.

## Credentials

Memex never stores provider tokens. Gmail, Notion, Slack, web-search, and X authentication remains in tools already authorized by Codex or Claude Code. The plugin stores only a connector kind and optional non-secret account hint or query provenance after validation and redaction.

## Source processing

The runtime treats source material as untrusted data, removes known credential patterns, strips NUL bytes, enforces size limits, hashes redacted canonical content, deduplicates records, and retains at most the latest 20 runs per source unless the user configures a lower limit.

Source kinds are `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`. Private message bodies should not be printed as proof. Wiki synthesis should include only information necessary for the approved scope.

## Native code graph privacy

The code graph is implemented by Memex itself and has no external graph dependency. A build reads bounded repository source without executing it, excludes dependency, generated, VCS, wiki, and private Memex paths, and does not follow repository symlinks. It stores only private graph metadata, content hashes, nodes, edges, and diagnostics under `~/.memex/data/<workspace-id>/graph/`; it never stores source-file bodies and never writes source or wiki files. The graph reports freshness, corruption/incompatibility, diagnostics, confidence, unresolved edges, caps, and truncation so absence from an index is not presented as absence from the repository.

## Telemetry and model use

The deterministic runtime sends no telemetry and starts no model. Reasoning uses the active Codex or Claude Code session. The plugin does not invoke the upstream OpenWiki model stack and does not require a separate model API key.

## Migration from legacy storage

The `migrate` operation moves an existing `~/.openwiki/` root (from the plugin's prior distribution as `openwiki`) to `~/.memex/`. It performs a same-filesystem atomic move when possible, falls back to a verified copy-then-remove otherwise, and leaves a `~/.openwiki/MIGRATED.md` tombstone naming the new root. It never merges or deletes data when both roots already hold content; it reports `MIGRATION_CONFLICT` instead so the user can resolve it manually.

## Deletion and retention

Use `memex-ops` to inspect exact purge scope before deletion. Supported scopes remove private raw data, schedules, or the personal wiki without following symlinks. Uninstalling the plugin does not delete user wiki or private data. Partial deletion must be reported path by path.

## Proof boundary

Local deterministic proof demonstrates envelope handling, redaction, storage, retention, and path safety with controlled inputs. Authenticated external connector proof requires a real user-authorized read from the named host service. A fixture or locally submitted envelope cannot establish that authenticated external connector proof.

When live authorization is unavailable, report the local contract as verified and the external retrieval as unverified. Never substitute sample data and claim it came from a user's account.
