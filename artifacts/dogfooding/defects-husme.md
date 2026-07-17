# Defect register — Husme dogfooding (T0.2)

Numbering: `DF-H1`…`DF-H6`. Severity scale: blocker / major / minor. Evidence paths reference the target's directory names only (no source or business logic quoted).

## DF-H1 — `context` collapses every Git failure mode into one opaque code on an unborn-HEAD repository

**Severity:** major

**Symptom:** `node cli.js context --root /Users/giulioleone/Documents/Husme --json` fails on a repository with zero commits (`git rev-parse HEAD` errors with an unborn-branch failure), and the CLI reports a single generic code with no distinguishing detail:

```
{"ok":false,"error":{"code":"GIT_FAILURE","message":"Unable to collect Git repository evidence."}}
```

**Root cause:** `src/git.ts` `collectGitContext` wraps every `runGit` call in one try/catch and rethrows `GIT_FAILURE` for anything that isn't the `INVALID_ARGUMENT` previous-head-format check — this conflates "repository has no commits yet" (`git rev-parse HEAD` on an unborn branch), "not a git repository," "git binary missing," "command timeout," and "output exceeds the 1MB budget" into one code and one message.

**Impact:** A brand-new repository before its first commit is a common, legitimate state. Both `openwiki-init/SKILL.md` step 3 and `openwiki-update/SKILL.md` step 2 call `context` unconditionally as part of the documented procedure, and neither skill's "Error recovery" section names a path for `GIT_FAILURE`. `init` itself does not depend on `context` succeeding (confirmed: `init` succeeded independently on this same root), so the CLI's own scaffolding still works, but any agent following the skill script literally hits an unhandled, underspecified error at the `context` step.

**Reproduction:** `node "<plugin>/dist/cli.js" context --root /Users/giulioleone/Documents/Husme --json` (ms=122, rc=2).

**Suggested direction for Wave B:** distinguish at minimum "unborn HEAD / no commits" from other git failures with its own machine code (e.g. `GIT_NO_COMMITS`), and document a no-commits recovery path in `openwiki-init`/`openwiki-update`.

## DF-H2 — Graph build silently and completely omits embedded/nested Git repositories, with zero diagnostic signal

**Severity:** major

**Symptom:** When `--root` is a directory whose working tree contains an embedded Git repository (a plain subdirectory with its own `.git`, not registered via `.gitmodules`), the graph builder's file enumeration never descends into it. Verified: `hausme-tech-interview-pr` (27 real git-tracked source files, its own commit history) is **completely absent** from every graph response rooted at the parent `Husme` directory — `build`, `status`, `map`, `query`, `context`, `impact`, and `changes` were all grepped for the literal substring `hausme-tech-interview-pr`; **zero matches across all six response bodies**, including inside the `diagnostics` arrays (390 diagnostics total in the build, none referencing it).

**Root cause:** `src/graph-store.ts` `enumerateRepositoryMetadata` enumerates files via `git ls-files -z --cached --others --exclude-standard` run with cwd = the given root. Git treats a nested `.git` directory as a repository boundary and reports it as a single opaque untracked directory entry rather than descending into it (the same behavior a plain `git status` shows). The plugin's enumeration code has no special handling for this case — it is silently subject to whatever git itself does, with no post-hoc check for "does this untracked entry contain its own `.git`?"

**Impact:** A graph that reports `available:true, fresh:true` and healthy counts gives no signal that an entire real sub-project was excluded. This directly undermines the documented guarantee that a healthy index's incompleteness is at least *disclosed* via diagnostics/truncation — here there is no disclosure at all. Realistic triggers: vendored/embedded sub-projects, a stray `git clone` left inside another repo's working tree, monorepo layouts that use plain nested checkouts instead of registered submodules. Directly demonstrated in Step-5 Question 4 of the main report: a synthesis pass would have no way to know this gap exists without independently running `git ls-files`/`find` by hand.

**Reproduction:** `graph --root /Users/giulioleone/Documents/Husme --action build --json` → `fileCount:31` (only `hausme-tech-interview-main`'s content); confirmed via grep across `build`, `map --limit 50`, `query --query quotation --limit 20`, `context --target <file> --limit 20`, `impact --target <file> --direction both --depth 2 --limit 20`, `changes --limit 20`.

**Suggested direction for Wave B:** detect untracked entries that are themselves Git repository roots (presence of `.git`) during enumeration and emit an explicit diagnostic (e.g. `EMBEDDED_REPOSITORY_SKIPPED` with the path) rather than silent omission.

## DF-H3 — `finalize` timestamp validation silently rejects valid, non-millisecond-precision ISO-8601 timestamps

**Severity:** minor (correctness/interoperability, not a security or data-integrity issue — but undocumented and non-obvious)

**Symptom:**

```
--started-at "2026-07-14T07:58:08.307541Z"   (Python datetime.isoformat(), 6-digit fractional seconds — valid ISO-8601)
→ {"ok":false,"error":{"code":"INVALID_STATE","message":"Wiki state updatedAt must be a canonical ISO-8601 timestamp."}}

--started-at "2026-07-14T07:58:25.944Z"      (JS Date.toISOString(), 3-digit fractional seconds)
→ succeeds
```

**Root cause:** the timestamp validator (in `contracts.ts`, wiki-state parsing path) accepts only the exact `Date.toISOString()` shape (`YYYY-MM-DDTHH:mm:ss.sssZ`, exactly 3 fractional digits), not the broader ISO-8601 standard the error message implies ("canonical ISO-8601" reads as "ISO-8601," which permits any fractional-second precision, `+00:00`-style offsets, etc.).

**Impact:** Any non-JS caller constructing `--started-at`/`--completed-at` (Python tooling, shell `date -u +%Y-%m-%dT%H:%M:%S.%NZ`, other agent runtimes) is likely to produce a technically-valid-ISO-8601 timestamp that this CLI rejects, with an error message that does not disclose the actual required precision — forcing trial and error to discover the JS-specific shape. Not documented in README.md, CHANGELOG.md, or any `SKILL.md` reviewed.

**Reproduction:** both commands above, run against `/Users/giulioleone/Documents/Husme`, `finalize --command init --run-id <uuid> --summary "..." --json`.

**Suggested direction for Wave B:** either broaden acceptance to standard ISO-8601 (parse with a tolerant parser and re-serialize canonically) or make the error message state the exact required pattern.

## DF-H4 — `context`'s no-op change-detection depends on a caller obligation (`--previous-head`) that is easy to omit and invisible in the response shape

**Severity:** minor

**Symptom:** `context --root <repo-with-commits> --json` (no `--previous-head`) returns a non-empty `changedPaths` array even when the working tree is clean and nothing has changed since a prior wiki build — because without `--previous-head`, `changedPaths`/`commitsSincePreviousHead` fall back to "file list of the last 20 commits" (`git log --max-count=20 --name-only`), which is non-empty for any repository with real history. The same call **with** `--previous-head <lastGitHead>` correctly returns `changedPaths: []` when nothing changed. Both cases produce the identically-shaped `changedPaths: string[]` field, with no marker distinguishing "true diff since previous head" from "recent-history fallback."

**Root cause:** `src/git.ts` `collectGitContext` — `changedPathOutput` is computed from `git diff --name-only <previousHead>..HEAD` when `previousHead` is supplied, else from `git log --max-count=20 --name-only --format=` (last 20 commits' file list, unconditionally).

**Impact:** `openwiki-update/SKILL.md` step 2–3 says "Run `context` using the same mode/root... If context reports no changed evidence, run `check`, return a no-op result" without stating that `--previous-head` (threaded from the wiki state's `lastGitHead`) is *required* for that no-op branch to ever be reachable. A caller that omits it (plausible: the flag isn't called out as mandatory) can never observe a true no-op, permanently defeating the documented optimization and potentially causing unnecessary rewrite/finalize cycles.

**Reproduction:** on `Husme/hausme-tech-interview-pr` (HEAD `3d78ab8d…`): `context --root <pr-root> --json` → `changedPaths` has 27 entries; `context --root <pr-root> --previous-head 3d78ab8d8e1704329e434b5c20d3593c2d5926b6 --json` → `changedPaths: []`.

**Suggested direction for Wave B:** either make `--previous-head` a required-by-convention parameter documented explicitly in `openwiki-update/SKILL.md`, or add a response field (e.g. `comparisonMode: "since-previous-head" | "recent-history"`) so callers can tell which semantics they received.

## DF-H5 — `graph map`'s `cycles` field surfaced a duplicated single-node self-loop with no confidence qualifier

**Severity:** minor (not root-caused within this session's timebox)

**Symptom:** `graph --action map --limit 50 --json` on the `Husme` top-level build returned `cycles: [["<path>/repository.py"], ["<path>/repository.py"]]` — the exact same single-file path, listed twice, as two separate "cycles." A cycle of length 1 (a self-reference) can legitimately represent recursion, but the exact duplication of the same single-node entry, combined with the scanner's very broad heuristic "references" edge rule (`src/graph-scan.ts`: any capitalized identifier — `/\b([A-Z][A-Za-z0-9_$]*)\b/gu` — is recorded as a `references` edge with `heuristic` confidence), raises the possibility that this is heuristic-confidence naming-coincidence noise rather than a genuine dependency cycle. Unlike `edges`, the `cycles` field carries no per-entry `confidence` label, so a consumer cannot tell exact/resolved cycles from heuristic-only ones.

**Reproduction:** `graph --mode code --root /Users/giulioleone/Documents/Husme --action map --limit 50 --json`, `cycles` field in the response.

**Suggested direction for Wave B:** root-cause whether this specific duplication is a dedup bug in cycle detection, and consider tagging `cycles` entries with the same confidence taxonomy already used for `edges`.

## DF-H6 — Full graph-build wall-clock time varies 50×+ across similarly-sized corpora, apparently correlated with a large gitignored sibling directory

**Severity:** minor (performance observation, not root-caused; flagged given the PRD's explicit <60s scale target)

**Symptom:** three full builds of comparably-sized real corpora:

| Root | Files scanned | Wall-clock |
|---|---|---|
| `hausme-tech-interview-main` (contains a 12MB gitignored `.venv`), cold | 31 | 56,174 ms |
| same root, immediately rerun (incremental) | 0 changed (31 unchanged) | 667 ms |
| `hausme-tech-interview-pr` (no large ignored sibling), full | 27 | 1,149 ms |

**Observation:** the only structural difference between the 56.2s run and the two sub-1.2s runs is the presence of a large (12MB, thousands of entries) `.gitignore`-excluded `.venv` directory alongside the scanned content in the *first* run only. `git`'s untracked-file scan (part of `enumerateRepositoryMetadata`'s `git ls-files --others --exclude-standard` and the parallel `git status --porcelain` call) must still traverse enough of the filesystem to confirm directory-level exclusion, and this cost did not recur on the immediate incremental rerun of the identical root — consistent with a one-time filesystem/OS-cache warming cost rather than a per-invocation algorithmic cost, but this was not conclusively isolated from confounding factors (this session's machine was under measured heavy concurrent load, `uptime` load average 14.5, during parts of this investigation).

**Impact:** if this scales with the size of gitignored content (not just the count of *scanned* files), real repositories with large `node_modules`/`.venv`/`vendor` trees — extremely common — could see "cold" full-build times far outside the PRD's <60s target even though the resulting graph itself stays small. This was not reproduced under controlled (isolated, low-load) conditions in this session.

**Reproduction:** timings above; exact commands in `artifacts/dogfooding/2026-07-14-husme.md` section "Graph: build, status, query, context, impact, changes, map".

**Suggested direction for Wave B:** re-measure under controlled load with a large synthetic gitignored directory sibling to isolate whether traversal cost scales with ignored-content size, and if so, consider short-circuiting known directory-level `.gitignore` patterns (`.venv/`, `node_modules/`, etc.) before filesystem traversal rather than relying solely on git's own exclusion machinery.
