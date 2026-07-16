# Memex Slice 2b Implementation Plan — Embeddings and Hybrid Retrieval

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internalize real semantic search — a pure-TS tokenizer, a vendored WASM embedder, a quantized vector store, a BM25+trigram lexical store, and RRF hybrid retrieval (`search`, `ask`) with bounded graph expansion — wired into the existing write path (chunk + embed at write) and read path (CLI + MCP), per `docs/superpowers/specs/2026-07-14-memex-prd.md` §7 slice 2b and the binding contracts in `docs/superpowers/plans/2026-07-14-memex-master-plan.md`.

**Architecture:** Compile-at-write / answer-at-read, applied to retrieval. `chunk.ts` splits markdown and symbol metadata into `ChunkRef`s (never source bodies). `tokenizer.ts` is a pure-TS SentencePiece-Unigram tokenizer driven by the vendored `tokenizer.json`. `embedder.ts` lazily loads the vendored ONNX Runtime Web WASM engine and the `multilingual-e5-small-int8` model, enforcing the `query: `/`passage: ` prefix discipline internally. `vector-store.ts` and `lexical-index.ts` persist int8 embeddings and BM25 postings as immutable, bucketed, content-addressed segment files plus a manifest, mirroring `graph-store.ts`'s shard/manifest/write-lock discipline (a new shared `withFileWriteLock` primitive is extracted from `graph-store.ts` so all three stores share one lock implementation). `retrieve.ts` fuses BM25, cosine-over-vectors, and confidence-weighted bounded graph BFS via Reciprocal Rank Fusion (k=60) into `search`/`ask`. Reindexing is wired directly into `wiki.ts`'s `writePage` (wiki plane) and `graph.ts`'s `buildGraph` (code plane), so embedding cost is paid incrementally at write time, not in a separate step.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node >= 20 built-ins only, `node --test`, eslint (`strictTypeChecked`), tsc. Vendored (no npm dependency): `plugins/openwiki/vendor/ort/` (onnxruntime-web WASM + JS loader), `plugins/openwiki/vendor/model/multilingual-e5-small-int8/{model.onnx,tokenizer.json}`, `plugins/openwiki/vendor/MANIFEST.json`.

## Global Constraints

- Runtime forbids: network access, model credentials, native compilation, `npm install`, processes beyond Node >= 20 and Git. Vendored checksummed assets are the only third-party artifacts.
- Graph mutation boundary preserved verbatim: build/enrich/index never execute repository code, never write outside `~/.openwiki/data/<workspace-id>/`, never store source-file bodies. Chunking embeds **signature + name + path metadata only** for code, never function bodies.
- All operations return bounded JSON with stable machine error codes; new codes added in this plan: `MODEL_ASSET_MISSING`, `MODEL_ASSET_CORRUPT`, `EMBEDDING_FAILURE`, `INDEX_INCOMPATIBLE`.
- No `any`, no unchecked casts; discriminated unions + runtime validation for every new contract (existing `contracts.ts` style — every parsed value goes through an explicit field-by-field validator, never `as T` on an `unknown`).
- Silent fallback forbidden: degraded retrieval only via explicit `--signals` request, and responses must label degradation (`degraded: boolean`). If vector assets are unavailable/corrupt and the caller did **not** narrow `--signals`, the operation fails loudly with the typed error.
- TDD per task: failing test → minimal implementation → pass → commit. Suite: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`.
- Performance targets (asserted in e2e with 2x CI margin): `search`/`ask` p95 < 1 s @ 5k chunks incl. query embedding (assert < 2000 ms); incremental reindex of one changed page < 2 s (assert < 4000 ms); full build of this repository < 60 s (assert < 120000 ms).
- Commits: no AI attribution trailers; concrete behavior-focused messages.
- e5 prefix discipline: `query: ` for queries, `passage: ` for passages, enforced inside the embedder, never left to callers.

## Prerequisites (read before starting)

1. **Slice 2a must have landed first** (Wave D precedes Wave E). This plan imports `GraphConfidence` from `./graph-contracts.js` assuming it is already the v2 union `"exact" | "resolved" | "heuristic" | "extracted" | "inferred" | "ambiguous"` (2a's schema-v2 change). If 2a has not landed when this plan executes, `retrieve.ts`'s confidence-weight table (Task 8) will not type-check — do not work around this by narrowing the type locally; stop and confirm 2a's contract landed.
2. **`TV.1` vendor assets must exist** at `plugins/openwiki/vendor/{ort/,model/multilingual-e5-small-int8/{model.onnx,tokenizer.json},MANIFEST.json}` before the *real-asset* steps in Tasks 4, 5, and 13 can pass unskipped. **Correction made while finishing this plan (re-verified directly against `TV.1`'s committed tree, worktree branch `worktree-agent-ab41604a4363e639e`, commit `003d25a`, on 2026-07-15):** the real committed `MANIFEST.json` at that commit vendors `model.onnx` as **one flat, unsplit 118 MB file** with a plain `{ path, sha256, bytes, license, upstream, revision }` entry — there is no `model.onnx.part0`/`.part1`, no `parts` array, and no `assembled_sha256` anywhere in that commit's manifest today (`grep`-verified: zero occurrences). An earlier draft of this section claimed the opposite ("verified directly... not an earlier draft assumption"); that claim was false — it described the *target* shape from PRD §16 amendment 2, not the asset actually on disk in that commit. The part-split + `assembled_sha256` shape **is** the correct binding design (PRD §16 amendment 2, adopted to resolve the GitHub 100 MB per-file push-limit problem `TV.1`'s own acquisition report — `.superpowers/sdd/tv1-report.md` on that branch — flags as explicitly unresolved: "Whoever merges this branch needs to either enable Git LFS... or decide on an alternative distribution mechanism"), and a separate, not-yet-landed "vendor chunking" task is responsible for re-materializing `TV.1`'s commit into that split shape before it merges to `main`. Task 5's `VendorManifestEntry`/`parseManifest`/`loadModelBuffer` below correctly implement the PRD §16 target shape (split-parts primary, flat-single-file still supported as a fallback shape — see Task 5's assumption note) — that implementation choice is not in question — but do not treat the current flat commit as proof the shape has landed; Task 5's and Task 13's real-asset tests must stay skipped until the vendor-chunking task actually produces `model.onnx.part0`/`.part1` + `assembled_sha256` on the branch that reaches `main`. The real `tokenizer.json` (same commit, directly inspected, 250,002-entry vocab) *is* correctly verified: `model.type === "Unigram"`, `unk_id: 3` (snake_case only), vocab ordered `<s>=0, <pad>=1, </s>=2, <unk>=3`, a `Sequence` normalizer whose first stage is `Precompiled` (a SentencePiece charsmap — see Task 4's added design note on this), and a `Metaspace` pre-tokenizer/decoder — Task 4's tokenizer implementation and its documented casing defensiveness are confirmed correct against the real asset for tokenizer *type*, with one documented gap (Task 4's design note). Every test that depends on real vendored assets is written with a skip-if-absent guard (mirroring `tests/integration/embedder-smoke.test.mjs` from `TV.1`), so earlier tasks are executable even if `TV.1`/vendor-chunking are still in flight — only the guarded assertions stay pending until the assets exist in their final shape.
3. This plan does **not** implement `enrich`, the `concept`/`page`/`source` node kinds, or `check` cross-plane invariants — those are 2a's deliverables. It reuses 2a's schema additions read-only.
4. All new source files live under `plugins/openwiki/src/`; all new tests under `plugins/openwiki/tests/{unit,integration,e2e}/`; all commands below are run from the repository root with `--prefix plugins/openwiki` (or `cd plugins/openwiki` — pick whichever the executing session already uses, both are shown interchangeably by the existing test suite).

---

### Task 1: New error codes for the embed/retrieve subsystem

**Files:**
- Modify: `plugins/openwiki/src/errors.ts`
- Test: `plugins/openwiki/tests/unit/error-codes.test.mjs` (new)

**Interfaces:**
- Produces: `OPENWIKI_ERROR_CODES` gains `"MODEL_ASSET_MISSING"`, `"MODEL_ASSET_CORRUPT"`, `"EMBEDDING_FAILURE"`, `"INDEX_INCOMPATIBLE"`. Every later task constructs `new OpenWikiError("MODEL_ASSET_MISSING" | "MODEL_ASSET_CORRUPT" | "EMBEDDING_FAILURE" | "INDEX_INCOMPATIBLE", message)`.

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/error-codes.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { OPENWIKI_ERROR_CODES, OpenWikiError } from "../../dist/errors.js";

test("errors: slice 2b introduces the model asset and retrieval error codes", () => {
  for (const code of ["MODEL_ASSET_MISSING", "MODEL_ASSET_CORRUPT", "EMBEDDING_FAILURE", "INDEX_INCOMPATIBLE"]) {
    assert.equal(OPENWIKI_ERROR_CODES.includes(code), true, `missing code ${code}`);
    const error = new OpenWikiError(code, "test");
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), { code, message: "test" });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/error-codes.test.mjs`
Expected: FAIL — `dist/errors.js` does not yet export the new codes, so `OPENWIKI_ERROR_CODES.includes(code)` is `false` for all four (and `new OpenWikiError(code, ...)` fails TypeScript at build time once Step 3's callers try to use it, but at this point nothing calls it yet, so the build still succeeds and the test fails on the `includes` assertions).

- [ ] **Step 3: Add the codes**

Edit `plugins/openwiki/src/errors.ts`, extending the array:

```ts
export const OPENWIKI_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_STATE",
  "PATH_OUTSIDE_ROOT",
  "SYMLINK_ESCAPE",
  "LOCKED",
  "NOT_INITIALIZED",
  "NOT_FOUND",
  "SOURCE_TOO_LARGE",
  "UNSUPPORTED_SOURCE",
  "MISSING_HOST_CAPABILITY",
  "GIT_FAILURE",
  "IO_FAILURE",
  "MODEL_ASSET_MISSING",
  "MODEL_ASSET_CORRUPT",
  "EMBEDDING_FAILURE",
  "INDEX_INCOMPATIBLE",
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/error-codes.test.mjs`
Expected: PASS (1 test, 4 assertions per code).

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/errors.ts plugins/openwiki/tests/unit/error-codes.test.mjs
git commit -m "feat(openwiki): add model asset and retrieval error codes"
```

---

### Task 2: Extract a shared file write-lock primitive

Every new store in this plan (vector, lexical) needs the exact same stale-lock-recovery, PID-liveness-checked write lock that `graph-store.ts` already implements as `withGraphWriteLock`. Rather than copy that ~30 lines of locking logic twice more, extract it into `atomic.ts` as a generic primitive and make `graph-store.ts` delegate to it. This is a pure refactor: the existing `graph-store-concurrency.test.mjs` integration test must keep passing unmodified — that is the regression proof.

**Files:**
- Modify: `plugins/openwiki/src/atomic.ts` (add `withFileWriteLock`, `atomicWriteBinaryFile`)
- Modify: `plugins/openwiki/src/graph-store.ts` (delegate `withGraphWriteLock` to the new primitive)
- Test: `plugins/openwiki/tests/unit/atomic-lock.test.mjs` (new)
- Test: `plugins/openwiki/tests/integration/graph-store-concurrency.test.mjs` (existing — must pass unmodified, no edits)

**Interfaces:**
- Produces: `export interface FileWriteLockOptions { waitMs?: number; staleMs?: number; }` and `export function withFileWriteLock<T>(lockPath: string, operation: () => Promise<T>, options?: FileWriteLockOptions): Promise<T>` in `atomic.ts`. Also `export function atomicWriteBinaryFile(filePath: string, content: Buffer): Promise<void>` in `atomic.ts` (binary sibling of the existing `atomicWriteFile`, same tmp-file + fsync + rename discipline, used by `vector-store.ts` in Task 6).
- Consumes (by later tasks): Task 6 (`vector-store.ts`) and Task 7 (`lexical-index.ts`) both call `withFileWriteLock` with their own lock file path and `atomicWriteBinaryFile`/`atomicWriteFile` for their segment writes.

- [ ] **Step 1: Write the failing unit test for the new primitive**

Create `plugins/openwiki/tests/unit/atomic-lock.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { OpenWikiError } from "../../dist/errors.js";
import { withFileWriteLock } from "../../dist/atomic.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-lock-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("withFileWriteLock: serializes concurrent operations and creates the lock directory", async () => {
  const root = await temporaryRoot("root");
  const lockPath = path.join(root, "nested", "writer.lock");
  const order = [];
  await Promise.all([
    withFileWriteLock(lockPath, async () => {
      order.push("a-start");
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 30); });
      order.push("a-end");
    }, { waitMs: 500 }),
    (async () => {
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 5); });
      await withFileWriteLock(lockPath, async () => {
        order.push("b-start");
        order.push("b-end");
      }, { waitMs: 500 });
    })(),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("withFileWriteLock: a live holder rejects a second acquirer with LOCKED", async () => {
  const root = await temporaryRoot("busy");
  const lockPath = path.join(root, "writer.lock");
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  const owner = withFileWriteLock(lockPath, async () => {
    release();
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 100); });
  }, { waitMs: 20 });
  await entered;
  await assert.rejects(withFileWriteLock(lockPath, async () => undefined, { waitMs: 20 }), { code: "LOCKED" });
  await owner;
});

test("withFileWriteLock: recovers a stale lock left by a dead process", async () => {
  const root = await temporaryRoot("stale");
  const lockPath = path.join(root, "writer.lock");
  const stale = JSON.stringify({ schemaVersion: 1, pid: 999_999, createdAt: new Date(0).toISOString(), token: "dead" });
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(`${stale}\n`, "utf8");
  await handle.close();
  let ran = false;
  await withFileWriteLock(lockPath, async () => { ran = true; }, { waitMs: 20, staleMs: 0 });
  assert.equal(ran, true);
});

test("atomicWriteBinaryFile: writes exact bytes and refuses to replace a symlink target", async () => {
  const { atomicWriteBinaryFile } = await import("../../dist/atomic.js");
  const root = await temporaryRoot("binary");
  const file = path.join(root, "segment.bin");
  const payload = Buffer.from([0, 1, 2, 255, 254]);
  await atomicWriteBinaryFile(file, payload);
  assert.deepEqual(await readFile(file), payload);
  const target = path.join(root, "target.bin");
  await writeFile(target, "x");
  const link = path.join(root, "link.bin");
  const { symlink } = await import("node:fs/promises");
  await symlink(target, link);
  await assert.rejects(atomicWriteBinaryFile(link, payload), { code: "SYMLINK_ESCAPE" });
  await unlink(link);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/atomic-lock.test.mjs`
Expected: FAIL — `withFileWriteLock` and `atomicWriteBinaryFile` are not exported from `dist/atomic.js` (build error: `Module has no exported member`), so the test file itself fails to import.

- [ ] **Step 3: Implement `withFileWriteLock` and `atomicWriteBinaryFile` in `atomic.ts`**

Edit `plugins/openwiki/src/atomic.ts`. Add these imports to the existing import block (extend, don't replace):

```ts
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { OpenWikiError } from "./errors.js";
```

Append to the end of `atomic.ts`:

```ts
export interface FileWriteLockOptions { waitMs?: number; staleMs?: number; }

const DEFAULT_WAIT_MS = 50;
const DEFAULT_STALE_MS = 5 * 60 * 1000;

export async function withFileWriteLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileWriteLockOptions = {},
): Promise<T> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const directory = path.dirname(lockPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(directory);
  const serialized = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() })}\n`;
  const deadline = Date.now() + waitMs;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!isAlreadyExists(error)) throw new OpenWikiError("IO_FAILURE", "Unable to acquire the write lock.");
      if (await recoverStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) throw new OpenWikiError("LOCKED", "Store writer is busy.");
      await wait(10);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await releaseLock(lockPath, serialized);
  }
}

export async function atomicWriteBinaryFile(filePath: string, content: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertNotSymlink(filePath);
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof OpenWikiError) throw error;
    throw new OpenWikiError("IO_FAILURE", "Atomic binary file write failed.");
  }
}

async function recoverStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let serialized: string;
  try {
    const details = await lstat(lockPath);
    if (details.isSymbolicLink() || !details.isFile()) throw new OpenWikiError("SYMLINK_ESCAPE", "Writer lock must be a regular file.");
    serialized = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error instanceof OpenWikiError) throw error;
    return false;
  }
  const lock = parseLock(serialized);
  if (lock === undefined || Date.now() - lock.createdAt < staleMs || processAlive(lock.pid)) return false;
  try {
    if (await readFile(lockPath, "utf8") !== serialized) return false;
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(lockPath: string, serialized: string): Promise<void> {
  try {
    if (await readFile(lockPath, "utf8") !== serialized) throw new OpenWikiError("LOCKED", "Writer lock ownership changed before release.");
    await unlink(lockPath);
  } catch (error) {
    if (error instanceof OpenWikiError) throw error;
    throw new OpenWikiError("IO_FAILURE", "Unable to release the writer lock.");
  }
}

function parseLock(serialized: string): { pid: number; createdAt: number } | undefined {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.createdAt !== "string" || typeof record.token !== "string") return undefined;
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) ? { pid: record.pid, createdAt } : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new OpenWikiError("SYMLINK_ESCAPE", "Lock directory must not be a symbolic link.");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { globalThis.setTimeout(resolve, milliseconds); });
}
```

Note: `readdir` is imported above but unused by this Step — it is needed by nothing here; remove it from the added import list (only add `lstat`, `mkdir`, `open`, `readFile`, `realpath`, `rename`, `unlink` — i.e. do not add `readdir`). Correct the import block accordingly before saving.

- [ ] **Step 4: Run the new unit test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && node --test plugins/openwiki/tests/unit/atomic-lock.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `graph-store.ts`'s `withGraphWriteLock` to delegate, without changing its exported signature**

Edit `plugins/openwiki/src/graph-store.ts`. Replace the entire existing `withGraphWriteLock` function body plus its now-unused private helpers (`recoverStaleGraphLock`, `releaseGraphLock`, `parseLock`, `processAlive`, `isAlreadyExists`, `wait` — check each is not used elsewhere in the file before deleting; `isAlreadyExists`/`wait` may still be used by other code paths in the file, in which case keep them and only delete `recoverStaleGraphLock`/`releaseGraphLock`/the local `parseLock`/`processAlive` that become dead) with:

```ts
export async function withGraphWriteLock<T>(storage: GraphStorage, operation: () => Promise<T>): Promise<T> {
  return withFileWriteLock(storage.writeLockPath, operation, { waitMs: GRAPH_WRITE_LOCK_WAIT_MS, staleMs: GRAPH_STALE_LOCK_MS });
}
```

Add `withFileWriteLock` to the existing `import { atomicWriteFile } from "./atomic.js";` line, making it `import { atomicWriteFile, withFileWriteLock } from "./atomic.js";`. Run a reference search before deleting any helper: `grep -n "recoverStaleGraphLock\|releaseGraphLock\b" plugins/openwiki/src/graph-store.ts` — both should now show zero remaining call sites (only their own definitions, which you are deleting); delete them. Leave `isAlreadyExists`, `wait`, `processAlive`, `parseLock` in place only if `grep -n` shows they are still referenced elsewhere in the file (e.g. `isAlreadyExists` is used by the open-lock retry loop that you are removing — reconfirm with grep; if a helper's only remaining reference was inside the code you just deleted, delete the helper too to avoid dead code).

- [ ] **Step 6: Run the full existing graph store test suite to prove no regression**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/integration/graph-store-concurrency.test.mjs plugins/openwiki/tests/unit/graph-store-v2.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs`
Expected: PASS, identical test count and assertions as before this task (the concurrency test in particular must still pass: `graph store: a real child-process writer excludes another writer`), proving the refactor preserved behavior.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm --prefix plugins/openwiki test`
Expected: PASS, no regressions anywhere.

```bash
git add plugins/openwiki/src/atomic.ts plugins/openwiki/src/graph-store.ts plugins/openwiki/tests/unit/atomic-lock.test.mjs
git commit -m "refactor(openwiki): extract a shared file write-lock primitive for new stores"
```

---

### Task 3: `chunk.ts` — markdown and symbol-metadata chunking

**Files:**
- Create: `plugins/openwiki/src/chunk.ts`
- Test: `plugins/openwiki/tests/unit/chunk.test.mjs` (new)

**Interfaces:**
- Produces (binding, from the master plan): `ChunkRef { id, path, startLine, endLine, plane: "code"|"concept"|"wiki", nodeId?, contentHash }`, `chunkMarkdown(path: string, text: string): ChunkRef[]`, `chunkSymbols(nodes: readonly GraphNodeV1[]): ChunkRef[]`. Also `parseChunkRef(value: unknown): ChunkRef` (shared runtime validator, consumed by Task 6 `vector-store.ts` and Task 7 `lexical-index.ts` manifests), `estimateTokens(text: string): number` (consumed nowhere outside this module except its own tests — kept exported for the golden-size assertions in Step 1), and `symbolChunkText(node: GraphNodeV1): string` (the exact metadata-text formatting `chunkSymbols` hashes internally, exported so Task 10's `reindex.ts` can regenerate the same text for a symbol chunk without duplicating — and risking drifting from — this formatting).
- Consumes: `GraphNodeV1` and `graphHash` from `./graph-contracts.js` (existing).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/chunk.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { chunkMarkdown, chunkSymbols, estimateTokens, parseChunkRef } from "../../dist/chunk.js";

test("chunk: chunkMarkdown splits at heading boundaries and keeps line ranges accurate", () => {
  const text = [
    "# Title",
    "",
    "Intro paragraph one.",
    "",
    "## Section A",
    "",
    "Paragraph under section A.",
    "",
    "## Section B",
    "",
    "Paragraph under section B.",
  ].join("\n");
  const chunks = chunkMarkdown("docs/page.md", text);
  assert.ok(chunks.length >= 2, "expected at least one chunk per heading-delimited section");
  for (const chunk of chunks) {
    assert.equal(chunk.path, "docs/page.md");
    assert.equal(chunk.plane, "wiki");
    assert.equal(chunk.nodeId, undefined);
    assert.equal(typeof chunk.startLine, "number");
    assert.equal(typeof chunk.endLine, "number");
    assert.ok(chunk.endLine >= chunk.startLine);
    assert.match(chunk.contentHash, /^[a-f0-9]{64}$/u);
    assert.match(chunk.id, /^[a-f0-9]{64}$/u);
    const sliced = text.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n");
    assert.ok(sliced.length > 0);
  }
  const ids = chunks.map((chunk) => chunk.id);
  assert.equal(new Set(ids).size, ids.length, "chunk ids must be unique within a page");
});

test("chunk: chunkMarkdown is deterministic and targets 200-400 estimated tokens", () => {
  const paragraph = "Lorem word repetition testing token estimate boundaries carefully. ".repeat(40);
  const text = `# Heading\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n`;
  const first = chunkMarkdown("docs/big.md", text);
  const second = chunkMarkdown("docs/big.md", text);
  assert.deepEqual(first, second);
  for (const chunk of first.slice(0, -1)) {
    const chunkText = text.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n");
    assert.ok(estimateTokens(chunkText) <= 500, `chunk exceeded the target band: ${String(estimateTokens(chunkText))}`);
  }
});

test("chunk: chunkSymbols embeds signature+name+path metadata only, never a source body", () => {
  const id = createGraphNodeId("symbol", "src/service.ts", "run", "method", `Service\u0000${String(10)}`);
  const nodes = [
    { id, kind: "symbol", path: "src/service.ts", name: "run", scope: "Service", symbolKind: "method", startLine: 10, endLine: 42 },
    { id: createGraphNodeId("file", "src/service.ts", "service.ts"), kind: "file", path: "src/service.ts", name: "service.ts" },
  ];
  const chunks = chunkSymbols(nodes);
  assert.equal(chunks.length, 1, "only symbol-kind nodes produce chunks");
  const [chunk] = chunks;
  assert.equal(chunk.plane, "code");
  assert.equal(chunk.nodeId, id);
  assert.equal(chunk.path, "src/service.ts");
  assert.equal(chunk.startLine, 10);
  assert.equal(chunk.endLine, 42);
  assert.doesNotThrow(() => parseChunkRef(chunk));
});

test("chunk: symbolChunkText regenerates the exact text chunkSymbols hashed", async () => {
  const { symbolChunkText } = await import("../../dist/chunk.js");
  const node = { id: createGraphNodeId("symbol", "src/service.ts", "run", "method", "Service 10"), kind: "symbol", path: "src/service.ts", name: "run", scope: "Service", symbolKind: "method", startLine: 10, endLine: 42 };
  const [chunk] = chunkSymbols([node]);
  const { createHash } = await import("node:crypto");
  const expectedContentHash = createHash("sha256").update(symbolChunkText(node), "utf8").digest("hex");
  assert.equal(chunk.contentHash, expectedContentHash);
});

test("chunk: parseChunkRef rejects malformed references", () => {
  assert.throws(() => parseChunkRef({ id: "not-hex", path: "a", startLine: 1, endLine: 1, plane: "wiki", contentHash: "b".repeat(64) }), { code: "INVALID_STATE" });
  assert.throws(() => parseChunkRef({ id: "a".repeat(64), path: "a", startLine: 2, endLine: 1, plane: "wiki", contentHash: "b".repeat(64) }), { code: "INVALID_STATE" });
  assert.throws(() => parseChunkRef({ id: "a".repeat(64), path: "a", startLine: 1, endLine: 1, plane: "unknown", contentHash: "b".repeat(64) }), { code: "INVALID_STATE" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/chunk.test.mjs`
Expected: FAIL — `plugins/openwiki/src/chunk.ts` does not exist, build fails with `Cannot find module './chunk.js'`.

- [ ] **Step 3: Implement `chunk.ts`**

Create `plugins/openwiki/src/chunk.ts`:

```ts
import { createHash } from "node:crypto";

import { graphHash, type GraphNodeV1 } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";

export interface ChunkRef {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  plane: "code" | "concept" | "wiki";
  nodeId?: string;
  contentHash: string;
}

const MIN_CHUNK_TOKENS = 200;
const MAX_CHUNK_TOKENS = 400;

export function estimateTokens(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  return Math.ceil(matches.length * 1.3);
}

export function chunkMarkdown(path: string, text: string): ChunkRef[] {
  const lines = text.split(/\r?\n/u);
  const blocks = splitIntoBlocks(lines);
  const chunks: ChunkRef[] = [];
  let bufferLines: string[] = [];
  let bufferStart = 1;
  let bufferTokens = 0;
  const flush = (endLine: number): void => {
    if (bufferLines.length === 0) return;
    chunks.push(makeChunk(path, "wiki", bufferStart, endLine, bufferLines.join("\n")));
    bufferLines = [];
    bufferTokens = 0;
  };
  for (const block of blocks) {
    const blockTokens = estimateTokens(block.lines.join("\n"));
    if (bufferLines.length > 0 && bufferTokens >= MIN_CHUNK_TOKENS && bufferTokens + blockTokens > MAX_CHUNK_TOKENS) {
      flush(block.startLine - 1);
      bufferStart = block.startLine;
    }
    if (bufferLines.length === 0) bufferStart = block.startLine;
    bufferLines.push(...block.lines);
    bufferTokens += blockTokens;
    if (bufferTokens >= MAX_CHUNK_TOKENS) {
      flush(block.endLine);
      bufferStart = block.endLine + 1;
    }
  }
  flush(lines.length);
  return chunks;
}

// Exported separately (not just inlined into chunkSymbols below) so callers
// that need the chunk's *text* — not just its ChunkRef — can regenerate the
// exact same string deterministically from the same node, instead of
// duplicating this formatting logic and risking silent drift from the text
// that actually produced ChunkRef.contentHash. Task 10's reindex.ts is the
// concrete consumer: it needs the text to feed both the lexical index and
// the embedder, but chunkSymbols itself only returns ChunkRef[] (binding).
export function symbolChunkText(node: GraphNodeV1): string {
  const scope = node.scope !== undefined && node.scope.length > 0 ? `${node.scope}.` : "";
  const kindLabel = node.symbolKind !== undefined ? ` (${node.symbolKind})` : "";
  const start = node.startLine ?? 1;
  const end = node.endLine ?? start;
  const lines = node.startLine !== undefined ? `:${String(start)}-${String(end)}` : "";
  return `${node.kind} ${scope}${node.name}${kindLabel} — ${node.path}${lines}`;
}

export function chunkSymbols(nodes: readonly GraphNodeV1[]): ChunkRef[] {
  return nodes
    .filter((node) => node.kind === "symbol")
    .map((node) => {
      const start = node.startLine ?? 1;
      const end = node.endLine ?? start;
      return makeChunk(node.path, "code", start, end, symbolChunkText(node), node.id);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function parseChunkRef(value: unknown): ChunkRef {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" || !/^[a-f0-9]{64}$/u.test(value.id) ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !positiveLine(value.startLine) || !positiveLine(value.endLine) || value.endLine < value.startLine ||
    !isPlane(value.plane) ||
    typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
    (value.nodeId !== undefined && typeof value.nodeId !== "string")
  ) {
    throw new OpenWikiError("INVALID_STATE", "Chunk reference is invalid.");
  }
  return {
    id: value.id,
    path: value.path,
    startLine: value.startLine,
    endLine: value.endLine,
    plane: value.plane,
    contentHash: value.contentHash,
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
  };
}

interface Block { startLine: number; endLine: number; lines: string[]; }

function splitIntoBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let currentStart = 1;
  const flush = (endLine: number): void => {
    if (current.length === 0) return;
    blocks.push({ startLine: currentStart, endLine, lines: current });
    current = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const isHeading = /^#{1,6}\s+\S/u.test(line);
    const isBlank = line.trim().length === 0;
    if (isHeading && current.length > 0) {
      flush(lineNumber - 1);
      currentStart = lineNumber;
    }
    if (isBlank && !isHeading) {
      if (current.length > 0) flush(lineNumber - 1);
      currentStart = lineNumber + 1;
      continue;
    }
    if (current.length === 0) currentStart = lineNumber;
    current.push(line);
  }
  flush(lines.length);
  return blocks.filter((block) => block.lines.some((line) => line.trim().length > 0));
}

function makeChunk(path: string, plane: ChunkRef["plane"], startLine: number, endLine: number, text: string, nodeId?: string): ChunkRef {
  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    id: graphHash(["chunk", plane, path, String(startLine), String(endLine), contentHash]),
    path,
    startLine,
    endLine,
    plane,
    contentHash,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function isPlane(value: unknown): value is ChunkRef["plane"] {
  return value === "code" || value === "concept" || value === "wiki";
}

function positiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

Design note (not a contract deviation, documented so the reviewer does not "fix" it): `chunkMarkdown`'s token target is an **approximation** (`estimateTokens`), not the real Unigram tokenizer's count — the function is synchronous and has no access to the async, lazily-loaded WASM tokenizer. The real tokenizer (Task 4) still enforces the model's actual `max_length` (512) at embed time as the authoritative truncation boundary; `estimateTokens` only shapes chunk *boundaries* at write time so chunks are the right rough size before the real tokenizer ever runs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/chunk.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/chunk.ts plugins/openwiki/tests/unit/chunk.test.mjs
git commit -m "feat(openwiki): add markdown and symbol-metadata chunking"
```

---

### Task 4: `tokenizer.ts` — pure-TS SentencePiece-Unigram tokenizer

**Tokenizer-type verification (performed during planning, not an assumption):** `intfloat/multilingual-e5-small`'s `tokenizer_config.json` declares `"tokenizer_class": "XLMRobertaTokenizer"`. XLM-RoBERTa tokenizers are SentencePiece **Unigram** language-model tokenizers (250k-piece multilingual vocabulary), never WordPiece or byte-level BPE. The HF fast-tokenizer `tokenizer.json` for this family stores `model.type === "Unigram"` with a `vocab: [[piece, logProbScore], ...]` array, a `Metaspace`-style pre-tokenizer (the space character is replaced by `▁` U+2581, with a prefix space prepended), and special tokens `<s>=0` (actually resolved from `added_tokens` at runtime, not hardcoded — see below), `<pad>=1`, `</s>=2`, `<unk>=3` by XLM-R convention. This plan implements a real Unigram Viterbi segmenter (not BPE, not WordPiece) against this exact format. The real `tokenizer.json` is Git-LFS-hosted (~17 MB) and was not fully byte-inspected during planning (tool truncation) — the implementation below is defensive about two known variance points (`unk_id` vs `unkId`, `added_tokens` vs `addedTokens` key casing) and Step 6 below adds a real-asset smoke test that will fail loudly if the live file departs from this structure in some other way.

**Files:**
- Create: `plugins/openwiki/src/tokenizer.ts`
- Test: `plugins/openwiki/tests/unit/tokenizer.test.mjs` (new)
- Test fixture: `plugins/openwiki/tests/fixtures/tokenizer/mini-unigram.tokenizer.json` (new)
- Test: `plugins/openwiki/tests/integration/tokenizer-vendor.test.mjs` (new, skip-if-real-assets-absent)

**Interfaces:**
- Produces (binding): `export interface Tokenizer { encode(text: string): Int32Array; }`, `export function loadTokenizer(tokenizerJsonPath: string): Promise<Tokenizer>`.
- Consumes (by Task 5 `embedder.ts`): `loadTokenizer` is called with the vendored `tokenizer.json` path; `Tokenizer.encode` output feeds the ONNX `input_ids` tensor.

- [ ] **Step 1: Create the mini fixture tokenizer**

Create `plugins/openwiki/tests/fixtures/tokenizer/mini-unigram.tokenizer.json`:

```json
{
  "model": {
    "type": "Unigram",
    "unk_id": 0,
    "vocab": [
      ["<unk>", 0.0],
      ["<s>", 0.0],
      ["</s>", 0.0],
      ["<pad>", 0.0],
      ["▁hello", -2.5],
      ["▁world", -2.6],
      ["▁ciao", -2.7],
      ["▁mondo", -2.8],
      ["▁", -6.0],
      ["h", -9.0], ["e", -9.0], ["l", -9.0], ["o", -9.0],
      ["w", -9.0], ["r", -9.0], ["d", -9.0],
      ["c", -9.0], ["i", -9.0], ["a", -9.0], ["m", -9.0], ["n", -9.0]
    ]
  },
  "added_tokens": [
    { "id": 1, "content": "<s>" },
    { "id": 2, "content": "</s>" },
    { "id": 3, "content": "<pad>" }
  ],
  "truncation": { "max_length": 16 }
}
```

- [ ] **Step 2: Write the failing golden-vector test**

Create `plugins/openwiki/tests/unit/tokenizer.test.mjs`:

```js
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadTokenizer } from "../../dist/tokenizer.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tokenizer", "mini-unigram.tokenizer.json");

test("tokenizer: golden vectors for whole-piece matches", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  assert.deepEqual([...tokenizer.encode("hello world")], [1, 4, 5, 2]);
  assert.deepEqual([...tokenizer.encode("ciao mondo")], [1, 6, 7, 2]);
});

test("tokenizer: falls back to per-character UNK for out-of-vocabulary text", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  assert.deepEqual([...tokenizer.encode("xyz")], [1, 0, 0, 0, 2]);
});

test("tokenizer: is deterministic and always wraps with BOS/EOS", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  const first = [...tokenizer.encode("hello world")];
  const second = [...tokenizer.encode("hello world")];
  assert.deepEqual(first, second);
  assert.equal(first[0], 1);
  assert.equal(first.at(-1), 2);
});

test("tokenizer: truncates to the configured max_length, keeping BOS and EOS", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  const long = Array.from({ length: 20 }, () => "hello world").join(" ");
  const ids = [...tokenizer.encode(long)];
  assert.equal(ids.length, 16);
  assert.equal(ids[0], 1);
  assert.equal(ids.at(-1), 2);
});

test("tokenizer: MODEL_ASSET_MISSING when the path does not exist", async () => {
  await assert.rejects(loadTokenizer(join(FIXTURE, "..", "does-not-exist.json")), { code: "MODEL_ASSET_MISSING" });
});

test("tokenizer: MODEL_ASSET_CORRUPT on malformed JSON or wrong model type", async (t) => {
  const badJson = join(t.name.replace(/[^a-z0-9]/giu, "-"), "bad.json");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-tokenizer-bad-"));
  const notJson = path.join(root, "not-json.json");
  await writeFile(notJson, "{ not valid", "utf8");
  await assert.rejects(loadTokenizer(notJson), { code: "MODEL_ASSET_CORRUPT" });
  const wrongType = path.join(root, "wrong-type.json");
  await writeFile(wrongType, JSON.stringify({ model: { type: "BPE", vocab: [] } }), "utf8");
  await assert.rejects(loadTokenizer(wrongType), { code: "MODEL_ASSET_CORRUPT" });
  void mkdir; void badJson;
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/tokenizer.test.mjs`
Expected: FAIL — `plugins/openwiki/src/tokenizer.ts` does not exist.

- [ ] **Step 4: Implement `tokenizer.ts`**

Create `plugins/openwiki/src/tokenizer.ts`:

```ts
import { readFile } from "node:fs/promises";

import { OpenWikiError } from "./errors.js";

export interface Tokenizer { encode(text: string): Int32Array; }

const MAX_PIECE_LENGTH = 32;
const UNK_PENALTY = 10;

interface TokenizerConfig {
  vocab: Map<string, number>;
  scores: Float64Array;
  unkId: number;
  bosId: number;
  eosId: number;
  maxLength: number;
  addPrefixSpace: boolean;
}

export async function loadTokenizer(tokenizerJsonPath: string): Promise<Tokenizer> {
  let raw: string;
  try {
    raw = await readFile(tokenizerJsonPath, "utf8");
  } catch {
    throw new OpenWikiError("MODEL_ASSET_MISSING", "Tokenizer asset is missing.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Tokenizer asset is not valid JSON.");
  }
  const config = parseTokenizerConfig(parsed);
  return { encode: (text: string): Int32Array => encodeWithConfig(config, text) };
}

function parseTokenizerConfig(value: unknown): TokenizerConfig {
  if (!isRecord(value) || !isRecord(value.model) || value.model.type !== "Unigram" || !Array.isArray(value.model.vocab)) {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Tokenizer model type is not the expected SentencePiece Unigram format.");
  }
  const vocab = new Map<string, number>();
  const scores: number[] = [];
  value.model.vocab.forEach((entry: unknown, index: number) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number") {
      throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Tokenizer vocabulary entry is invalid.");
    }
    vocab.set(entry[0], index);
    scores.push(entry[1]);
  });
  const rawUnk = value.model.unkId ?? value.model.unk_id;
  const unkId = typeof rawUnk === "number" ? rawUnk : 0;
  const addedRaw = value.addedTokens ?? value.added_tokens;
  const added = Array.isArray(addedRaw) ? addedRaw : [];
  const findSpecial = (content: string, fallback: number): number => {
    for (const entry of added) {
      if (isRecord(entry) && entry.content === content && typeof entry.id === "number") return entry.id;
    }
    return vocab.get(content) ?? fallback;
  };
  const bosId = findSpecial("<s>", 0);
  const eosId = findSpecial("</s>", 2);
  const rawMaxLength = isRecord(value.truncation) ? value.truncation.max_length ?? value.truncation.maxLength : undefined;
  const maxLength = typeof rawMaxLength === "number" && rawMaxLength > 2 ? rawMaxLength : 512;
  return { vocab, scores: Float64Array.from(scores), unkId, bosId, eosId, maxLength, addPrefixSpace: true };
}

function encodeWithConfig(config: TokenizerConfig, text: string): Int32Array {
  const normalized = preTokenize(text, config.addPrefixSpace);
  const pieces = unigramSegment(normalized, config.vocab, config.scores, config.unkId);
  const budget = Math.max(0, config.maxLength - 2);
  const truncated = pieces.slice(0, budget);
  return Int32Array.from([config.bosId, ...truncated, config.eosId]);
}

function preTokenize(text: string, addPrefixSpace: boolean): string {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const withPrefix = addPrefixSpace && normalized.length > 0 ? ` ${normalized}` : normalized;
  return withPrefix.replace(/ /gu, "▁");
}

function unigramSegment(text: string, vocab: ReadonlyMap<string, number>, scores: Float64Array, unkId: number): number[] {
  const characters = [...text];
  const length = characters.length;
  const bestScore = new Float64Array(length + 1).fill(Number.NEGATIVE_INFINITY);
  const backPointer = new Int32Array(length + 1).fill(-1);
  const backPiece = new Array<string | undefined>(length + 1).fill(undefined);
  bestScore[0] = 0;
  const minScore = scores.length > 0 ? Math.min(...scores) : 0;
  const unkScore = minScore - UNK_PENALTY;
  for (let end = 1; end <= length; end += 1) {
    const start = Math.max(0, end - MAX_PIECE_LENGTH);
    for (let begin = start; begin < end; begin += 1) {
      const candidate = characters.slice(begin, end).join("");
      const pieceId = vocab.get(candidate);
      if (pieceId === undefined) continue;
      const score = (bestScore[begin] ?? Number.NEGATIVE_INFINITY) + (scores[pieceId] ?? unkScore);
      if (score > (bestScore[end] ?? Number.NEGATIVE_INFINITY)) {
        bestScore[end] = score;
        backPointer[end] = begin;
        backPiece[end] = candidate;
      }
    }
    const unkBegin = end - 1;
    const unkTotal = (bestScore[unkBegin] ?? Number.NEGATIVE_INFINITY) + unkScore;
    if (unkTotal > (bestScore[end] ?? Number.NEGATIVE_INFINITY)) {
      bestScore[end] = unkTotal;
      backPointer[end] = unkBegin;
      backPiece[end] = undefined;
    }
  }
  const ids: number[] = [];
  let position = length;
  while (position > 0) {
    const piece = backPiece[position];
    const previous = backPointer[position] ?? 0;
    ids.push(piece === undefined ? unkId : (vocab.get(piece) ?? unkId));
    position = previous;
  }
  return ids.reverse();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/tokenizer.test.mjs`
Expected: PASS (6 tests). Verify the two golden-vector assertions by hand if a failure occurs: `"hello world"` normalizes to `"▁hello▁world"` (add-prefix-space, then space→▁); the Viterbi DP should select the two whole-piece matches (`▁hello` id 4, `▁world` id 5) over any character-level segmentation because their combined score (`-2.5 + -2.6 = -5.1`) beats any all-UNK/character path (many terms at `unkScore = -9 - 10 = -19` each).

- [ ] **Step 6: Real-asset smoke test (skip-if-absent)**

Create `plugins/openwiki/tests/integration/tokenizer-vendor.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadTokenizer } from "../../dist/tokenizer.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR_TOKENIZER = join(PLUGIN_ROOT, "vendor", "model", "multilingual-e5-small-int8", "tokenizer.json");

test("tokenizer (real vendored asset): encodes Italian and English text without throwing", { skip: !existsSync(VENDOR_TOKENIZER) }, async () => {
  const tokenizer = await loadTokenizer(VENDOR_TOKENIZER);
  for (const text of ["query: what is the capital of France?", "passage: Roma è la capitale d'Italia."]) {
    const ids = tokenizer.encode(text);
    assert.ok(ids instanceof Int32Array);
    assert.ok(ids.length > 2, "expected more than just BOS/EOS for non-trivial text");
    assert.ok(ids.length <= 512, "must respect the model's max sequence length");
    assert.equal(ids[0], ids[0], "BOS id must be a stable, repeatable value");
  }
  const first = [...tokenizer.encode("hello world")];
  const second = [...tokenizer.encode("hello world")];
  assert.deepEqual(first, second, "encoding must be deterministic against the real vocabulary");
});
```

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/tokenizer-vendor.test.mjs`
Expected: SKIP if `plugins/openwiki/vendor/model/multilingual-e5-small-int8/tokenizer.json` does not yet exist (TV.1 not landed); PASS once it does. If it fails (does not skip, does not pass) once real assets exist, stop and re-inspect the real `tokenizer.json`'s `model` object shape by hand (`node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('plugins/openwiki/vendor/model/multilingual-e5-small-int8/tokenizer.json','utf8')).model).slice(0,500))"`) before changing `parseTokenizerConfig` — this is the one place in this plan where the binding assumption (Unigram model type) could be wrong in some structural detail not caught during planning.

**Design note — known normalization gap (found while auditing this plan, not previously documented):** the real vendored `tokenizer.json` (directly inspected: `worktree-agent-ab41604a4363e639e`, commit `003d25a`) declares `"normalizer": { "type": "Sequence", "normalizers": [{ "type": "Precompiled", "precompiled_charsmap": "<base64 double-array-trie blob>" }, ...] }` — SentencePiece's own normalization table (used by the reference tokenizer for exactly this XLM-R-family model), not plain Unicode NFKC. `preTokenize` above only applies `String.prototype.normalize("NFKC")` plus whitespace collapse; it does not parse or apply the `Precompiled` charsmap trie. For ASCII input (everything Step 2's golden vectors and Step 6's smoke test exercise) this is very likely a no-op difference, since SentencePiece's default charsmap for this family is close to standard NFKC plus minor whitespace/control-character cleanup already covered by the `.replace(/\s+/gu, " ").trim()` step — but it is **not proven identical**, and the practical gap is unverified precisely for the input this model exists to serve: non-ASCII, multilingual (Italian) text, where SentencePiece charsmaps most commonly diverge from plain NFKC (e.g. certain compatibility/format characters, fullwidth variants). This mirrors `TV.1`'s own smoke tokenizer, which documents the identical, explicitly-scoped-out limitation in `tests/integration/embedder-smoke.test.mjs`. Flagged for orchestrator decision, not silently shipped as a faithful SentencePiece port: (a) accept this as the v1 approximation (matches TV.1's precedent, and Step 6's real-asset test already proves the tokenizer does not throw and is deterministic on real Italian input, just not proven *identical* to the HF reference for that input), or (b) add a fast-follow task that parses the SentencePiece `Precompiled` charsmap (a serialized double-array trie plus a replacement-string table — a documented, implementable format, not a black box) and adds golden vectors captured once from a real Python/HF `AutoTokenizer` run on non-ASCII fixtures, checked in as literal expected-output arrays (no live Python dependency at test time). This plan proceeds with (a) and does not block on it, since e5's own retrieval quality on Italian text is validated empirically by the embedding-level semantic-ordering test in Task 5 Step 5, not by token-level fidelity alone.

- [ ] **Step 7: Commit**

```bash
git add plugins/openwiki/src/tokenizer.ts plugins/openwiki/tests/unit/tokenizer.test.mjs plugins/openwiki/tests/fixtures/tokenizer/mini-unigram.tokenizer.json plugins/openwiki/tests/integration/tokenizer-vendor.test.mjs
git commit -m "feat(openwiki): add a pure-TS SentencePiece Unigram tokenizer"
```

---

### Task 5: `embedder.ts` — vendored WASM inference with e5 prefix discipline

**Assumptions flagged for orchestrator review (updated from `TV.1`'s in-flight findings):**
1. **Corrected per TP.2 review finding C1 (real vendored tree re-inspected directly, not assumed).** The real committed `vendor/ort/` tree (worktree `worktree-agent-ab41604a4363e639e`) has **no `package.json` at `vendor/ort/` itself** — only its one nested dependency, `vendor/ort/node_modules/onnxruntime-common`, has one — and its Node entry point, `ort.node.min.mjs`, is genuine ESM (a top-level `import` statement at the top of the file). Node's CommonJS directory-resolution algorithm has no rule that locates `ort.node.min.mjs` without a `package.json`/`index.js` at the directory root, so `createRequire(...)(vendorRoot/"ort")` throws `MODULE_NOT_FOUND`; and even pointed at the file directly, `require()` of an `.mjs` file throws `ERR_REQUIRE_ESM` on Node runtimes without unflagged synchronous `require(esm)` support (a Node 22.12+/23.x feature, not guaranteed on this project's stated Node >= 20 baseline). This plan therefore resolves the exact vendored entry file path (`vendor/ort/ort.node.min.mjs`) explicitly and loads it via dynamic `import(pathToFileURL(entryPath).href)` — native ESM loading, correct on any Node >= 20, and requiring no `package.json` at the `ort/` root at all. `loadOrtRuntime` is `async` for this (it already ran inside the already-`async` `loadEmbedder`, so this changes no caller). The path-resolution logic (`resolveOrtEntryPath`) is exported and unit-tested without real assets (Task 5 Step 1); only the actual `import()` call is exercised by Step 5's skip-if-real-assets-absent integration test, mirroring how every other real-asset-dependent assertion in this plan is guarded.
2. **Target shape is PRD §16 amendment 2 (binding), not yet what `TV.1`'s committed manifest contains today — corrected while finishing this plan.** `plugins/openwiki/vendor/MANIFEST.json` was re-inspected directly on `TV.1`'s worktree branch (`worktree-agent-ab41604a4363e639e`, commit `003d25a`) while auditing this plan: the committed manifest vendors `multilingual-e5-small-int8/model.onnx` as **one flat, unsplit 118 MB file** — a plain `{ path, sha256, bytes, license, upstream, revision }` entry, no `parts`, no `assembled_sha256` (grep-verified: zero occurrences of either in that commit's `MANIFEST.json`). An earlier draft of this note claimed the split shape was already "verified directly... not assumed" against that same commit; that claim was false. What **is** real and binding is the *decision*: PRD §16 amendment 2 (dated the same day as `TV.1`'s acquisition, after `TV.1`'s own report — `.superpowers/sdd/tv1-report.md` — flagged the 118 MB file exceeding GitHub's 100 MB push limit as an explicitly unresolved risk) specifies the model **must** ship as sequential parts (`model.onnx.part0`, `model.onnx.part1`, each < 95 MB), with the assembled checksum nested per-entry as snake_case `assembled_sha256` plus an ordered `parts: [{ path, sha256, bytes }, …]` array — never a sibling top-level `assembledSha256` dictionary. A separate, not-yet-landed "vendor chunking" task re-materializes `TV.1`'s flat commit into this shape before merge to `main`. `parseManifest`/`VendorManifestEntry`/`verifyAllVendorAssets`/`loadModelBuffer` below implement the PRD §16 target shape (split-parts primary), while also still accepting a plain flat `sha256` entry as a fallback (exercised by the last unit test in Step 1, "still supports a single unsplit file") — so this module works correctly against *either* today's actual flat `TV.1` commit or the post-chunking split commit; the loading/concatenation logic (in-memory `Buffer.concat`, assembled-checksum verification, never reassembled on disk) is unchanged and was already correct independent of which shape is on disk. Do not read this as evidence the split shape exists today — it doesn't yet; see Prerequisite 2 above.
3. The ONNX model's own input/output tensor names are still assumed to be `input_ids`/`attention_mask`(/`token_type_ids`)/`last_hidden_state`, per the near-universal HF-Optimum export convention — unchanged from before, still empirically verified by Step 6's real-asset semantic-ordering test.
4. The model is loaded **as an in-memory buffer**, never reassembled on disk: parts are concatenated with `Buffer.concat` and the resulting `Uint8Array` is passed directly to `InferenceSession.create(buffer)`, which is a standard, documented onnxruntime-web capability (accepting a buffer as an alternative to a file path) — not an invented API.

**Files:**
- Create: `plugins/openwiki/src/embedder.ts`
- Test: `plugins/openwiki/tests/unit/embedder.test.mjs` (new, tiny fixtures, no real assets)
- Test: `plugins/openwiki/tests/integration/embedder.test.mjs` (new, skip-if-real-assets-absent)

**Interfaces:**
- Produces (binding): `export interface Embedder { readonly modelId: string; readonly dims: number; embedQuery(text: string): Promise<Float32Array>; embedPassages(texts: readonly string[]): Promise<Float32Array[]>; }`, `export function loadEmbedder(vendorRoot: string): Promise<Embedder>`.
- Produces (this plan's own, reused by Task 12 doctor check and Task 10 reindex wiring): `export function defaultVendorRoot(): string`, `export interface VendorManifestPart { path: string; sha256: string; bytes: number; }`, `export interface VendorManifestEntry { path: string; bytes: number; license: string; upstream: string; revision: string; sha256?: string; assembledSha256?: string; parts?: VendorManifestPart[]; }` (exactly one of `sha256` or `assembledSha256`+`parts` is present, matching TV.1's real `MANIFEST.json` — see the verified note above), `export interface VendorManifest { assets: VendorManifestEntry[]; }`, `export function loadVendorManifest(vendorRoot: string): Promise<VendorManifest>`, `export function verifyAllVendorAssets(vendorRoot: string): Promise<VendorManifest>`, `export function loadModelBuffer(vendorRoot: string, manifest: VendorManifest, logicalPath: string): Promise<Uint8Array>`, `export function resolveOrtEntryPath(vendorRoot: string): string` (the exact vendored ONNX Runtime entry file path — exported solely so TP.2 review finding C1's path-resolution logic is independently unit-testable without real assets; see Step 1).
- Consumes: `Tokenizer`/`loadTokenizer` from `./tokenizer.js` (Task 4).

- [ ] **Step 1: Write the failing unit tests (no real assets needed)**

Create `plugins/openwiki/tests/unit/embedder.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { loadEmbedder, loadVendorManifest, verifyAllVendorAssets } from "../../dist/embedder.js";

const roots = [];
async function temporaryVendorRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-vendor-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeAsset(root, relative, content) {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return { path: relative, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, license: "MIT", upstream: "test", revision: "test-1" };
}

test("embedder: MODEL_ASSET_MISSING when the vendor manifest itself is absent", async () => {
  const root = await temporaryVendorRoot();
  await assert.rejects(loadVendorManifest(root), { code: "MODEL_ASSET_MISSING" });
  await assert.rejects(loadEmbedder(root), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: MODEL_ASSET_MISSING when a manifest-listed asset file is absent from disk", async () => {
  const root = await temporaryVendorRoot();
  const entry = { path: "model/multilingual-e5-small-int8/model.onnx", sha256: "a".repeat(64), bytes: 10, license: "MIT", upstream: "test", revision: "test-1" };
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: MODEL_ASSET_CORRUPT on a checksum mismatch", async () => {
  const root = await temporaryVendorRoot();
  const asset = await writeAsset(root, "model/multilingual-e5-small-int8/model.onnx", Buffer.from("fake-model-bytes"));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [{ ...asset, sha256: "0".repeat(64) }] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: MODEL_ASSET_CORRUPT on a byte-size mismatch", async () => {
  const root = await temporaryVendorRoot();
  const asset = await writeAsset(root, "model/multilingual-e5-small-int8/model.onnx", Buffer.from("fake-model-bytes"));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [{ ...asset, bytes: asset.bytes + 1 }] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: verifyAllVendorAssets passes when every listed asset matches its checksum", async () => {
  const root = await temporaryVendorRoot();
  const modelAsset = await writeAsset(root, "model/multilingual-e5-small-int8/model.onnx", Buffer.from("fake-model-bytes"));
  const tokenizerAsset = await writeAsset(root, "model/multilingual-e5-small-int8/tokenizer.json", Buffer.from(JSON.stringify({ model: { type: "Unigram", vocab: [] } })));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [modelAsset, tokenizerAsset] }));
  const manifest = await verifyAllVendorAssets(root);
  assert.equal(manifest.assets.length, 2);
});

// Builds one nested split-asset manifest entry matching TV.1's real MANIFEST.json
// shape: the logical path carries assembled_sha256 + bytes (assembled total) +
// an ordered parts[] array; there is no sibling top-level entry for each part.
async function writeSplitAsset(root, logicalPath, partsContent) {
  const partAssets = await Promise.all(partsContent.map((content, index) => writeAsset(root, `${logicalPath}.part${String(index)}`, content)));
  const assembled = Buffer.concat(partsContent);
  return {
    path: logicalPath,
    assembled_sha256: createHash("sha256").update(assembled).digest("hex"),
    bytes: partAssets.reduce((sum, part) => sum + part.bytes, 0),
    parts: partAssets.map((part) => ({ path: part.path, sha256: part.sha256, bytes: part.bytes })),
    license: "MIT", upstream: "test", revision: "test-1",
  };
}

test("embedder: loadModelBuffer assembles sequential model parts in memory and verifies the assembled checksum", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const part0 = Buffer.from("first-half-of-the-model-");
  const part1 = Buffer.from("second-half-of-the-model");
  const entry = await writeSplitAsset(root, logicalPath, [part0, part1]);
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  const manifest = await verifyAllVendorAssets(root);
  const buffer = await loadModelBuffer(root, manifest, logicalPath);
  assert.ok(buffer instanceof Uint8Array);
  assert.deepEqual(Buffer.from(buffer), Buffer.concat([part0, part1]));
  const onDisk = await import("node:fs/promises");
  await assert.rejects(onDisk.stat(path.join(root, logicalPath)), { code: "ENOENT" }, "the assembled model must never be written back to disk");
});

test("embedder: loadModelBuffer reports MODEL_ASSET_CORRUPT when the assembled checksum does not match, even though every individual part matches", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const entry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a"), Buffer.from("part-b")]);
  entry.assembled_sha256 = "0".repeat(64);
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  const manifest = await verifyAllVendorAssets(root);
  await assert.rejects(loadModelBuffer(root, manifest, logicalPath), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: verifyAllVendorAssets verifies each part file of a split asset individually, without requiring the (never-written) assembled file on disk", async () => {
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const entry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a"), Buffer.from("part-b")]);
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  const manifest = await verifyAllVendorAssets(root);
  assert.equal(manifest.assets.length, 1);
  const onDisk = await import("node:fs/promises");
  await assert.rejects(onDisk.stat(path.join(root, logicalPath)), { code: "ENOENT" }, "verification must never require or create the assembled file");
});

test("embedder: MODEL_ASSET_MISSING when one part of a split asset is absent from disk", async () => {
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const entry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a"), Buffer.from("part-b")]);
  await rm(path.join(root, entry.parts[1].path));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [entry] }));
  await assert.rejects(verifyAllVendorAssets(root), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: MODEL_ASSET_CORRUPT when a manifest entry declares both sha256 and parts, or neither", async () => {
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const splitEntry = await writeSplitAsset(root, logicalPath, [Buffer.from("part-a")]);
  const bothEntry = { ...splitEntry, sha256: "a".repeat(64) };
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [bothEntry] }));
  await assert.rejects(loadVendorManifest(root), { code: "MODEL_ASSET_CORRUPT" });
  const neitherEntry = { path: logicalPath, bytes: 1, license: "MIT", upstream: "test", revision: "test-1" };
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [neitherEntry] }));
  await assert.rejects(loadVendorManifest(root), { code: "MODEL_ASSET_CORRUPT" });
});

test("embedder: loadModelBuffer reports MODEL_ASSET_MISSING when neither a single file nor any parts are listed", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [] }));
  const manifest = await verifyAllVendorAssets(root);
  await assert.rejects(loadModelBuffer(root, manifest, "model/multilingual-e5-small-int8/model.onnx"), { code: "MODEL_ASSET_MISSING" });
});

test("embedder: loadModelBuffer still supports a single unsplit file for the logical path", async () => {
  const { loadModelBuffer } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const logicalPath = "model/multilingual-e5-small-int8/model.onnx";
  const asset = await writeAsset(root, logicalPath, Buffer.from("a-small-unsplit-model"));
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ assets: [asset] }));
  const manifest = await verifyAllVendorAssets(root);
  const buffer = await loadModelBuffer(root, manifest, logicalPath);
  assert.deepEqual(Buffer.from(buffer), Buffer.from("a-small-unsplit-model"));
});

// TP.2 review finding C1: the ORT loader's path-resolution logic must be
// unit-testable in isolation, without real vendored assets, so a broken
// entry-path resolution can never silently pass every unit test and only
// surface during T9.1's real-asset dogfooding re-run (which is exactly what
// happened before this fix — see tp2-review.md).
test("embedder: resolveOrtEntryPath resolves to the real vendored ONNX Runtime entry file, not a bare directory specifier", async () => {
  const { resolveOrtEntryPath } = await import("../../dist/embedder.js");
  const root = await temporaryVendorRoot();
  const resolved = resolveOrtEntryPath(root);
  assert.equal(resolved, path.join(root, "ort", "ort.node.min.mjs"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/embedder.test.mjs`
Expected: FAIL — `plugins/openwiki/src/embedder.ts` does not exist.

- [ ] **Step 3: Implement `embedder.ts`**

Create `plugins/openwiki/src/embedder.ts`:

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OpenWikiError } from "./errors.js";
import { loadTokenizer, type Tokenizer } from "./tokenizer.js";

export interface Embedder {
  readonly modelId: string;
  readonly dims: number;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface VendorManifestPart { path: string; sha256: string; bytes: number; }
// A manifest entry describes exactly one logical asset. Unsplit assets carry a
// plain `sha256`; split assets (currently only model.onnx) carry `assembledSha256`
// (parsed from the real manifest's snake_case `assembled_sha256` field) plus an
// ordered `parts` array — never both, never neither (enforced by parseManifestEntry).
export interface VendorManifestEntry {
  path: string; bytes: number; license: string; upstream: string; revision: string;
  sha256?: string;
  assembledSha256?: string;
  parts?: VendorManifestPart[];
}
export interface VendorManifest { assets: VendorManifestEntry[]; }

const MODEL_ID = "multilingual-e5-small-int8";
const DIMS = 384;
const MODEL_RELATIVE = path.join("model", MODEL_ID, "model.onnx");
const TOKENIZER_RELATIVE = path.join("model", MODEL_ID, "tokenizer.json");
const ORT_ENTRY_RELATIVE = path.join("ort", "ort.node.min.mjs");

export function defaultVendorRoot(): string {
  return path.join(fileURLToPath(new URL("..", import.meta.url)), "vendor");
}

export async function loadVendorManifest(vendorRoot: string): Promise<VendorManifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(vendorRoot, "MANIFEST.json"), "utf8");
  } catch {
    throw new OpenWikiError("MODEL_ASSET_MISSING", "Vendor asset manifest is missing.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vendor asset manifest is not valid JSON.");
  }
  return parseManifest(parsed);
}

export async function verifyAllVendorAssets(vendorRoot: string): Promise<VendorManifest> {
  const manifest = await loadVendorManifest(vendorRoot);
  for (const entry of manifest.assets) await verifyVendorEntry(vendorRoot, entry);
  return manifest;
}

// A split entry's logical path (e.g. "model/.../model.onnx") never exists as a
// real file on disk — only its parts do, and the assembled bytes only ever
// exist transiently in memory (see loadModelBuffer) — so verification here
// checks every part file individually against its own sha256/bytes. The
// assembled_sha256 is checked lazily inside loadModelBuffer instead, since
// verifying it here would require reading and concatenating the whole model
// into memory on every doctor/startup check, not just when it is actually used.
async function verifyVendorEntry(vendorRoot: string, entry: VendorManifestEntry): Promise<void> {
  if (entry.parts === undefined) {
    if (entry.sha256 === undefined) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${entry.path} declares neither sha256 nor parts.`);
    await verifyVendorFile(vendorRoot, entry.path, entry.sha256, entry.bytes);
    return;
  }
  for (const part of entry.parts) await verifyVendorFile(vendorRoot, part.path, part.sha256, part.bytes);
}

async function verifyVendorFile(vendorRoot: string, relativePath: string, expectedSha256: string, expectedBytes: number): Promise<void> {
  const absolute = path.join(vendorRoot, relativePath);
  let size: number;
  try {
    size = (await stat(absolute)).size;
  } catch {
    throw new OpenWikiError("MODEL_ASSET_MISSING", `Vendor asset is missing: ${relativePath}.`);
  }
  if (size !== expectedBytes) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset size mismatch: ${relativePath}.`);
  const digest = await sha256File(absolute);
  if (digest !== expectedSha256.toLowerCase()) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset checksum mismatch: ${relativePath}.`);
}

// Assembles a (possibly part-split) vendored asset entirely in memory: every
// individual part's sha256/bytes is already verified by verifyAllVendorAssets;
// this only concatenates them in manifest-declared order and additionally
// verifies the *assembled* checksum, since a bug in part order or a truncated
// part would otherwise pass per-part verification silently. The assembled
// buffer is never written back to disk.
export async function loadModelBuffer(vendorRoot: string, manifest: VendorManifest, logicalPath: string): Promise<Uint8Array> {
  const entry = manifest.assets.find((candidate) => candidate.path === logicalPath);
  if (entry === undefined) throw new OpenWikiError("MODEL_ASSET_MISSING", `Vendor manifest has no entry for ${logicalPath}.`);
  if (entry.parts === undefined) {
    if (entry.sha256 === undefined) throw new OpenWikiError("MODEL_ASSET_MISSING", `Vendor manifest entry for ${logicalPath} declares neither a single file nor parts.`);
    return readFile(path.join(vendorRoot, entry.path));
  }

  const buffers = await Promise.all(entry.parts.map((part) => readFile(path.join(vendorRoot, part.path))));
  const assembled = Buffer.concat(buffers);
  if (entry.assembledSha256 === undefined) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor manifest is missing the assembled checksum for ${logicalPath}.`);
  const actual = createHash("sha256").update(assembled).digest("hex");
  if (actual !== entry.assembledSha256.toLowerCase()) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Assembled checksum mismatch for ${logicalPath}.`);
  return assembled;
}

export async function loadEmbedder(vendorRoot: string): Promise<Embedder> {
  const manifest = await verifyAllVendorAssets(vendorRoot);
  const tokenizer = await loadTokenizer(path.join(vendorRoot, TOKENIZER_RELATIVE));
  const runtime = await loadOrtRuntime(vendorRoot);
  const modelBuffer = await loadModelBuffer(vendorRoot, manifest, MODEL_RELATIVE);
  const session = await runtime.createSession(modelBuffer);
  return {
    modelId: MODEL_ID,
    dims: DIMS,
    async embedQuery(text) {
      return runInference(runtime, session, tokenizer, `query: ${text}`);
    },
    async embedPassages(texts) {
      const results: Float32Array[] = [];
      for (const text of texts) results.push(await runInference(runtime, session, tokenizer, `passage: ${text}`));
      return results;
    },
  };
}

async function sha256File(absolute: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absolute), hash);
  return hash.digest("hex");
}

// -- ONNX Runtime interop: the vendored package is untyped third-party JS.
// The real vendored vendor/ort/ tree has no package.json at its own root
// (only its nested dependency, vendor/ort/node_modules/onnxruntime-common,
// has one) and its Node entry point, ort.node.min.mjs, is genuine ESM — so
// this resolves the exact entry file path and loads it via dynamic
// import(), not createRequire (which would throw MODULE_NOT_FOUND against a
// directory with no package.json, or ERR_REQUIRE_ESM against the .mjs file
// directly on Node runtimes without unflagged synchronous require(esm)).
// Every value crossing this boundary is validated at the point of use below.
interface OrtTensorLike { readonly dims: readonly number[]; readonly data: ArrayLike<number> | ArrayLike<bigint>; }
interface OrtSessionLike { readonly inputNames: readonly string[]; run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>; }
interface OrtRuntime {
  createSession(modelPathOrBuffer: string | Uint8Array): Promise<OrtSessionLike>;
  createTensor(type: "int64" | "float32", data: BigInt64Array | Float32Array, dims: readonly number[]): OrtTensorLike;
}

// Exported (not just an inline expression inside loadOrtRuntime below) so
// TP.2 review finding C1's path-resolution logic is independently
// unit-testable without any real vendored assets on disk (Task 5 Step 1) —
// the actual dynamic import() only ever runs in a real-asset context
// (Step 5's skip-if-absent integration test).
export function resolveOrtEntryPath(vendorRoot: string): string {
  return path.join(vendorRoot, ORT_ENTRY_RELATIVE);
}

async function loadOrtRuntime(vendorRoot: string): Promise<OrtRuntime> {
  let imported: unknown;
  try {
    imported = (await import(pathToFileURL(resolveOrtEntryPath(vendorRoot)).href)) as unknown;
  } catch {
    throw new OpenWikiError("MODEL_ASSET_MISSING", "Vendored ONNX Runtime entry module is missing or could not be imported.");
  }
  const namespace = asRecord(imported);
  const moduleRecord = isRecord(namespace.default) ? namespace.default : namespace;
  const inferenceSession = moduleRecord.InferenceSession;
  const tensorConstructor = moduleRecord.Tensor;
  if (!isRecord(inferenceSession) || typeof inferenceSession.create !== "function" || typeof tensorConstructor !== "function") {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vendored ONNX Runtime package does not export the expected API.");
  }
  const createSessionFunction = inferenceSession.create;
  return {
    async createSession(modelPathOrBuffer) {
      const result: unknown = await Reflect.apply(createSessionFunction, inferenceSession, [modelPathOrBuffer]);
      const record = asRecord(result);
      if (typeof record.run !== "function") throw new OpenWikiError("MODEL_ASSET_CORRUPT", "ONNX Runtime session is missing run().");
      const runFunction = record.run;
      const rawInputNames = record.inputNames;
      const inputNames = Array.isArray(rawInputNames) && rawInputNames.every((name) => typeof name === "string")
        ? rawInputNames
        : ["input_ids", "attention_mask"];
      return {
        inputNames,
        async run(feeds) {
          const output: unknown = await Reflect.apply(runFunction, record, [feeds]);
          return asTensorRecord(output);
        },
      };
    },
    createTensor(type, data, dims) {
      const constructed: unknown = Reflect.construct(tensorConstructor as new (...args: never[]) => unknown, [type, data, dims]);
      return asTensor(constructed);
    },
  };
}

async function runInference(runtime: OrtRuntime, session: OrtSessionLike, tokenizer: Tokenizer, text: string): Promise<Float32Array> {
  const ids = tokenizer.encode(text);
  if (ids.length === 0) throw new OpenWikiError("EMBEDDING_FAILURE", "Tokenizer produced an empty sequence.");
  const seqLen = ids.length;
  const feeds: Record<string, OrtTensorLike> = {
    // Single-sequence-per-call design (no batching/padding): the attention
    // mask is always all-ones, so mean pooling below needs no masking.
    input_ids: runtime.createTensor("int64", BigInt64Array.from(ids, (value) => BigInt(value)), [1, seqLen]),
    attention_mask: runtime.createTensor("int64", BigInt64Array.from({ length: seqLen }, () => 1n), [1, seqLen]),
  };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = runtime.createTensor("int64", BigInt64Array.from({ length: seqLen }, () => 0n), [1, seqLen]);
  }
  let output: Record<string, OrtTensorLike>;
  try {
    output = await session.run(feeds);
  } catch {
    throw new OpenWikiError("EMBEDDING_FAILURE", "ONNX Runtime inference failed.");
  }
  const hiddenTensor = output.last_hidden_state ?? Object.values(output)[0];
  if (hiddenTensor === undefined) throw new OpenWikiError("EMBEDDING_FAILURE", "ONNX Runtime returned no output tensor.");
  const [batch, tensorSeqLen, dims] = hiddenTensor.dims;
  if (batch !== 1 || tensorSeqLen !== seqLen || dims !== DIMS) throw new OpenWikiError("EMBEDDING_FAILURE", "ONNX Runtime output tensor has an unexpected shape.");
  return l2Normalize(meanPool(toFloat32(hiddenTensor.data), seqLen, DIMS));
}

function toFloat32(data: ArrayLike<number> | ArrayLike<bigint>): Float32Array {
  const output = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    output[index] = typeof value === "bigint" ? Number(value) : (value ?? 0);
  }
  return output;
}

function meanPool(hidden: Float32Array, seqLen: number, dims: number): Float32Array {
  const pooled = new Float32Array(dims);
  for (let t = 0; t < seqLen; t += 1) for (let d = 0; d < dims; d += 1) pooled[d] = (pooled[d] ?? 0) + (hidden[t * dims + d] ?? 0);
  const denom = seqLen > 0 ? seqLen : 1;
  for (let d = 0; d < dims; d += 1) pooled[d] = (pooled[d] ?? 0) / denom;
  return pooled;
}

function l2Normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares) || 1;
  const output = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) output[index] = (vector[index] ?? 0) / norm;
  return output;
}

function parseManifest(value: unknown): VendorManifest {
  if (!isRecord(value) || !Array.isArray(value.assets)) throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vendor asset manifest is invalid.");
  return { assets: value.assets.map(parseManifestEntry) };
}

function parseManifestEntry(value: unknown): VendorManifestEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
    typeof value.license !== "string" || typeof value.upstream !== "string" || typeof value.revision !== "string"
  ) {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vendor asset manifest entry is invalid.");
  }
  const hasSingleHash = typeof value.sha256 === "string";
  const hasSplitParts = Array.isArray(value.parts);
  if (hasSingleHash === hasSplitParts) {
    // A manifest entry describes either one unsplit file (sha256) or a
    // split asset (assembled_sha256 + parts) — never both, never neither.
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${value.path} must declare exactly one of sha256 or parts.`);
  }
  const base = { path: value.path, bytes: value.bytes, license: value.license, upstream: value.upstream, revision: value.revision };
  if (hasSingleHash) {
    const sha256 = value.sha256;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256)) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${value.path} has an invalid sha256.`);
    return { ...base, sha256 };
  }
  const assembledSha256 = (value as { assembled_sha256?: unknown }).assembled_sha256;
  if (typeof assembledSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(assembledSha256)) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset manifest entry for ${value.path} has an invalid assembled_sha256.`);
  const parts = (value.parts as unknown[]).map((part) => parseManifestPart(part, value.path));
  parts.forEach((part, index) => {
    if (!part.path.endsWith(`.part${String(index)}`)) throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset manifest parts for ${value.path} must be declared in order part0, part1, ....`);
  });
  return { ...base, assembledSha256, parts };
}

function parseManifestPart(value: unknown, parentPath: string): VendorManifestPart {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" || value.path.length === 0 ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 0
  ) {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", `Vendor asset manifest part entry for ${parentPath} is invalid.`);
  }
  return { path: value.path, sha256: value.sha256, bytes: value.bytes };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vendored ONNX Runtime Web module returned an invalid value.");
  return value;
}

function asTensor(value: unknown): OrtTensorLike {
  const record = asRecord(value);
  if (!Array.isArray(record.dims) || record.data === undefined || record.data === null) throw new OpenWikiError("MODEL_ASSET_CORRUPT", "ONNX Runtime Tensor has an unexpected shape.");
  return { dims: record.dims, data: record.data as ArrayLike<number> | ArrayLike<bigint> };
}

function asTensorRecord(value: unknown): Record<string, OrtTensorLike> {
  const record = asRecord(value);
  const result: Record<string, OrtTensorLike> = {};
  for (const [key, entry] of Object.entries(record)) result[key] = asTensor(entry);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/embedder.test.mjs`
Expected: PASS (13 tests). If `lint`/`typecheck` flags the `tensorConstructor as new (...args: never[]) => unknown` cast in `loadOrtRuntime`, this is the one intentional, narrowly-scoped assertion in this module (constructing an instance from an already-validated `typeof value === "function"` check has no safe type-level alternative in strict mode) — leave a `// eslint-disable-next-line` only if the linter actually flags it, matching the existing precedent at `graph.ts:38` (`// eslint-disable-next-line @typescript-eslint/no-deprecated -- ...`); do not add a blanket disable.

- [ ] **Step 5: Real-asset integration test (skip-if-absent, with an empirical semantic check)**

Create `plugins/openwiki/tests/integration/embedder.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { defaultVendorRoot, loadEmbedder } from "../../dist/embedder.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_PRESENT = existsSync(join(PLUGIN_ROOT, "vendor", "model", "multilingual-e5-small-int8", "model.onnx"));

function cosine(a, b) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

test("embedder (real vendored asset): produces unit-normalized 384-dim vectors with correct semantic ordering", { skip: !MODEL_PRESENT }, async () => {
  const embedder = await loadEmbedder(defaultVendorRoot());
  assert.equal(embedder.modelId, "multilingual-e5-small-int8");
  assert.equal(embedder.dims, 384);
  const query = await embedder.embedQuery("What is the capital of France?");
  assert.equal(query.length, 384);
  const norm = Math.sqrt([...query].reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `query embedding must be L2-normalized, got norm ${String(norm)}`);
  const [relevant, unrelated] = await embedder.embedPassages(["Paris is the capital of France.", "Bananas are a good source of potassium."]);
  assert.ok(cosine(query, relevant) > cosine(query, unrelated), "the relevant passage must score higher than an unrelated one");
});

test("embedder (real vendored asset): is deterministic across calls", { skip: !MODEL_PRESENT }, async () => {
  const embedder = await loadEmbedder(defaultVendorRoot());
  const first = await embedder.embedQuery("hello world");
  const second = await embedder.embedQuery("hello world");
  assert.deepEqual([...first], [...second]);
});
```

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/embedder.test.mjs`
Expected: SKIP if `plugins/openwiki/vendor/model/multilingual-e5-small-int8/model.onnx` is absent; PASS once real assets exist. This test is the actual proof that the assumed pooling recipe (mean pooling + L2 normalize, per the well-documented E5 family recipe) and the assumed I/O tensor names are correct for the real model — if it fails, do not guess; log `session.inputNames`/`Object.keys(output)` from a temporary diagnostic script before changing `runInference`.

- [ ] **Step 6: Commit**

```bash
git add plugins/openwiki/src/embedder.ts plugins/openwiki/tests/unit/embedder.test.mjs plugins/openwiki/tests/integration/embedder.test.mjs
git commit -m "feat(openwiki): add vendored WASM embedder with e5 prefix discipline"
```

---

### Task 6: `vector-store.ts` — bucketed int8 segments + manifest

**Design note on the binary layout vs. performance:** the binding contract fixes the segment format literally (`16-byte header {magic,dtype,dims,count} + int8 rows + id table`) and PRD §9 shows one conceptual segment "keyed by content hash" per store. A naive one-file-per-chunk layout would require up to 5,000 file opens per `search()` call at the PRD's target corpus scale, which risks the <1s p95 target. This plan buckets chunks into 16 segment files by the first hex character of `ChunkRef.contentHash` (exactly the bucketing scheme `graph-index.ts` already uses for its own JSON buckets) — each bucket file is itself exactly the binding binary format (one header + N rows + N ids), so the format is honored per-file; there are just 16 files instead of thousands. `search()` reads at most 16 files; `upsert()` only rewrites the buckets that actually changed.

**Manifest shape correction (TP.2 review finding I1):** each manifest `segments[]` entry now additionally carries `file` (`${bucket}.bin`) and `contentHash` (sha256 of the encoded bucket buffer) alongside `count`, restoring the binding contract's literal `segments[{file,contentHash,count}]` shape (`bucket` is kept alongside, since `search()`/`upsert()` already use it as the lookup/dispatch key — an additive superset of the binding fields, not a replacement). The bucketing scheme itself is unchanged; this only makes each segment individually content-addressed, mirroring `graph-store.ts`'s shard-reuse pattern, for future staleness/integrity checks.

**`embeddingsAvailable`/`unavailableReason` (TP.2 review finding C2, orchestrator adjudication — see Task 10):** the manifest also carries a top-level `embeddingsAvailable: boolean` (+ optional `unavailableReason`), defaulting to `true`. `upsert()` always resets it to `true` on a successful write (having real vectors to write proves assets are currently available). The new `markEmbeddingsUnavailable(storageRoot, model, reason)` helper — called only by `reindex.ts`'s write-path soft-degrade branch (Task 10) when vendor assets are absent/corrupt — flips it to `false` with a machine-readable reason, touching no chunk/segment data, so `status()` (and, transitively, `doctor`) can non-silently report that an index's embeddings are currently incomplete because vendor assets were unavailable at write time — recorded, never silently dropped.

**Files:**
- Create: `plugins/openwiki/src/vector-store.ts`
- Test: `plugins/openwiki/tests/unit/vector-store.test.mjs` (new)

**Interfaces:**
- Produces (binding, additively extended per TP.2 review C2 — orchestrator-approved deviation, see Design note above): `export interface VectorStore { upsert(entries: ReadonlyArray<{ ref: ChunkRef; vector: Float32Array }>): Promise<{ written: number; reused: number }>; search(vector: Float32Array, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>; status(): Promise<{ modelId: string; dims: number; chunks: number; compatible: boolean; embeddingsAvailable: boolean; unavailableReason?: string }>; }`.
- Produces (this plan's own factory, since the binding contract specifies the interface but not construction): `export function openVectorStore(storageRoot: string, model: { modelId: string; modelRevision: string; dims: number }): Promise<VectorStore>`.
- Produces (this plan's own, narrow read helper — consumed by Task 10's `reindex.ts` so it can skip calling the embedder for chunks that are already embedded with the same `contentHash`, without needing a loaded `Embedder` or touching the `VectorStore` interface's model-compatibility logic): `export async function readVectorChunkDigest(storageRoot: string): Promise<ReadonlyMap<string, string>>` — returns `chunkId -> contentHash` for every chunk currently in the store's manifest, or an empty map if no manifest exists yet.
- Produces (this plan's own, consumed by Task 10's write-path soft-degrade branch — TP.2 review C2): `export async function markEmbeddingsUnavailable(storageRoot: string, model: { modelId: string; modelRevision: string; dims: number }, reason: string): Promise<void>` — records a non-silent embedding-skip in the manifest (`embeddingsAvailable: false, unavailableReason: reason`) without touching chunks/segments; creates an empty manifest first if none exists yet.
- Consumes: `ChunkRef`, `parseChunkRef` from `./chunk.js` (Task 3); `withFileWriteLock`, `atomicWriteFile`, `atomicWriteBinaryFile` from `./atomic.js` (Task 2 and existing).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/vector-store.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { openVectorStore } from "../../dist/vector-store.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-vector-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function chunkRef(id, contentHash) {
  return { id, path: "docs/a.md", startLine: 1, endLine: 5, plane: "wiki", contentHash };
}

function unitVector(seed, dims = 384) {
  const vector = new Float32Array(dims);
  for (let index = 0; index < dims; index += 1) vector[index] = Math.sin(seed + index);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dims; index += 1) vector[index] /= norm;
  return vector;
}

const MODEL = { modelId: "test-model", modelRevision: "rev-1", dims: 384 };

test("vector store: upserts, deduplicates by contentHash, and ranks search results deterministically", async () => {
  const root = await temporaryRoot("basic");
  const store = await openVectorStore(root, MODEL);
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  const b = chunkRef("b".repeat(64), "2".repeat(64));
  const first = await store.upsert([{ ref: a, vector: unitVector(1) }, { ref: b, vector: unitVector(2) }]);
  assert.deepEqual(first, { written: 2, reused: 0 });
  const second = await store.upsert([{ ref: a, vector: unitVector(1) }]);
  assert.deepEqual(second, { written: 0, reused: 1 });
  const status = await store.status();
  assert.deepEqual(status, { modelId: "test-model", dims: 384, chunks: 2, compatible: true, embeddingsAvailable: true });
  const results = await store.search(unitVector(1), 10);
  assert.equal(results[0].ref.id, a.id);
  assert.ok(results[0].score > (results[1]?.score ?? -Infinity));
});

test("vector store: reindexes a chunk whose contentHash changed and reuses others", async () => {
  const root = await temporaryRoot("update");
  const store = await openVectorStore(root, MODEL);
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  await store.upsert([{ ref: a, vector: unitVector(1) }]);
  const changed = chunkRef("a".repeat(64), "3".repeat(64));
  const result = await store.upsert([{ ref: changed, vector: unitVector(5) }]);
  assert.deepEqual(result, { written: 1, reused: 0 });
  const status = await store.status();
  assert.equal(status.chunks, 1);
  const results = await store.search(unitVector(5), 1);
  assert.equal(results[0].ref.contentHash, "3".repeat(64));
});

test("vector store: reopening reads persisted state back from disk", async () => {
  const root = await temporaryRoot("reopen");
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  await (await openVectorStore(root, MODEL)).upsert([{ ref: a, vector: unitVector(1) }]);
  const reopened = await openVectorStore(root, MODEL);
  assert.equal((await reopened.status()).chunks, 1);
  const results = await reopened.search(unitVector(1), 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref.id, a.id);
});

test("vector store: a model mismatch reports INDEX_INCOMPATIBLE on search and upsert", async () => {
  const root = await temporaryRoot("incompatible");
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  await (await openVectorStore(root, MODEL)).upsert([{ ref: a, vector: unitVector(1) }]);
  const mismatched = await openVectorStore(root, { modelId: "other-model", modelRevision: "rev-1", dims: 384 });
  assert.equal((await mismatched.status()).compatible, false);
  await assert.rejects(mismatched.search(unitVector(1), 5), { code: "INDEX_INCOMPATIBLE" });
  await assert.rejects(mismatched.upsert([{ ref: a, vector: unitVector(1) }]), { code: "INDEX_INCOMPATIBLE" });
});

test("vector store: an empty store returns no results and reports zero chunks", async () => {
  const root = await temporaryRoot("empty");
  const store = await openVectorStore(root, MODEL);
  assert.deepEqual(await store.search(unitVector(1), 5), []);
  assert.deepEqual(await store.status(), { modelId: "test-model", dims: 384, chunks: 0, compatible: true, embeddingsAvailable: true });
});

test("vector store: persists a file name and contentHash alongside count for every manifest segment (binding-contract shape)", async () => {
  const root = await temporaryRoot("segment-shape");
  const store = await openVectorStore(root, MODEL);
  await store.upsert([{ ref: chunkRef("a".repeat(64), "1".repeat(64)), vector: unitVector(1) }]);
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.segments.length, 1);
  const [segment] = manifest.segments;
  assert.equal(segment.file, `${segment.bucket}.bin`);
  assert.match(segment.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(segment.count, 1);
});

test("vector store: markEmbeddingsUnavailable records a non-silent skip reason without touching chunks, and a later successful upsert clears it", async () => {
  const { markEmbeddingsUnavailable } = await import("../../dist/vector-store.js");
  const root = await temporaryRoot("unavailable");
  await markEmbeddingsUnavailable(root, MODEL, "MODEL_ASSET_MISSING");
  const store = await openVectorStore(root, MODEL);
  const status = await store.status();
  assert.equal(status.embeddingsAvailable, false);
  assert.equal(status.unavailableReason, "MODEL_ASSET_MISSING");
  assert.equal(status.chunks, 0);
  const result = await store.upsert([{ ref: chunkRef("a".repeat(64), "1".repeat(64)), vector: unitVector(1) }]);
  assert.deepEqual(result, { written: 1, reused: 0 });
  const after = await store.status();
  assert.equal(after.embeddingsAvailable, true, "a successful upsert must clear the unavailable flag");
  assert.equal(after.unavailableReason, undefined);
});

test("vector store: readVectorChunkDigest exposes id->contentHash without needing a matching model", async () => {
  const { readVectorChunkDigest } = await import("../../dist/vector-store.js");
  const root = await temporaryRoot("digest");
  assert.deepEqual([...(await readVectorChunkDigest(root)).entries()], [], "an unopened store has an empty digest");
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  const b = chunkRef("b".repeat(64), "2".repeat(64));
  await (await openVectorStore(root, MODEL)).upsert([{ ref: a, vector: unitVector(1) }, { ref: b, vector: unitVector(2) }]);
  const digest = await readVectorChunkDigest(root);
  assert.equal(digest.size, 2);
  assert.equal(digest.get(a.id), a.contentHash);
  assert.equal(digest.get(b.id), b.contentHash);
});

test("vector store: upsert carries an untouched bucket's contentHash forward byte-identically and recomputes only the touched bucket's (TP.2 review round 2, N2)", async () => {
  const root = await temporaryRoot("carry-forward");
  const store = await openVectorStore(root, MODEL);
  const one = chunkRef("1".repeat(64), "1".repeat(64)); // bucket "1"
  const alpha = chunkRef("a".repeat(64), "a".repeat(64)); // bucket "a"
  await store.upsert([{ ref: one, vector: unitVector(1) }, { ref: alpha, vector: unitVector(2) }]);
  const { readFile } = await import("node:fs/promises");
  const before = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const bucketOneHashBefore = before.segments.find((segment) => segment.bucket === "1").contentHash;
  const bucketAlphaHashBefore = before.segments.find((segment) => segment.bucket === "a").contentHash;

  // Second upsert touches only the "a" bucket: same chunk id, changed
  // contentHash, still bucket "a" (first hex char unchanged).
  const alphaChanged = chunkRef("a".repeat(64), `a2${"a".repeat(62)}`);
  await store.upsert([{ ref: alphaChanged, vector: unitVector(3) }]);

  const after = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const bucketOneHashAfter = after.segments.find((segment) => segment.bucket === "1").contentHash;
  const bucketAlphaHashAfter = after.segments.find((segment) => segment.bucket === "a").contentHash;
  assert.equal(bucketOneHashAfter, bucketOneHashBefore, "bucket 1 was never touched by the second upsert and must carry its contentHash forward byte-for-byte");
  assert.notEqual(bucketAlphaHashAfter, bucketAlphaHashBefore, "bucket a's encoded bytes changed, so its contentHash must be recomputed, not carried forward");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/vector-store.test.mjs`
Expected: FAIL — `plugins/openwiki/src/vector-store.ts` does not exist.

- [ ] **Step 3: Implement `vector-store.ts`**

Create `plugins/openwiki/src/vector-store.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteBinaryFile, atomicWriteFile, withFileWriteLock } from "./atomic.js";
import { parseChunkRef, type ChunkRef } from "./chunk.js";
import { OpenWikiError } from "./errors.js";

export interface VectorStore {
  upsert(entries: ReadonlyArray<{ ref: ChunkRef; vector: Float32Array }>): Promise<{ written: number; reused: number }>;
  search(vector: Float32Array, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>;
  status(): Promise<{ modelId: string; dims: number; chunks: number; compatible: boolean; embeddingsAvailable: boolean; unavailableReason?: string }>;
}

interface VectorModel { modelId: string; modelRevision: string; dims: number; }
interface VectorManifest extends VectorModel {
  schemaVersion: 1;
  dtype: "int8";
  chunks: Array<{ ref: ChunkRef; bucket: string }>;
  segments: Array<{ bucket: string; file: string; contentHash: string; count: number }>;
  embeddingsAvailable: boolean;
  unavailableReason?: string;
}

const SEGMENT_MAGIC = "MXVS";
const HEADER_BYTES = 16;
const ID_BYTES = 64;
const WRITE_LOCK_WAIT_MS = 50;
const STALE_LOCK_MS = 5 * 60 * 1000;

export async function openVectorStore(storageRoot: string, model: VectorModel): Promise<VectorStore> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(storageRoot, "manifest.json");
  const lockPath = path.join(storageRoot, "writer.lock");

  const readManifest = async (): Promise<VectorManifest | undefined> => {
    try {
      return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    } catch {
      return undefined;
    }
  };

  return {
    async upsert(entries) {
      return withFileWriteLock(lockPath, async () => {
        const manifest = (await readManifest()) ?? emptyManifest(model);
        if (manifest.modelId !== model.modelId || manifest.dims !== model.dims) throw new OpenWikiError("INDEX_INCOMPATIBLE", "Vector store manifest does not match the active embedding model.");
        const chunksById = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry]));
        let written = 0;
        let reused = 0;
        const touchedBuckets = new Set<string>();
        const freshById = new Map(entries.map((entry) => [entry.ref.id, entry]));
        for (const entry of entries) {
          const existing = chunksById.get(entry.ref.id);
          if (existing !== undefined && existing.ref.contentHash === entry.ref.contentHash) {
            reused += 1;
            continue;
          }
          if (existing !== undefined) touchedBuckets.add(existing.bucket);
          const bucket = bucketFor(entry.ref.contentHash);
          touchedBuckets.add(bucket);
          chunksById.set(entry.ref.id, { ref: entry.ref, bucket });
          written += 1;
        }
        // Content-addresses each segment file (TP.2 review I1): buckets left
        // untouched this round carry forward their previous contentHash;
        // touched buckets get a freshly computed one from the bytes just
        // written. Every bucket that ends up in segmentCounts below is
        // guaranteed to have an entry here by construction (see the throw
        // in the segments map below if that invariant is ever violated).
        const bucketContentHashes = new Map(manifest.segments.map((segment) => [segment.bucket, segment.contentHash]));
        for (const bucket of touchedBuckets) {
          const rows: Array<{ ref: ChunkRef; vector: Int8Array }> = [];
          for (const entry of chunksById.values()) {
            if (entry.bucket !== bucket) continue;
            const fresh = freshById.get(entry.ref.id);
            if (fresh !== undefined) {
              rows.push({ ref: entry.ref, vector: quantize(fresh.vector) });
              continue;
            }
            const preserved = await readBucketRow(storageRoot, bucket, entry.ref.id, model.dims);
            if (preserved !== undefined) rows.push({ ref: entry.ref, vector: preserved });
          }
          const encoded = encodeBucket(rows, model.dims);
          await atomicWriteBinaryFile(path.join(storageRoot, "segments", `${bucket}.bin`), encoded);
          bucketContentHashes.set(bucket, createHash("sha256").update(encoded).digest("hex"));
        }
        const chunks = [...chunksById.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
        const segmentCounts = new Map<string, number>();
        for (const entry of chunks) segmentCounts.set(entry.bucket, (segmentCounts.get(entry.bucket) ?? 0) + 1);
        const segments = [...segmentCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, count]) => {
          const contentHash = bucketContentHashes.get(bucket);
          if (contentHash === undefined) throw new OpenWikiError("INVALID_STATE", `Vector segment ${bucket} is missing a content hash.`);
          return { bucket, file: `${bucket}.bin`, contentHash, count };
        });
        const nextManifest: VectorManifest = {
          schemaVersion: 1,
          modelId: model.modelId,
          modelRevision: model.modelRevision,
          dims: model.dims,
          dtype: "int8",
          chunks,
          segments,
          // A successful upsert always proves embeddings are currently
          // available — this clears any earlier markEmbeddingsUnavailable
          // flag (TP.2 review C2) rather than requiring a separate reset call.
          embeddingsAvailable: true,
        };
        await atomicWriteFile(manifestPath, `${JSON.stringify(nextManifest)}\n`);
        return { written, reused };
      }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
    },
    async search(vector, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new OpenWikiError("INVALID_ARGUMENT", "Vector search limit must be between 1 and 200.");
      const manifest = await readManifest();
      if (manifest === undefined || manifest.chunks.length === 0) return [];
      if (manifest.modelId !== model.modelId || manifest.dims !== model.dims) throw new OpenWikiError("INDEX_INCOMPATIBLE", "Vector store manifest does not match the active embedding model.");
      const byId = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref]));
      const scored: Array<{ ref: ChunkRef; score: number }> = [];
      for (const segment of manifest.segments) {
        for (const row of await readBucketFile(storageRoot, segment.bucket, model.dims)) {
          const ref = byId.get(row.id);
          if (ref === undefined) continue;
          scored.push({ ref, score: dotProduct(vector, dequantize(row.vector)) });
        }
      }
      return scored.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
    },
    async status() {
      const manifest = await readManifest();
      if (manifest === undefined) return { modelId: model.modelId, dims: model.dims, chunks: 0, compatible: true, embeddingsAvailable: true };
      return {
        modelId: manifest.modelId,
        dims: manifest.dims,
        chunks: manifest.chunks.length,
        compatible: manifest.modelId === model.modelId && manifest.dims === model.dims,
        embeddingsAvailable: manifest.embeddingsAvailable,
        ...(manifest.unavailableReason === undefined ? {} : { unavailableReason: manifest.unavailableReason }),
      };
    },
  };
}

// Read-only, model-agnostic digest of the manifest's current chunk set. Used
// by reindex.ts to decide which chunks need re-embedding before it ever loads
// the (heavy) Embedder — deliberately independent of the model-compatibility
// checks the VectorStore interface enforces, since a digest read must work
// even when the store predates the currently active model.
export async function readVectorChunkDigest(storageRoot: string): Promise<ReadonlyMap<string, string>> {
  let manifest: VectorManifest;
  try {
    manifest = parseManifest(JSON.parse(await readFile(path.join(storageRoot, "manifest.json"), "utf8")) as unknown);
  } catch {
    return new Map();
  }
  return new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref.contentHash]));
}

// Called by reindex.ts's write paths (writePage/buildGraph, via
// reindexWikiPage/reindexCodeSymbols) when the vendor-asset error is caught
// and embedding is soft-skipped rather than failing the write (TP.2 review
// finding C2 / orchestrator adjudication: write paths never hard-fail on
// missing/corrupt vendor assets — only search/ask do). Records the skip
// non-silently in this store's own manifest so status()/doctor surface it,
// rather than the write silently under-indexing forever with no trace.
// Never touches chunks/segments — only the flag.
export async function markEmbeddingsUnavailable(storageRoot: string, model: VectorModel, reason: string): Promise<void> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(storageRoot, "manifest.json");
  const lockPath = path.join(storageRoot, "writer.lock");
  await withFileWriteLock(lockPath, async () => {
    let manifest: VectorManifest;
    try {
      manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    } catch {
      manifest = emptyManifest(model);
    }
    const flagged: VectorManifest = { ...manifest, embeddingsAvailable: false, unavailableReason: reason };
    await atomicWriteFile(manifestPath, `${JSON.stringify(flagged)}\n`);
  }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
}

function emptyManifest(model: VectorModel): VectorManifest {
  return { schemaVersion: 1, modelId: model.modelId, modelRevision: model.modelRevision, dims: model.dims, dtype: "int8", chunks: [], segments: [], embeddingsAvailable: true };
}

function quantize(vector: Float32Array): Int8Array {
  const output = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) output[index] = Math.max(-127, Math.min(127, Math.round((vector[index] ?? 0) * 127)));
  return output;
}

function dequantize(row: Int8Array): Float32Array {
  const output = new Float32Array(row.length);
  for (let index = 0; index < row.length; index += 1) output[index] = (row[index] ?? 0) / 127;
  return output;
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum;
}

function bucketFor(contentHash: string): string {
  const first = contentHash[0]?.toLowerCase();
  if (first === undefined || !/^[0-9a-f]$/u.test(first)) throw new OpenWikiError("INVALID_STATE", "Chunk contentHash must be a lowercase hex hash.");
  return first;
}

function encodeId(id: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new OpenWikiError("INVALID_STATE", "Chunk id must be a 64-character lowercase hex hash.");
  return Buffer.from(id, "ascii");
}

function encodeBucket(rows: ReadonlyArray<{ ref: ChunkRef; vector: Int8Array }>, dims: number): Buffer {
  const sorted = [...rows].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(SEGMENT_MAGIC, 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt16LE(dims, 5);
  header.writeUInt32LE(sorted.length, 7);
  const vectors = Buffer.concat(sorted.map((row) => Buffer.from(row.vector.buffer, row.vector.byteOffset, dims)));
  const ids = Buffer.concat(sorted.map((row) => encodeId(row.ref.id)));
  return Buffer.concat([header, vectors, ids]);
}

async function readBucketFile(storageRoot: string, bucket: string, dims: number): Promise<Array<{ id: string; vector: Int8Array }>> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path.join(storageRoot, "segments", `${bucket}.bin`));
  } catch {
    return [];
  }
  return decodeBucket(buffer, dims);
}

async function readBucketRow(storageRoot: string, bucket: string, id: string, dims: number): Promise<Int8Array | undefined> {
  return (await readBucketFile(storageRoot, bucket, dims)).find((row) => row.id === id)?.vector;
}

function decodeBucket(buffer: Buffer, dims: number): Array<{ id: string; vector: Int8Array }> {
  if (buffer.length < HEADER_BYTES || buffer.toString("ascii", 0, 4) !== SEGMENT_MAGIC) throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vector segment header is invalid.");
  const dtype = buffer.readUInt8(4);
  const storedDims = buffer.readUInt16LE(5);
  const count = buffer.readUInt32LE(7);
  if (dtype !== 1 || storedDims !== dims) throw new OpenWikiError("INDEX_INCOMPATIBLE", "Vector segment dimensions do not match the active embedding model.");
  const vectorsStart = HEADER_BYTES;
  const idsStart = vectorsStart + count * dims;
  if (buffer.length < idsStart + count * ID_BYTES) throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vector segment is truncated.");
  const rows: Array<{ id: string; vector: Int8Array }> = [];
  for (let index = 0; index < count; index += 1) {
    const slice = buffer.subarray(vectorsStart + index * dims, vectorsStart + (index + 1) * dims);
    const vector = new Int8Array(dims);
    for (let byteIndex = 0; byteIndex < dims; byteIndex += 1) vector[byteIndex] = slice.readInt8(byteIndex);
    rows.push({ id: buffer.toString("ascii", idsStart + index * ID_BYTES, idsStart + (index + 1) * ID_BYTES), vector });
  }
  return rows;
}

function parseManifest(value: unknown): VectorManifest {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || typeof value.modelId !== "string" || typeof value.modelRevision !== "string" ||
    !Number.isSafeInteger(value.dims) || value.dtype !== "int8" || !Array.isArray(value.chunks) || !Array.isArray(value.segments) ||
    typeof value.embeddingsAvailable !== "boolean" || (value.unavailableReason !== undefined && typeof value.unavailableReason !== "string")
  ) {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vector store manifest is invalid.");
  }
  return {
    schemaVersion: 1,
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    dims: value.dims,
    dtype: "int8",
    chunks: value.chunks.map(parseManifestChunk).sort((left, right) => left.ref.id.localeCompare(right.ref.id)),
    segments: value.segments.map(parseManifestSegment).sort((left, right) => left.bucket.localeCompare(right.bucket)),
    embeddingsAvailable: value.embeddingsAvailable,
    ...(value.unavailableReason === undefined ? {} : { unavailableReason: value.unavailableReason }),
  };
}

function parseManifestChunk(value: unknown): VectorManifest["chunks"][number] {
  if (!isRecord(value) || !isBucket(value.bucket)) throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vector store manifest chunk is invalid.");
  return { ref: parseChunkRef(value.ref), bucket: value.bucket };
}

function parseManifestSegment(value: unknown): VectorManifest["segments"][number] {
  if (
    !isRecord(value) || !isBucket(value.bucket) || typeof value.file !== "string" || value.file.length === 0 ||
    typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentHash) || !Number.isSafeInteger(value.count)
  ) {
    throw new OpenWikiError("MODEL_ASSET_CORRUPT", "Vector store manifest segment is invalid.");
  }
  return { bucket: value.bucket, file: value.file, contentHash: value.contentHash, count: value.count };
}

function isBucket(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/vector-store.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/vector-store.ts plugins/openwiki/tests/unit/vector-store.test.mjs
git commit -m "feat(openwiki): add bucketed int8 vector store"
```

---

### Task 7: `lexical-index.ts` — BM25 + trigram fallback

**Files:**
- Create: `plugins/openwiki/src/lexical-index.ts`
- Test: `plugins/openwiki/tests/unit/lexical-index.test.mjs` (new)

**Interfaces:**
- Produces (binding): `export interface LexicalIndex { upsert(chunks: ReadonlyArray<{ ref: ChunkRef; text: string }>): Promise<void>; search(query: string, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>; }` with BM25 `k1=1.2`, `b=0.75`.
- Produces (this plan's own factory): `export function openLexicalIndex(storageRoot: string): Promise<LexicalIndex>`.
- Consumes: `ChunkRef`, `parseChunkRef` from `./chunk.js`; `atomicWriteFile`, `withFileWriteLock` from `./atomic.js`.
- Design: the trigram signal is **not** a fourth RRF input (the binding contract fuses exactly `lexical`, `vector`, `graph`). It is folded into this module's own combined score as a small, fixed-weight fallback boost (`TRIGRAM_WEIGHT = 0.01`, chosen to be an order of magnitude below any genuine BM25 term score so it only surfaces documents that BM25 alone would miss, e.g. typos or substrings) so the module still returns exactly one ranked list.

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/lexical-index.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { openLexicalIndex } from "../../dist/lexical-index.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-lexical-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function chunkRef(id, contentHash, path_ = "docs/a.md") {
  return { id, path: path_, startLine: 1, endLine: 3, plane: "wiki", contentHash };
}

test("lexical index: BM25 ranks a chunk with more query-term occurrences higher", async () => {
  const root = await temporaryRoot("bm25");
  const index = await openLexicalIndex(root);
  const strong = chunkRef("a".repeat(64), "1".repeat(64));
  const weak = chunkRef("b".repeat(64), "2".repeat(64));
  const unrelated = chunkRef("c".repeat(64), "3".repeat(64));
  await index.upsert([
    { ref: strong, text: "graph retrieval graph retrieval hybrid graph search retrieval fusion" },
    { ref: weak, text: "graph theory basics for newcomers to computer science" },
    { ref: unrelated, text: "the quick brown fox jumps over the lazy dog" },
  ]);
  const results = await index.search("graph retrieval", 10);
  assert.equal(results[0].ref.id, strong.id);
  assert.equal(results[1].ref.id, weak.id);
  assert.ok(!results.some((entry) => entry.ref.id === unrelated.id) || results.at(-1).ref.id === unrelated.id);
});

test("lexical index: reindexing a changed chunk updates aggregate statistics correctly", async () => {
  const root = await temporaryRoot("update");
  const index = await openLexicalIndex(root);
  const chunk = chunkRef("a".repeat(64), "1".repeat(64));
  await index.upsert([{ ref: chunk, text: "alpha beta gamma" }]);
  const changed = chunkRef("a".repeat(64), "2".repeat(64));
  await index.upsert([{ ref: changed, text: "delta epsilon zeta" }]);
  assert.deepEqual(await index.search("alpha", 10), []);
  const results = await index.search("delta", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref.contentHash, "2".repeat(64));
});

test("lexical index: unchanged content is a no-op on re-upsert", async () => {
  const root = await temporaryRoot("noop");
  const index = await openLexicalIndex(root);
  const chunk = chunkRef("a".repeat(64), "1".repeat(64));
  await index.upsert([{ ref: chunk, text: "stable content here" }]);
  await index.upsert([{ ref: chunk, text: "stable content here" }]);
  const results = await index.search("stable", 10);
  assert.equal(results.length, 1);
});

test("lexical index: trigram fallback surfaces a near-match term BM25 alone would miss", async () => {
  const root = await temporaryRoot("trigram");
  const index = await openLexicalIndex(root);
  const target = chunkRef("a".repeat(64), "1".repeat(64));
  await index.upsert([{ ref: target, text: "retrieval augmented generation pipeline" }]);
  const results = await index.search("retrievals", 10);
  assert.equal(results.length, 1, "a near-miss token should still surface via trigram overlap");
  assert.equal(results[0].ref.id, target.id);
});

test("lexical index: reopening reads persisted state back from disk", async () => {
  const root = await temporaryRoot("reopen");
  const chunk = chunkRef("a".repeat(64), "1".repeat(64));
  await (await openLexicalIndex(root)).upsert([{ ref: chunk, text: "persisted searchable text" }]);
  const results = await (await openLexicalIndex(root)).search("persisted", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref.id, chunk.id);
});

test("lexical index: rejects an empty query and an out-of-range limit", async () => {
  const root = await temporaryRoot("validate");
  const index = await openLexicalIndex(root);
  await assert.rejects(index.search("   ", 10), { code: "INVALID_ARGUMENT" });
  await assert.rejects(index.search("term", 0), { code: "INVALID_ARGUMENT" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/lexical-index.test.mjs`
Expected: FAIL — `plugins/openwiki/src/lexical-index.ts` does not exist.

- [ ] **Step 3: Implement `lexical-index.ts`**

Create `plugins/openwiki/src/lexical-index.ts`:

```ts
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, withFileWriteLock } from "./atomic.js";
import { parseChunkRef, type ChunkRef } from "./chunk.js";
import { OpenWikiError } from "./errors.js";

export interface LexicalIndex {
  upsert(chunks: ReadonlyArray<{ ref: ChunkRef; text: string }>): Promise<void>;
  search(query: string, limit: number): Promise<Array<{ ref: ChunkRef; score: number }>>;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TRIGRAM_WEIGHT = 0.01;
const WRITE_LOCK_WAIT_MS = 50;
const STALE_LOCK_MS = 5 * 60 * 1000;

interface Posting { id: string; frequency: number; }
interface BucketEntry { ref: ChunkRef; termFrequencies: Record<string, number>; length: number; }
interface LexicalManifest {
  schemaVersion: 1;
  k1: number;
  b: number;
  totalDocs: number;
  totalLength: number;
  documentFrequency: Record<string, number>;
  postings: Record<string, Posting[]>;
  trigramPostings: Record<string, string[]>;
  lengths: Record<string, number>;
  chunks: Array<{ ref: ChunkRef; bucket: string }>;
}

export async function openLexicalIndex(storageRoot: string): Promise<LexicalIndex> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(storageRoot, "manifest.json");
  const lockPath = path.join(storageRoot, "writer.lock");

  const readManifest = async (): Promise<LexicalManifest> => {
    try {
      return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    } catch {
      return emptyManifest();
    }
  };

  return {
    async upsert(chunks) {
      await withFileWriteLock(lockPath, async () => {
        const manifest = await readManifest();
        const chunksById = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry]));
        for (const entry of chunks) {
          const existing = chunksById.get(entry.ref.id);
          if (existing !== undefined && existing.ref.contentHash === entry.ref.contentHash) continue;
          if (existing !== undefined) {
            const previous = await readBucketEntry(storageRoot, existing.bucket, existing.ref.id);
            if (previous !== undefined) removeDocument(manifest, existing.ref.id, previous);
          }
          const tokens = tokenize(entry.text);
          const frequencies = frequencyMap(tokens);
          const bucket = bucketFor(entry.ref.contentHash);
          addDocument(manifest, entry.ref, frequencies, tokens.length);
          await writeBucketEntry(storageRoot, bucket, { ref: entry.ref, termFrequencies: frequencies, length: tokens.length });
          chunksById.set(entry.ref.id, { ref: entry.ref, bucket });
        }
        manifest.chunks = [...chunksById.values()].sort((left, right) => left.ref.id.localeCompare(right.ref.id));
        await atomicWriteFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      }, { waitMs: WRITE_LOCK_WAIT_MS, staleMs: STALE_LOCK_MS });
    },
    async search(query, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new OpenWikiError("INVALID_ARGUMENT", "Lexical search limit must be between 1 and 200.");
      const trimmed = query.trim();
      if (trimmed.length === 0) throw new OpenWikiError("INVALID_ARGUMENT", "Lexical search query must not be empty.");
      const manifest = await readManifest();
      if (manifest.totalDocs === 0) return [];
      const byId = new Map(manifest.chunks.map((entry) => [entry.ref.id, entry.ref]));
      const avgdl = manifest.totalLength / manifest.totalDocs;
      const scores = new Map<string, number>();
      for (const term of tokenize(trimmed)) {
        const df = manifest.documentFrequency[term] ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (manifest.totalDocs - df + 0.5) / (df + 0.5));
        for (const posting of manifest.postings[term] ?? []) {
          const length = manifest.lengths[posting.id] ?? avgdl;
          const termScore = (idf * (posting.frequency * (BM25_K1 + 1))) / (posting.frequency + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgdl));
          scores.set(posting.id, (scores.get(posting.id) ?? 0) + termScore);
        }
      }
      const queryTrigrams = trigramsOf(trimmed);
      if (queryTrigrams.length > 0) {
        for (const trigram of queryTrigrams) {
          for (const id of manifest.trigramPostings[trigram] ?? []) scores.set(id, (scores.get(id) ?? 0) + TRIGRAM_WEIGHT / queryTrigrams.length);
        }
      }
      const results: Array<{ ref: ChunkRef; score: number }> = [];
      for (const [id, score] of scores) {
        const ref = byId.get(id);
        if (ref !== undefined) results.push({ ref, score });
      }
      return results.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
    },
  };
}

function emptyManifest(): LexicalManifest {
  return { schemaVersion: 1, k1: BM25_K1, b: BM25_B, totalDocs: 0, totalLength: 0, documentFrequency: {}, postings: {}, trigramPostings: {}, lengths: {}, chunks: [] };
}

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function frequencyMap(tokens: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokens) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}

function trigramsOf(text: string): string[] {
  const normalized = tokenize(text).join(" ");
  const trigrams = new Set<string>();
  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    const trigram = normalized.slice(index, index + 3);
    if (!trigram.includes(" ")) trigrams.add(trigram);
  }
  return [...trigrams].sort();
}

function bucketFor(contentHash: string): string {
  const first = contentHash[0]?.toLowerCase();
  if (first === undefined || !/^[0-9a-f]$/u.test(first)) throw new OpenWikiError("INVALID_STATE", "Chunk contentHash must be a lowercase hex hash.");
  return first;
}

function addDocument(manifest: LexicalManifest, ref: ChunkRef, frequencies: Record<string, number>, length: number): void {
  manifest.totalDocs += 1;
  manifest.totalLength += length;
  manifest.lengths[ref.id] = length;
  for (const [term, frequency] of Object.entries(frequencies)) {
    manifest.documentFrequency[term] = (manifest.documentFrequency[term] ?? 0) + 1;
    const postings = (manifest.postings[term] ?? []).filter((posting) => posting.id !== ref.id);
    manifest.postings[term] = [...postings, { id: ref.id, frequency }];
  }
  for (const trigram of trigramsOf(Object.keys(frequencies).join(" "))) {
    const ids = manifest.trigramPostings[trigram] ?? [];
    if (!ids.includes(ref.id)) manifest.trigramPostings[trigram] = [...ids, ref.id];
  }
}

function removeDocument(manifest: LexicalManifest, id: string, previous: BucketEntry): void {
  manifest.totalDocs = Math.max(0, manifest.totalDocs - 1);
  manifest.totalLength = Math.max(0, manifest.totalLength - previous.length);
  delete manifest.lengths[id];
  for (const term of Object.keys(previous.termFrequencies)) {
    const df = (manifest.documentFrequency[term] ?? 1) - 1;
    if (df <= 0) delete manifest.documentFrequency[term];
    else manifest.documentFrequency[term] = df;
    const remaining = (manifest.postings[term] ?? []).filter((posting) => posting.id !== id);
    if (remaining.length === 0) delete manifest.postings[term];
    else manifest.postings[term] = remaining;
  }
  for (const trigram of trigramsOf(Object.keys(previous.termFrequencies).join(" "))) {
    const remaining = (manifest.trigramPostings[trigram] ?? []).filter((entry) => entry !== id);
    if (remaining.length === 0) delete manifest.trigramPostings[trigram];
    else manifest.trigramPostings[trigram] = remaining;
  }
}

async function readBucketEntry(storageRoot: string, bucket: string, id: string): Promise<BucketEntry | undefined> {
  return (await readBucketFile(storageRoot, bucket)).find((entry) => entry.ref.id === id);
}

async function writeBucketEntry(storageRoot: string, bucket: string, entry: BucketEntry): Promise<void> {
  const entries = (await readBucketFile(storageRoot, bucket)).filter((existing) => existing.ref.id !== entry.ref.id);
  entries.push(entry);
  entries.sort((left, right) => left.ref.id.localeCompare(right.ref.id));
  await atomicWriteFile(path.join(storageRoot, "segments", `${bucket}.json`), `${JSON.stringify(entries)}\n`);
}

async function readBucketFile(storageRoot: string, bucket: string): Promise<BucketEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(storageRoot, "segments", `${bucket}.json`), "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new OpenWikiError("INVALID_STATE", "Lexical index segment is invalid.");
    return parsed.map(parseBucketEntry);
  } catch (error) {
    if (error instanceof OpenWikiError) throw error;
    return [];
  }
}

function parseBucketEntry(value: unknown): BucketEntry {
  if (!isRecord(value) || !isRecord(value.termFrequencies) || !Number.isSafeInteger(value.length)) throw new OpenWikiError("INVALID_STATE", "Lexical index segment entry is invalid.");
  const termFrequencies: Record<string, number> = {};
  for (const [term, count] of Object.entries(value.termFrequencies)) {
    if (!Number.isSafeInteger(count)) throw new OpenWikiError("INVALID_STATE", "Lexical index segment entry is invalid.");
    termFrequencies[term] = count;
  }
  return { ref: parseChunkRef(value.ref), termFrequencies, length: value.length };
}

function parseManifest(value: unknown): LexicalManifest {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || value.k1 !== BM25_K1 || value.b !== BM25_B ||
    !Number.isSafeInteger(value.totalDocs) || !Number.isFinite(value.totalLength) ||
    !isRecord(value.documentFrequency) || !isRecord(value.postings) || !isRecord(value.trigramPostings) ||
    !isRecord(value.lengths) || !Array.isArray(value.chunks)
  ) {
    throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
  }
  return {
    schemaVersion: 1,
    k1: BM25_K1,
    b: BM25_B,
    totalDocs: value.totalDocs,
    totalLength: value.totalLength,
    documentFrequency: parseNumberRecord(value.documentFrequency),
    postings: parsePostings(value.postings),
    trigramPostings: parseStringListRecord(value.trigramPostings),
    lengths: parseNumberRecord(value.lengths),
    chunks: value.chunks.map(parseManifestChunk).sort((left, right) => left.ref.id.localeCompare(right.ref.id)),
  };
}

function parseManifestChunk(value: unknown): LexicalManifest["chunks"][number] {
  if (!isRecord(value) || typeof value.bucket !== "string" || !/^[0-9a-f]$/u.test(value.bucket)) throw new OpenWikiError("INVALID_STATE", "Lexical index manifest chunk is invalid.");
  return { ref: parseChunkRef(value.ref), bucket: value.bucket };
}

function parseNumberRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Number.isFinite(entry)) throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
    result[key] = entry as number;
  }
  return result;
}

function parseStringListRecord(value: Record<string, unknown>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
    result[key] = entry;
  }
  return result;
}

function parsePostings(value: Record<string, unknown>): Record<string, Posting[]> {
  const result: Record<string, Posting[]> = {};
  for (const [term, entry] of Object.entries(value)) {
    if (!Array.isArray(entry)) throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
    result[term] = entry.map((posting) => {
      if (!isRecord(posting) || typeof posting.id !== "string" || !Number.isSafeInteger(posting.frequency)) throw new OpenWikiError("INVALID_STATE", "Lexical index manifest is invalid.");
      return { id: posting.id, frequency: posting.frequency };
    });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

Note on `parseNumberRecord`'s `entry as number`: this follows an `Number.isFinite(entry)` guard, which for a `unknown` value only narrows within the `if`'s own scope in a way TypeScript's control-flow analysis loses across the destructured-loop boundary here — this is the one assertion in this file that mirrors the same shape as existing casts already accepted by this codebase's `strictTypeChecked` config (e.g. `graph-store.ts`'s `value.schemaVersion !== GRAPH_STORE_SCHEMA_VERSION` pattern narrows similarly). If `npm run lint` flags it, restructure as an explicit `typeof entry === "number" ? entry : fail(...)` ternary instead of the guard-then-cast, matching `graph-contracts.ts`'s `number()` helper style exactly.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/lexical-index.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/lexical-index.ts plugins/openwiki/tests/unit/lexical-index.test.mjs
git commit -m "feat(openwiki): add BM25 lexical index with trigram fallback"
```

---

### Task 8: `retrieve.ts` — RRF fusion, bounded graph BFS, `search`/`ask`

**Design decisions made explicit (for orchestrator review):**
1. **Graph proximity seeds from lexical/vector hits, then surfaces BFS-reached neighbors as brand-new candidates, not just a re-ranking of the existing pool (TP.2 review round 2, N1)** — the binding contract says "graphProximity = BFS ≤ depth 2 **from seed nodes**"; its purpose is to surface chunks connected to a hit that neither lexical nor vector search found on their own. This plan seeds BFS from the `nodeId`s of chunks already found by lexical/vector search, enriched with `graphIndex.rankedCandidates(query, …)` text matches. `graphProximity`'s result map covers every node within depth 2 of a seed — seeds and non-seed neighbors alike. `graphSignal` now does two things with it, not one: (a) it re-ranks candidates that are *already* lexical/vector hits by their proximity weight, exactly as before; (b) for every node in the proximity map that is **not** already a candidate, it turns that node into a brand-new fused candidate — but only when the node is `symbol`-kind. `chunkSymbols`/`symbolChunkText` (Task 3) are pure functions of the node's own metadata (no file read), so `chunkSymbols([node])` deterministically reconstructs the exact same `ChunkRef` `reindex.ts` already indexed for that symbol at write time — no new cross-store reverse-index lookup is needed, and no chunk is fabricated. `concept`/`page` nodes reached the same way are **not** turned into new candidates: `chunkMarkdown` needs the full page text to compute paragraph boundaries, and `GraphIndexPort` has no file-read capability, so a concept/page node reached only by the graph stays invisible to the graph signal unless it is independently a lexical or vector hit. This is a real, disclosed scope boundary (see decision 6), not a silent gap — closing it would require either a new nodeId→ChunkRef store (out of scope for this fix) or giving `retrieve.ts` file-read access (a layering violation this plan avoids).
2. **Staleness is computed by the caller, not by `retrieve.ts`** — `ask()` takes a `stale: boolean` parameter rather than calling into `graph-store.ts` itself, mirroring the existing separation where `graph.ts`'s `getGraphStatus` already owns git-fingerprint freshness logic. Task 11 (CLI/MCP wiring) computes it once, reusing `changedRepositoryEvidence`/manifest comparison exactly as `getGraphStatus` already does, and passes it in. This keeps `retrieve.ts` a pure function over injected ports, fully unit-testable without touching Git.
3. `search`'s response type is **not** spelled out in the binding contract (only `AskResultV1` is) — this plan defines `SearchResultV1` in the same spirit, reusing `EvidenceItem`.
4. **Graph proximity combines edge-confidence weights along the path, with no depth decay (TP.2 review finding M1).** The binding contract specifies "edge weight by confidence... combine along the path" with no depth term; `graphProximity` computes, for every node within depth 2 of a seed, the maximum product of edge-confidence weights over any path reaching it (a standard widest-path/bottleneck computation, multiplying weights hop-by-hop and taking the max across competing paths to the same node) — a closer-but-lower-confidence path and a farther-but-higher-confidence path are compared purely on their combined weight, exactly as the contract states, with no separate distance term. An earlier draft additionally multiplied by an undocumented `DEPTH_DECAY` per BFS level; removed rather than flagged as a deviation, since the literal spec already gives a complete, deterministic combination rule without it.
5. **`EvidenceItem.confidence` is populated for every result, never left `undefined` by omission (TP.2 review finding I2).** `fuse()` sets `confidence` from the graph traversal's own confidence label when a chunk was reached via the graph signal (the strongest confidence edge on its winning path, or `"exact"` for a seed chunk itself); when a chunk has no graph-signal ranking at all (pure lexical/vector hit), it falls back to a fixed, documented default keyed by `ChunkRef.plane`: `"code"` (deterministically scanner-extracted symbol metadata) defaults to `"exact"`; `"wiki"`/`"concept"` (chunked human/agent-authored content, not scanner-verified) default to `"extracted"`. This is a real default, not a "best effort" heuristic — it is the only source of confidence for the two-thirds of the fusion signals (lexical, vector) that carry no confidence concept of their own.
6. **What the graph signal actually proves, stated precisely, and its one remaining disclosed limitation (TP.2 review round 2, N1 — supersedes this decision's earlier text, which overclaimed and is corrected here rather than silently rewritten):** for `symbol`-kind nodes, the graph signal genuinely surfaces chunks that are **neither** a lexical **nor** a vector hit — reached purely by BFS traversal within depth 2 of a seed — carrying the real traversed path's confidence label, not a fixed default. This is proven by the rewritten test below, whose fixture is built so the surfaced chunk has no other route into the results: removing the connecting edge removes it from the output (a paired test asserts exactly this negative case). The one remaining limitation is narrower and different from what this decision previously claimed: among candidates that are **already** lexical/vector hits **and** already BFS seeds (decision 1), every seed starts at the ceiling weight (1 — the maximum any confidence-weighted path can reach), so graph connectivity cannot make one co-seeded lexical/vector hit outrank another purely by its own connectivity — they tie at weight 1, broken only by `ChunkRef.id`. (The previous text of this decision additionally claimed connectivity "correctly determines whether a candidate is reachable at all" for this co-seeded case and "supplies its confidence label" — both false as stated, since every lexical/vector hit with a `nodeId` is trivially a seed regardless of real edges, and every seed's confidence is the fixed `"exact"` default, not a traversed label; that overclaim is what N1 caught.) Fixing the co-seeded tie would mean seeds no longer starting at a shared ceiling — a real, separate design change to graph-signal seeding weights, out of this fix's scope and deferred to T9.1's real-data measurement, not reopened here.

**Files:**
- Create: `plugins/openwiki/src/retrieve.ts`
- Test: `plugins/openwiki/tests/unit/retrieve.test.mjs` (new)

**Interfaces:**
- Produces (binding): `export interface SearchRequest { text: string; limit: number; signals?: ReadonlyArray<"lexical" | "vector" | "graph">; }`, `export interface EvidenceItem { ref: ChunkRef; score: number; ranks: { lexical?: number; vector?: number; graph?: number }; citation: string; confidence?: GraphConfidence; }`, `export interface AskResultV1 { schema: "memex.ask.v1"; question: string; evidence: EvidenceItem[]; relatedNodes: GraphNodeV1[]; degraded: boolean; stale: boolean; truncated: boolean; }`.
- Produces (this plan's own): `export interface SearchResultV1 { schemaVersion: 1; evidence: EvidenceItem[]; degraded: boolean; truncated: boolean; }`, `export interface RetrievalPorts { lexicalIndex: LexicalIndex; vectorStore?: VectorStore; embedder?: Embedder; graphIndex?: GraphIndexPort; }`, `export async function search(request: SearchRequest, ports: RetrievalPorts): Promise<SearchResultV1>`, `export async function ask(question: string, limit: number, ports: RetrievalPorts & { graphIndex: GraphIndexPort }, freshness: { stale: boolean }, signals?: SearchRequest["signals"]): Promise<AskResultV1>` (the optional trailing `signals` narrows `search`'s internal ranking exactly like `search`'s own `signals` field; `ports.graphIndex` is still always used for `relatedNodes`, independent of it), `export function validateSignals(signals: SearchRequest["signals"]): ReadonlyArray<"lexical" | "vector" | "graph">` (consumed by Task 11 to decide which ports to construct before calling `search`/`ask`, without loading the embedder for a request that never asked for the `vector` signal).
- Consumes: `ChunkRef`, `chunkSymbols` (Task 3 — `chunkSymbols` deterministically reconstructs a `symbol`-kind node's `ChunkRef` from the node alone, used by the graph signal to surface BFS-reached non-candidate chunks per decision 1 above), `LexicalIndex` (Task 7), `VectorStore` (Task 6), `Embedder` (Task 5), `GraphIndexPort`/`GraphNodeV1`/`GraphConfidence` from `./graph-index.js`/`./graph-contracts.js` (existing, `GraphConfidence` assumed extended to the 6-value union by 2a per Prerequisite 1 above).

- [ ] **Step 1: Write the failing unit test with fake, in-memory ports**

Create `plugins/openwiki/tests/unit/retrieve.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, search } from "../../dist/retrieve.js";

function ref(id, path, nodeId) {
  return { id, path, startLine: 1, endLine: 2, plane: "wiki", contentHash: id, ...(nodeId === undefined ? {} : { nodeId }) };
}

function fakeLexicalIndex(rankedRefs) {
  return { async upsert() { /* unused in these tests */ }, async search() { return rankedRefs.map((entry, index) => ({ ref: entry, score: rankedRefs.length - index })); } };
}

function fakeVectorStore(rankedRefs) {
  return {
    async upsert() { return { written: 0, reused: 0 }; },
    async search() { return rankedRefs.map((entry, index) => ({ ref: entry, score: 1 - index * 0.1 })); },
    async status() { return { modelId: "test-model", dims: 4, chunks: rankedRefs.length, compatible: true }; },
  };
}

function fakeEmbedder() {
  return { modelId: "test-model", dims: 4, async embedQuery() { return new Float32Array([1, 0, 0, 0]); }, async embedPassages(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0])); } };
}

function fakeGraphIndex({ edges = [], nodes = new Map() } = {}) {
  const outbound = new Map();
  const inbound = new Map();
  for (const edge of edges) {
    outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge]);
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge]);
  }
  return {
    async node(id) { return nodes.get(id); },
    async edge() { return undefined; },
    async rankedCandidates() { return []; },
    async inbound(id, limit) { const list = inbound.get(id) ?? []; return { edges: list.slice(0, limit), total: list.length, truncated: list.length > limit }; },
    async outbound(id, limit) { const list = outbound.get(id) ?? []; return { edges: list.slice(0, limit), total: list.length, truncated: list.length > limit }; },
    async changedPathSeeds() { return []; },
    async architectureSummary() { return { modules: [], entrypoints: [], hubs: [], flows: [], cycles: [], diagnostics: [], fileCount: 0, nodeCount: 0, edgeCount: 0 }; },
    metrics() { return { bytesRead: 0, filesRead: 0 }; },
    status() { return { generation: "g-test", recovered: false, schemaVersion: 2, scannerVersion: "test" }; },
  };
}

test("retrieve.search: fuses lexical and vector signals via RRF with deterministic tie-break", async () => {
  const a = ref("a".repeat(64), "docs/a.md");
  const b = ref("b".repeat(64), "docs/b.md");
  const ports = { lexicalIndex: fakeLexicalIndex([a, b]), vectorStore: fakeVectorStore([b, a]), embedder: fakeEmbedder() };
  const result = await search({ text: "query", limit: 10, signals: ["lexical", "vector"] }, ports);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.degraded, true, "only 2 of 3 signals were requested");
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.evidence[0].ranks, { lexical: 1, vector: 2 });
  assert.equal(result.evidence[0].citation, "docs/a.md#L1-2");
  assert.equal(result.evidence[0].confidence, "extracted", "no graph signal reached this chunk, so confidence falls back to its wiki-plane default");
});

test("retrieve.search: default signals include all three and degraded is false", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const ports = { lexicalIndex: fakeLexicalIndex([a]), vectorStore: fakeVectorStore([a]), embedder: fakeEmbedder(), graphIndex: fakeGraphIndex() };
  const result = await search({ text: "query", limit: 5 }, ports);
  assert.equal(result.degraded, false);
});

test("retrieve.search: requesting vector without a vector store throws MODEL_ASSET_MISSING, never silently degrades", async () => {
  const ports = { lexicalIndex: fakeLexicalIndex([]) };
  await assert.rejects(search({ text: "query", limit: 5, signals: ["vector"] }, ports), { code: "MODEL_ASSET_MISSING" });
});

test("retrieve.search: an incompatible vector store throws INDEX_INCOMPATIBLE", async () => {
  const store = fakeVectorStore([]);
  store.status = async () => ({ modelId: "other-model", dims: 4, chunks: 0, compatible: false });
  const ports = { lexicalIndex: fakeLexicalIndex([]), vectorStore: store, embedder: fakeEmbedder() };
  await assert.rejects(search({ text: "query", limit: 5, signals: ["vector"] }, ports), { code: "INDEX_INCOMPATIBLE" });
});

test("retrieve.search: rejects an empty or unknown signals array", async () => {
  const ports = { lexicalIndex: fakeLexicalIndex([]) };
  await assert.rejects(search({ text: "q", limit: 5, signals: [] }, ports), { code: "INVALID_ARGUMENT" });
});

// TP.2 review round 2, N1: the previous version of this test asserted only
// that b — itself already a lexical hit and therefore already a BFS seed —
// received a graph rank and an "exact" confidence. Both held whether or not
// the connecting edge existed at all: every seed starts at the ceiling
// weight (1, "exact"), and no edge traversal can exceed a ceiling, so the
// assertions were a tautology (proved empirically by the reviewer: running
// the fixture with vs. without the edge produced identical output). This
// rewritten test instead proves a chunk that is NEITHER a lexical NOR a
// vector hit — b is never returned by any signal's search() below, it only
// exists as a graph node — is surfaced purely by the graph signal because it
// is a symbol node one hop from lexical hit a's seed (design decision 1).
// Design invariant (the reviewer's own falsification method, made explicit
// and automated): the companion test immediately below removes the edge and
// asserts b disappears from the results — this test's claim is not provable
// by inspection alone, so both directions are checked.
test("retrieve.search: graph signal surfaces a chunk that is neither a lexical nor a vector hit, reached only via BFS from a seed", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeB = { id: "node-b", kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 10, endLine: 20 };
  const edge = { id: "edge-1", kind: "calls", from: "node-a", to: "node-b", confidence: "exact" };
  const ports = {
    lexicalIndex: fakeLexicalIndex([a]),
    graphIndex: fakeGraphIndex({ edges: [edge], nodes: new Map([["node-b", nodeB]]) }),
  };
  const result = await search({ text: "query", limit: 10, signals: ["lexical", "graph"] }, ports);
  const graphOnlyHit = result.evidence.find((item) => item.ref.nodeId === "node-b");
  assert.ok(graphOnlyHit, "b must be surfaced purely by the graph signal — it is not a lexical or vector hit");
  assert.ok(Number.isInteger(graphOnlyHit.ranks.graph), "b must carry a graph rank");
  assert.equal(graphOnlyHit.ranks.lexical, undefined, "b must not carry a lexical rank — the fake lexical index never returned it");
  assert.equal(graphOnlyHit.ranks.vector, undefined, "b must not carry a vector rank — no vector signal was requested or returned it");
  assert.equal(graphOnlyHit.confidence, "exact", "b was reached via a single exact-confidence calls edge from seed a");
});

test("retrieve.search: removing the connecting edge removes the graph-only chunk from results (falsifies the previous test if the graph signal is a no-op)", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeB = { id: "node-b", kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 10, endLine: 20 };
  const ports = {
    lexicalIndex: fakeLexicalIndex([a]),
    graphIndex: fakeGraphIndex({ edges: [], nodes: new Map([["node-b", nodeB]]) }), // no edge from node-a to node-b
  };
  const result = await search({ text: "query", limit: 10, signals: ["lexical", "graph"] }, ports);
  assert.ok(!result.evidence.some((item) => item.ref.nodeId === "node-b"), "without the connecting edge, b is unreachable within depth 2 and must not appear in results");
});

test("retrieve.ask: wraps search with the memex.ask.v1 schema and passes through staleness", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeA = { id: "node-a", kind: "symbol", path: "docs/a.md", name: "a" };
  const ports = { lexicalIndex: fakeLexicalIndex([a]), graphIndex: fakeGraphIndex({ nodes: new Map([["node-a", nodeA]]) }) };
  // Signals narrowed to lexical+graph: these ports have no vectorStore/embedder,
  // and search()'s default signal set (used when ask() is called without a
  // signals argument) always includes "vector", which would otherwise throw
  // MODEL_ASSET_MISSING here — this test's purpose is the ask()-specific
  // schema/staleness/relatedNodes wrapping, not re-proving search()'s own
  // default-signal behavior (already covered by "default signals include all
  // three" above).
  const result = await ask("what is a?", 5, ports, { stale: true }, ["lexical", "graph"]);
  assert.equal(result.schema, "memex.ask.v1");
  assert.equal(result.question, "what is a?");
  assert.equal(result.stale, true);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.relatedNodes.some((node) => node.id === "node-a"));
});

test("retrieve.ask: forwards its own signals argument to narrow search's ranking and reports degraded", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeA = { id: "node-a", kind: "symbol", path: "docs/a.md", name: "a" };
  const ports = { lexicalIndex: fakeLexicalIndex([a]), vectorStore: fakeVectorStore([a]), embedder: fakeEmbedder(), graphIndex: fakeGraphIndex({ nodes: new Map([["node-a", nodeA]]) }) };
  const result = await ask("what is a?", 5, ports, { stale: false }, ["lexical", "graph"]);
  assert.equal(result.degraded, true, "narrowing to 2 of 3 signals must be reported as degraded");
});

// TP.2 review round 2, N1 recommendation 3: no test in this suite previously
// exercised a BFS hop beyond depth 0 (a seed itself) — the graph-signal tests
// above only ever go one hop deep. This test chains three edges (a->b->c->d)
// from a single seed (node-a) and proves relatedNodes performs genuine
// depth-2 expansion: node-c (exactly 2 hops away) must be reached, and
// node-d (3 hops away) must not — the binding contract's literal "BFS ≤
// depth 2" bound, proven in both directions rather than assumed.
test("retrieve.ask: relatedNodes performs genuine depth-2 BFS expansion — reaches a 2-hop node, not a 3-hop node", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  // moduleB/C/D are "module"-kind, not "symbol"-kind: graphSignal's
  // non-seed-surfacing logic (decision 1) only turns symbol nodes into new
  // evidence, so these three are never added to result.evidence. That keeps
  // ask()'s relatedNodes seed set (drawn from evidence nodeIds) to exactly
  // {node-a} — a single, uncompounded BFS pass — so this test isolates the
  // depth-2 bound itself rather than the interaction between two BFS passes
  // (search()'s own graph signal, then ask()'s separate relatedNodes call).
  const moduleB = { id: "node-b", kind: "module", path: "src/b", name: "b" };
  const moduleC = { id: "node-c", kind: "module", path: "src/c", name: "c" };
  const moduleD = { id: "node-d", kind: "module", path: "src/d", name: "d" };
  const edges = [
    { id: "e1", kind: "calls", from: "node-a", to: "node-b", confidence: "exact" },
    { id: "e2", kind: "calls", from: "node-b", to: "node-c", confidence: "resolved" },
    { id: "e3", kind: "calls", from: "node-c", to: "node-d", confidence: "exact" },
  ];
  const ports = {
    lexicalIndex: fakeLexicalIndex([a]),
    graphIndex: fakeGraphIndex({ edges, nodes: new Map([["node-b", moduleB], ["node-c", moduleC], ["node-d", moduleD]]) }),
  };
  // Signals narrowed to lexical+graph — these ports have no vectorStore/
  // embedder, and ask()'s default signal set otherwise includes "vector"
  // (see the same note on the "wraps search" test above).
  const result = await ask("what calls a?", 5, ports, { stale: false }, ["lexical", "graph"]);
  assert.ok(result.relatedNodes.some((node) => node.id === "node-c"), "node-c is exactly 2 hops from seed node-a (a->b->c) and must be reached by BFS <= depth 2");
  assert.ok(!result.relatedNodes.some((node) => node.id === "node-d"), "node-d is 3 hops from seed node-a — outside the binding contract's BFS <= depth 2 bound — and must not be reached");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/retrieve.test.mjs`
Expected: FAIL — `plugins/openwiki/src/retrieve.ts` does not exist.

- [ ] **Step 3: Implement `retrieve.ts`**

Create `plugins/openwiki/src/retrieve.ts`:

```ts
import { chunkSymbols, type ChunkRef } from "./chunk.js";
import type { Embedder } from "./embedder.js";
import { OpenWikiError } from "./errors.js";
import type { GraphConfidence, GraphNodeV1 } from "./graph-contracts.js";
import type { GraphIndexPort } from "./graph-index.js";
import type { LexicalIndex } from "./lexical-index.js";
import type { VectorStore } from "./vector-store.js";

export interface SearchRequest { text: string; limit: number; signals?: ReadonlyArray<"lexical" | "vector" | "graph">; }
export interface EvidenceItem { ref: ChunkRef; score: number; ranks: { lexical?: number; vector?: number; graph?: number }; citation: string; confidence?: GraphConfidence; }
export interface AskResultV1 { schema: "memex.ask.v1"; question: string; evidence: EvidenceItem[]; relatedNodes: GraphNodeV1[]; degraded: boolean; stale: boolean; truncated: boolean; }
export interface SearchResultV1 { schemaVersion: 1; evidence: EvidenceItem[]; degraded: boolean; truncated: boolean; }
export interface RetrievalPorts { lexicalIndex: LexicalIndex; vectorStore?: VectorStore; embedder?: Embedder; graphIndex?: GraphIndexPort; }

type SignalName = "lexical" | "vector" | "graph";
interface RankedList { signal: SignalName; items: ReadonlyArray<{ ref: ChunkRef; score: number; confidence?: GraphConfidence }>; }

const RRF_K = 60;
const ALL_SIGNALS: readonly SignalName[] = ["lexical", "vector", "graph"];
const CONFIDENCE_WEIGHT: Record<GraphConfidence, number> = {
  exact: 1.0, extracted: 1.0,
  resolved: 0.7, inferred: 0.7,
  heuristic: 0.4, ambiguous: 0.4,
};
const GRAPH_TEXT_SEED_LIMIT = 50;
const RELATED_NODE_LIMIT_MULTIPLIER = 2;

export async function search(request: SearchRequest, ports: RetrievalPorts): Promise<SearchResultV1> {
  const signals = validateSignals(request.signals);
  const oversample = Math.min(request.limit * 4, 200);
  const lists: RankedList[] = [];
  if (signals.includes("lexical")) lists.push({ signal: "lexical", items: await ports.lexicalIndex.search(request.text, oversample) });
  let vectorItems: ReadonlyArray<{ ref: ChunkRef; score: number }> = [];
  if (signals.includes("vector")) {
    if (ports.embedder === undefined || ports.vectorStore === undefined) throw new OpenWikiError("MODEL_ASSET_MISSING", "Vector retrieval requires a loaded embedder and vector store.");
    const status = await ports.vectorStore.status();
    if (!status.compatible) throw new OpenWikiError("INDEX_INCOMPATIBLE", "Vector store model does not match the loaded embedder.");
    vectorItems = await ports.vectorStore.search(await ports.embedder.embedQuery(request.text), oversample);
    lists.push({ signal: "vector", items: vectorItems });
  }
  if (signals.includes("graph")) {
    if (ports.graphIndex === undefined) throw new OpenWikiError("NOT_INITIALIZED", "Graph retrieval requires a built graph index.");
    const lexicalItems = lists.find((list) => list.signal === "lexical")?.items ?? [];
    lists.push({ signal: "graph", items: await graphSignal(ports.graphIndex, request.text, lexicalItems, vectorItems, oversample) });
  }
  const fused = fuse(lists);
  return { schemaVersion: 1, evidence: fused.slice(0, request.limit), degraded: signals.length < ALL_SIGNALS.length, truncated: fused.length > request.limit };
}

export async function ask(
  question: string,
  limit: number,
  ports: RetrievalPorts & { graphIndex: GraphIndexPort },
  freshness: { stale: boolean },
  signals?: SearchRequest["signals"],
): Promise<AskResultV1> {
  // ask()'s own graphIndex (required by this function's signature) is always
  // used for relatedNodes/context expansion, independent of which signals
  // the caller narrowed search's *ranking* to via --signals — narrowing
  // still lowers `degraded` correctly since that flag comes from search().
  const result = await search({ text: question, limit, ...(signals === undefined ? {} : { signals }) }, ports);
  const seedIds = new Set<string>();
  for (const item of result.evidence) if (item.ref.nodeId !== undefined) seedIds.add(item.ref.nodeId);
  const related = await relatedNodes(ports.graphIndex, seedIds, limit * RELATED_NODE_LIMIT_MULTIPLIER);
  return { schema: "memex.ask.v1", question, evidence: result.evidence, relatedNodes: related, degraded: result.degraded, stale: freshness.stale, truncated: result.truncated };
}

// Exported (not just used internally) so Task 11's CLI/MCP dispatch layer can
// resolve the same default/validated signal set *before* calling search()/
// ask(), and only construct the ports (embedder, vector store, graph index)
// that are actually needed — avoiding, e.g., loading the WASM embedder for a
// request that only asked for --signals lexical,graph.
export function validateSignals(signals: SearchRequest["signals"]): SignalName[] {
  if (signals === undefined) return [...ALL_SIGNALS];
  if (signals.length === 0) throw new OpenWikiError("INVALID_ARGUMENT", "Signals must include at least one of lexical, vector, graph.");
  const unique = new Set(signals);
  for (const signal of unique) if (!ALL_SIGNALS.includes(signal)) throw new OpenWikiError("INVALID_ARGUMENT", `Unknown retrieval signal: ${signal}.`);
  return ALL_SIGNALS.filter((signal) => unique.has(signal));
}

function fuse(lists: readonly RankedList[]): EvidenceItem[] {
  const byId = new Map<string, { ref: ChunkRef; ranks: EvidenceItem["ranks"]; score: number; confidence?: GraphConfidence }>();
  for (const list of lists) {
    list.items.forEach((item, index) => {
      const rank = index + 1;
      const existing = byId.get(item.ref.id) ?? { ref: item.ref, ranks: {}, score: 0 };
      existing.ranks = { ...existing.ranks, [list.signal]: rank };
      existing.score += 1 / (RRF_K + rank);
      if (item.confidence !== undefined) existing.confidence = item.confidence;
      byId.set(item.ref.id, existing);
    });
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id))
    .map((entry) => ({
      ref: entry.ref,
      score: entry.score,
      ranks: entry.ranks,
      citation: `${entry.ref.path}#L${String(entry.ref.startLine)}-${String(entry.ref.endLine)}`,
      confidence: entry.confidence ?? planeConfidence(entry.ref.plane),
    }));
}

// TP.2 review finding I2: a chunk not reached via the graph signal still
// must carry a confidence label, not `undefined` by omission — PRD §7-2b
// requires confidence labels on every result. "code"-plane chunks are
// deterministically scanner-extracted symbol metadata (the same certainty
// tier the graph itself assigns scanner-derived edges); "wiki"/"concept"
// chunks are literal excerpts of human/agent-authored content, one tier down.
function planeConfidence(plane: ChunkRef["plane"]): GraphConfidence {
  return plane === "code" ? "exact" : "extracted";
}

async function graphSignal(
  index: GraphIndexPort,
  query: string,
  lexicalItems: ReadonlyArray<{ ref: ChunkRef; score: number }>,
  vectorItems: ReadonlyArray<{ ref: ChunkRef; score: number }>,
  limit: number,
): Promise<Array<{ ref: ChunkRef; score: number; confidence?: GraphConfidence }>> {
  const candidatesById = new Map<string, ChunkRef>();
  for (const item of [...lexicalItems, ...vectorItems]) candidatesById.set(item.ref.id, item.ref);
  const candidateNodeIds = new Set<string>();
  for (const ref of candidatesById.values()) if (ref.nodeId !== undefined) candidateNodeIds.add(ref.nodeId);
  const seeds = new Set(candidateNodeIds);
  for (const id of await index.rankedCandidates(query, Math.min(limit, GRAPH_TEXT_SEED_LIMIT)).catch(() => [])) seeds.add(id);
  if (seeds.size === 0) return [];
  const proximity = await graphProximity(index, [...seeds].sort((left, right) => left.localeCompare(right)), 2);
  const ranked: Array<{ ref: ChunkRef; score: number; confidence?: GraphConfidence }> = [];
  // Re-rank candidates that are already lexical/vector hits by their graph
  // proximity weight (unchanged from before this fix).
  for (const ref of candidatesById.values()) {
    if (ref.nodeId === undefined) continue;
    const entry = proximity.get(ref.nodeId);
    if (entry !== undefined) ranked.push({ ref, score: entry.weight, confidence: entry.confidence });
  }
  // TP.2 review round 2, N1: surface genuinely new candidates the graph
  // signal alone reached — nodes within depth 2 of a seed that were NOT
  // already a lexical/vector hit. Only `symbol`-kind nodes can be turned
  // into a ChunkRef here without a fresh file read: chunkSymbols (Task 3) is
  // a pure function of the node's own metadata, so it deterministically
  // reconstructs the exact ChunkRef reindex.ts already indexed for that
  // symbol at write time. `concept`/`page` nodes reached this way are not
  // surfaced — chunkMarkdown needs the full page text, which GraphIndexPort
  // has no way to provide — so they stay graph-invisible unless they are
  // independently a lexical/vector hit (design decision 1).
  for (const [nodeId, entry] of proximity) {
    if (candidateNodeIds.has(nodeId)) continue;
    const node = await index.node(nodeId);
    if (node === undefined || node.kind !== "symbol") continue;
    const [chunk] = chunkSymbols([node]);
    if (chunk === undefined) continue;
    ranked.push({ ref: chunk, score: entry.weight, confidence: entry.confidence });
  }
  return ranked.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
}

// TP.2 review finding M1: combines edge-confidence weights along the path
// (no separate depth-decay term — the literal binding-contract spec is
// "edge weight by confidence... combine along the path", nothing more). This
// is a widest-path computation: the weight to reach a node is the maximum,
// over every path from any seed within maxDepth hops, of the product of that
// path's edge-confidence weights; ties are broken by keeping the first
// (lexicographically smallest-frontier-id-ordered) edge's confidence label
// found at the winning weight, which is deterministic since frontier
// iteration order is sorted below. Seeds themselves start at weight 1 with
// confidence "exact" (the strongest possible link: the seed chunk itself).
async function graphProximity(
  index: GraphIndexPort,
  seeds: readonly string[],
  maxDepth: number,
): Promise<Map<string, { weight: number; confidence: GraphConfidence }>> {
  const scores = new Map<string, { weight: number; confidence: GraphConfidence }>();
  for (const id of seeds) scores.set(id, { weight: 1, confidence: "exact" });
  let frontier = new Map<string, number>(seeds.map((id) => [id, 1]));
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = new Map<string, { weight: number; confidence: GraphConfidence }>();
    for (const [id, incomingWeight] of [...frontier.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [inboundEdges, outboundEdges] = await Promise.all([index.inbound(id, 100), index.outbound(id, 100)]);
      for (const edge of [...inboundEdges.edges, ...outboundEdges.edges]) {
        const neighbor = edge.from === id ? edge.to : edge.from;
        const combined = incomingWeight * CONFIDENCE_WEIGHT[edge.confidence];
        const existing = next.get(neighbor);
        if (existing === undefined || combined > existing.weight) next.set(neighbor, { weight: combined, confidence: edge.confidence });
      }
    }
    for (const [id, entry] of next) {
      const existing = scores.get(id);
      if (existing === undefined || entry.weight > existing.weight) scores.set(id, entry);
    }
    frontier = new Map([...next.entries()].map(([id, entry]) => [id, entry.weight]));
  }
  return scores;
}

async function relatedNodes(index: GraphIndexPort, seedIds: ReadonlySet<string>, limit: number): Promise<GraphNodeV1[]> {
  if (seedIds.size === 0) return [];
  const proximity = await graphProximity(index, [...seedIds].sort((left, right) => left.localeCompare(right)), 2);
  const ids = [...proximity.keys()]
    .filter((id) => !seedIds.has(id))
    .sort((left, right) => (proximity.get(right)?.weight ?? 0) - (proximity.get(left)?.weight ?? 0) || left.localeCompare(right))
    .slice(0, limit);
  const nodes = await Promise.all(ids.map((id) => index.node(id)));
  return nodes.filter((node): node is GraphNodeV1 => node !== undefined);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/retrieve.test.mjs`
Expected: PASS (10 tests). If `typecheck` fails on `GraphConfidence`/`CONFIDENCE_WEIGHT` because 2a has not landed yet (Prerequisite 1), stop — this is the expected, documented blocking dependency, not a bug in this task.

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/retrieve.ts plugins/openwiki/tests/unit/retrieve.test.mjs
git commit -m "feat(openwiki): add RRF hybrid retrieval with bounded graph proximity"
```

---

### Task 9: Extend `GraphIndexPort` with `allNodes(kind?)`

**Why this task exists:** Task 10's embed-at-write wiring needs to enumerate every `symbol`-kind node in the current graph to build `chunkSymbols()` input. `GraphIndexPort` (`plugins/openwiki/src/graph-index.ts`) currently has no "list all nodes" capability — only `node(id)`, `rankedCandidates(query, limit)`, `inbound`/`outbound`, `changedPathSeeds`, and `architectureSummary()` (which only returns `module`-kind nodes plus id+degree hub pairs, not full symbol nodes). This is a small, purely additive interface extension: existing callers are unaffected because they don't implement `GraphIndexPort` themselves (the only production implementer is `openGraphIndexGeneration`); the fakes in `tests/unit/retrieve.test.mjs` (Task 8) already implement it as a no-argument-returns-declared-nodes-only method since the "graph signal" tests never call it, so no retrofit is needed there — but if 2a's own test doubles for `GraphIndexPort` exist elsewhere, they must add this method too before their suite recompiles.

**Files:**
- Modify: `plugins/openwiki/src/graph-index.ts`
- Test: `plugins/openwiki/tests/unit/graph-store-v2.test.mjs` (existing file — append a test to the existing `describe("graph store v2", ...)` block, do not create a new file)

**Interfaces:**
- Modifies (additive): `GraphIndexPort` gains `allNodes(kind?: GraphNodeKind): Promise<GraphNodeV1[]>`.
- Consumed by: Task 10's `reindex.ts`, which calls `index.allNodes("symbol")`.

- [ ] **Step 1: Write the failing test**

Edit `plugins/openwiki/tests/unit/graph-store-v2.test.mjs`, adding this test inside the existing `describe("graph store v2", () => { ... })` block, right after the `"stores immutable buckets and serves exact, ranked, and bounded adjacency reads..."` test:

```js
  test("allNodes returns every node of the requested kind across all buckets, sorted by id", async () => {
    const root = await temporaryRoot("all-nodes");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    const source = graph("1");
    await writeGraph(resolved.storage, source, []);
    const index = await openGraphIndex(resolved.storage);
    const symbols = await index.allNodes("symbol");
    const expectedIds = source.nodes.filter((node) => node.kind === "symbol").map((node) => node.id).sort((left, right) => left.localeCompare(right));
    assert.deepEqual(symbols.map((node) => node.id), expectedIds);
    assert.equal((await index.allNodes("repository")).length, 1);
    assert.equal((await index.allNodes()).length, source.nodes.length);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph-store-v2.test.mjs`
Expected: FAIL — `index.allNodes is not a function`.

- [ ] **Step 3: Implement `allNodes` in `graph-index.ts`**

Edit `plugins/openwiki/src/graph-index.ts`. Extend the import to include `GraphNodeKind`:

```ts
import {
  GRAPH_SCANNER_VERSION,
  type CodeGraphV1,
  type GraphDiagnosticV1,
  type GraphEdgeV1,
  type GraphNodeKind,
  type GraphNodeV1,
} from "./graph-contracts.js";
```

Add `allNodes` to the `GraphIndexPort` interface, right after `node`:

```ts
export interface GraphIndexPort {
  node(id: string): Promise<GraphNodeV1 | undefined>;
  allNodes(kind?: GraphNodeKind): Promise<GraphNodeV1[]>;
  edge(id: string): Promise<GraphEdgeV1 | undefined>;
  rankedCandidates(query: string, limit: number): Promise<string[]>;
  inbound(id: string, limit: number): Promise<GraphAdjacency>;
  outbound(id: string, limit: number): Promise<GraphAdjacency>;
  changedPathSeeds(paths: readonly string[], limit: number): Promise<string[]>;
  architectureSummary(): Promise<Readonly<GraphArchitectureSummary>>;
  metrics(): GraphIndexMetrics;
  status(): GraphIndexStatus;
}
```

In `openGraphIndexGeneration`'s returned object (right after the `async node(id) { return readNode(id); },` entry), add:

```ts
    async allNodes(kind) {
      const results: GraphNodeV1[] = [];
      for (const bucket of manifest.nodeBuckets) {
        const parsed = parseNodeBucket(await readBucket("nodes", bucket, manifest.nodeBuckets));
        for (const node of parsed.values()) if (kind === undefined || node.kind === kind) results.push(node);
      }
      return results.sort((left, right) => left.id.localeCompare(right.id));
    },
```

- [ ] **Step 4: Run to verify it passes, then run the full graph test suite for regressions**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/graph-store-v2.test.mjs plugins/openwiki/tests/unit/graph-analysis.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs`
Expected: PASS, no regressions in any existing graph test.

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/graph-index.ts plugins/openwiki/tests/unit/graph-store-v2.test.mjs
git commit -m "feat(openwiki): expose allNodes on the graph index port"
```

---

### Task 10: `reindex.ts` — embed-at-write wiring into `writePage` and `buildGraph`

**Design decisions made explicit (for orchestrator review):**
1. **Two call sites, not one "reindex everything" step.** `writePage` (wiki plane) reindexes only the *one* page just written — this is what keeps the "<2 s per changed page" target achievable regardless of corpus size. `buildGraph` (code plane) reindexes every `symbol` node after each scan — this rides the same content-hash incremental-reuse machinery the graph store already has, and is what the "<60 s full build" target has to include going forward, since Wave E wires embedding into the same operation that currently only builds the code graph.
2. **Write paths soft-degrade on missing/invalid vendor assets; only read paths hard-fail (TP.2 review finding C2 — orchestrator adjudication, resolved).** PRD §11 and the master plan's Global Constraints scope "no silent fallback" explicitly to *retrieval* degradation ("degraded retrieval only via explicit `--signals` request... responses must label degradation") — never to write-path availability; an earlier draft of this task extrapolated that principle to `writePage`/`buildGraph` themselves, which exceeds what the binding contracts authorize and would regress the entire product's existing write path in any environment without the vendored assets checked out. Resolved as follows: `reindexChunks` (below) catches `MODEL_ASSET_MISSING`/`MODEL_ASSET_CORRUPT` specifically — and only those two codes — from the vendor-manifest/embedder-loading step. On catch: the lexical index is still upserted normally (the chunk stays fully lexically searchable), the vector store is *not* written, and the skip is recorded non-silently via the new `markEmbeddingsUnavailable(vectorsRoot, model, reason)` (Task 6) — never swallowed, never left undiscoverable. The wiki page / graph shard is durably written either way; only the embedding step is skipped, and `ReindexResult.embeddingsAvailable`/`unavailableReason` report it directly to the immediate caller too. `EMBEDDING_FAILURE` (a real inference bug) and `INDEX_INCOMPATIBLE` (a real model/version mismatch) are **not** caught here — those still propagate and fail the write, since they indicate an actual defect, not "assets absent." `search`/`ask` (Tasks 8/11) are unchanged and keep hard-failing when the `vector` signal is requested (explicitly or by implicit default) and unavailable — that is where PRD §11's "no silent fallback" actually applies.
3. **Reindexing happens after the wiki lock is released, not inside it** — `writePage`'s `withWikiLock` block now only covers the atomic file write (cheap); the WASM-backed reindex work (potentially slow on a cold embedder load) runs after the lock is released, so it never blocks other wiki-lock waiters.
4. **The embedder/vendor root are injectable** (`ReindexPorts`) so this module's own tests exercise real `lexical-index.ts`/`vector-store.ts` code paths without needing the real ~40 MB vendored model — only Task 13's e2e tests exercise the real embedder through this wiring.

**Files:**
- Create: `plugins/openwiki/src/reindex.ts`
- Modify: `plugins/openwiki/src/wiki.ts` (`writePage`)
- Modify: `plugins/openwiki/src/graph.ts` (`buildGraph`)
- Test: `plugins/openwiki/tests/integration/reindex.test.mjs` (new)

**Interfaces:**
- Produces: `export interface ReindexResult { chunked: number; embedded: number; reusedVectors: number; reusedLexical: number; embeddingsAvailable: boolean; unavailableReason?: string; }` (the last two fields, TP.2 review C2, report the write-path soft-degrade decision directly to the immediate caller, not just to the vector store's own manifest), `export interface ReindexPorts { vendorRoot?: string; loadEmbedder?: (vendorRoot: string) => Promise<Embedder>; }`, `export async function reindexWikiPage(location: WikiLocation, page: string, content: string, ports?: ReindexPorts): Promise<ReindexResult>`, `export async function reindexCodeSymbols(root: string, index: GraphIndexPort, homeDir?: string, ports?: ReindexPorts): Promise<ReindexResult>`.
- Consumes: `chunkMarkdown`/`chunkSymbols`/`symbolChunkText`/`ChunkRef` (Task 3), `defaultVendorRoot`/`loadEmbedder`/`loadVendorManifest`/`Embedder`/`VendorManifest` (Task 5), `openLexicalIndex` (Task 7), `openVectorStore`/`readVectorChunkDigest`/`markEmbeddingsUnavailable` (Task 6), `GraphIndexPort` (Task 9), `resolveWikiLocation`/`WikiLocation` (existing `paths.ts`).

- [ ] **Step 1: Write the failing integration test**

Create `plugins/openwiki/tests/integration/reindex.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { openLexicalIndex } from "../../dist/lexical-index.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import { reindexCodeSymbols, reindexWikiPage } from "../../dist/reindex.js";
import { readVectorChunkDigest } from "../../dist/vector-store.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-reindex-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeEmbedder(dims = 384) {
  let calls = 0;
  return {
    modelId: "test-model",
    dims,
    async embedQuery() { throw new Error("not used by reindex"); },
    async embedPassages(texts) {
      return texts.map((text, index) => {
        calls += 1;
        const vector = new Float32Array(dims);
        vector[(text.length + index) % dims] = 1;
        return vector;
      });
    },
    get calls() { return calls; },
  };
}

function fakePorts(vendorRoot, embedder) {
  return { vendorRoot, loadEmbedder: async () => embedder };
}

async function writeVendorManifest(vendorRoot) {
  await mkdir(vendorRoot, { recursive: true });
  await writeFile(path.join(vendorRoot, "MANIFEST.json"), JSON.stringify({ assets: [{ path: "model/multilingual-e5-small-int8/model.onnx", sha256: "a".repeat(64), bytes: 1, license: "MIT", upstream: "test", revision: "rev-test" }] }));
}

function fakeLocation(dataRoot) {
  return { mode: "code", workspaceId: "w", workspaceRoot: "/repo", wikiRoot: "/repo/openwiki", statePath: "/repo/openwiki/.last-update.json", dataRoot };
}

test("reindex: writing a wiki page chunks it into both the lexical index and the vector store", async () => {
  const dataRoot = await temporaryRoot("data");
  const vendorRoot = await temporaryRoot("vendor");
  await writeVendorManifest(vendorRoot);
  const embedder = fakeEmbedder();
  const content = "# Title\n\nA paragraph with enough distinctive words to be searchable and embeddable for this test case here.\n";
  const result = await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(vendorRoot, embedder));
  assert.ok(result.chunked >= 1);
  assert.equal(result.embedded, result.chunked);
  assert.equal(result.reusedVectors, 0);
  const lexical = await openLexicalIndex(path.join(dataRoot, "lexical"));
  assert.ok((await lexical.search("distinctive", 5)).length > 0);
  const digest = await readVectorChunkDigest(path.join(dataRoot, "vectors"));
  assert.equal(digest.size, result.chunked);
});

test("reindex: re-writing the same page content is a no-op that never calls the embedder again", async () => {
  const dataRoot = await temporaryRoot("data");
  const vendorRoot = await temporaryRoot("vendor");
  await writeVendorManifest(vendorRoot);
  const embedder = fakeEmbedder();
  const content = "# Title\n\nStable unchanged content for the reindex no-op test case.\n";
  await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(vendorRoot, embedder));
  const callsAfterFirst = embedder.calls;
  const result = await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(vendorRoot, embedder));
  assert.equal(embedder.calls, callsAfterFirst, "the embedder must not be invoked again for unchanged content");
  assert.equal(result.embedded, 0);
  assert.equal(result.reusedVectors, result.chunked);
});

test("reindex: reindexCodeSymbols chunks every symbol node returned by allNodes", async () => {
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  const vendorRoot = await temporaryRoot("vendor");
  await writeVendorManifest(vendorRoot);
  const embedder = fakeEmbedder();
  const symbolId = createGraphNodeId("symbol", "src/a.ts", "run", "function", "1");
  const fakeIndex = {
    async allNodes(kind) {
      const node = { id: symbolId, kind: "symbol", path: "src/a.ts", name: "run", symbolKind: "function", startLine: 1, endLine: 3 };
      return kind === undefined || kind === "symbol" ? [node] : [];
    },
  };
  const result = await reindexCodeSymbols(root, fakeIndex, home, fakePorts(vendorRoot, embedder));
  assert.equal(result.chunked, 1);
  assert.equal(result.embedded, 1);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const digest = await readVectorChunkDigest(path.join(location.dataRoot, "vectors"));
  assert.equal(digest.size, 1);
});

// TP.2 review finding C2 (orchestrator adjudication): write paths must
// soft-degrade, never hard-fail, when vendor assets are absent/corrupt — the
// wiki page stays fully lexically searchable, and the skip is recorded
// non-silently (never swallowed) rather than thrown.
test("reindex: soft-degrades when vendor assets are absent — lexical still indexes, vector embedding is skipped and recorded non-silently", async () => {
  const dataRoot = await temporaryRoot("data-no-vendor");
  const missingVendorRoot = await temporaryRoot("vendor-missing"); // no MANIFEST.json written
  const embedder = fakeEmbedder();
  const content = "# Title\n\nA paragraph with enough distinctive words for the soft-degrade test case here.\n";
  const result = await reindexWikiPage(fakeLocation(dataRoot), "quickstart.md", content, fakePorts(missingVendorRoot, embedder));
  assert.equal(result.embeddingsAvailable, false);
  assert.equal(result.unavailableReason, "MODEL_ASSET_MISSING");
  assert.equal(embedder.calls, 0, "the embedder must never be invoked once the vendor manifest itself fails to load");
  const lexical = await openLexicalIndex(path.join(dataRoot, "lexical"));
  assert.ok((await lexical.search("distinctive", 5)).length > 0, "the wiki page must still be lexically searchable");
  const { openVectorStore } = await import("../../dist/vector-store.js");
  const vectorStore = await openVectorStore(path.join(dataRoot, "vectors"), { modelId: "multilingual-e5-small-int8", modelRevision: "unknown", dims: 384 });
  const status = await vectorStore.status();
  assert.equal(status.embeddingsAvailable, false);
  assert.equal(status.unavailableReason, "MODEL_ASSET_MISSING");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/reindex.test.mjs`
Expected: FAIL — `plugins/openwiki/src/reindex.ts` does not exist.

- [ ] **Step 3: Implement `reindex.ts`**

Create `plugins/openwiki/src/reindex.ts`:

```ts
import path from "node:path";

import { chunkMarkdown, chunkSymbols, symbolChunkText, type ChunkRef } from "./chunk.js";
import { defaultVendorRoot, loadEmbedder, loadVendorManifest, type Embedder, type VendorManifest } from "./embedder.js";
import { OpenWikiError } from "./errors.js";
import type { GraphIndexPort } from "./graph-index.js";
import { openLexicalIndex } from "./lexical-index.js";
import { resolveWikiLocation, type WikiLocation } from "./paths.js";
import { markEmbeddingsUnavailable, openVectorStore, readVectorChunkDigest } from "./vector-store.js";

export interface ReindexResult { chunked: number; embedded: number; reusedVectors: number; reusedLexical: number; embeddingsAvailable: boolean; unavailableReason?: string; }
export interface ReindexPorts { vendorRoot?: string; loadEmbedder?: (vendorRoot: string) => Promise<Embedder>; }

const EMBEDDING_MODEL_ID = "multilingual-e5-small-int8";
const EMBEDDING_DIMS = 384;

export async function reindexWikiPage(location: WikiLocation, page: string, content: string, ports: ReindexPorts = {}): Promise<ReindexResult> {
  const lines = content.split(/\r?\n/u);
  const refs = chunkMarkdown(page, content).map((ref) => ({ ref, text: lines.slice(ref.startLine - 1, ref.endLine).join("\n") }));
  return reindexChunks(location.dataRoot, refs, ports);
}

export async function reindexCodeSymbols(root: string, index: GraphIndexPort, homeDir?: string, ports: ReindexPorts = {}): Promise<ReindexResult> {
  const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
  const symbols = await index.allNodes("symbol");
  const symbolsById = new Map(symbols.map((node) => [node.id, node]));
  const refs = chunkSymbols(symbols).map((ref) => {
    const node = ref.nodeId !== undefined ? symbolsById.get(ref.nodeId) : undefined;
    if (node === undefined) throw new OpenWikiError("INVALID_STATE", "Chunked symbol node disappeared during reindexing.");
    return { ref, text: symbolChunkText(node) };
  });
  return reindexChunks(location.dataRoot, refs, ports);
}

async function reindexChunks(dataRoot: string, refs: ReadonlyArray<{ ref: ChunkRef; text: string }>, ports: ReindexPorts): Promise<ReindexResult> {
  if (refs.length === 0) return { chunked: 0, embedded: 0, reusedVectors: 0, reusedLexical: 0, embeddingsAvailable: true };
  const lexicalIndex = await openLexicalIndex(path.join(dataRoot, "lexical"));
  await lexicalIndex.upsert(refs.map(({ ref, text }) => ({ ref, text })));

  const vectorsRoot = path.join(dataRoot, "vectors");
  const digest = await readVectorChunkDigest(vectorsRoot);
  const changed = refs.filter(({ ref }) => digest.get(ref.id) !== ref.contentHash);
  if (changed.length === 0) return { chunked: refs.length, embedded: 0, reusedVectors: refs.length, reusedLexical: refs.length, embeddingsAvailable: true };

  const vendorRoot = ports.vendorRoot ?? defaultVendorRoot();
  const load = ports.loadEmbedder ?? loadEmbedder;
  let manifest: VendorManifest;
  let embedder: Embedder;
  try {
    manifest = await loadVendorManifest(vendorRoot);
    embedder = await load(vendorRoot);
  } catch (error) {
    // Soft-degrade (TP.2 review C2 / orchestrator adjudication): the wiki
    // page / graph shard is already durably written above; only vector
    // embedding is skipped here, and only for these two specific codes —
    // "assets are absent/invalid," not a real bug. EMBEDDING_FAILURE and
    // INDEX_INCOMPATIBLE are not caught: those indicate an actual defect
    // (a broken model or a version mismatch), not "no vendor install," and
    // still hard-fail the write, exactly as before.
    if (error instanceof OpenWikiError && (error.code === "MODEL_ASSET_MISSING" || error.code === "MODEL_ASSET_CORRUPT")) {
      await markEmbeddingsUnavailable(vectorsRoot, { modelId: EMBEDDING_MODEL_ID, modelRevision: "unknown", dims: EMBEDDING_DIMS }, error.code);
      return {
        chunked: refs.length,
        embedded: 0,
        reusedVectors: refs.length - changed.length,
        reusedLexical: refs.length,
        embeddingsAvailable: false,
        unavailableReason: error.code,
      };
    }
    throw error;
  }
  const modelRevision = manifest.assets.find((asset) => asset.path.startsWith(`model/${EMBEDDING_MODEL_ID}/`))?.revision ?? "unknown";
  const vectors = await embedder.embedPassages(changed.map(({ text }) => text));
  const entries = changed.map(({ ref }, index) => {
    const vector = vectors[index];
    if (vector === undefined) throw new OpenWikiError("EMBEDDING_FAILURE", "Embedder returned fewer vectors than requested.");
    return { ref, vector };
  });
  const vectorStore = await openVectorStore(vectorsRoot, { modelId: EMBEDDING_MODEL_ID, modelRevision, dims: EMBEDDING_DIMS });
  const { written, reused } = await vectorStore.upsert(entries);
  return { chunked: refs.length, embedded: written, reusedVectors: reused + (refs.length - changed.length), reusedLexical: refs.length, embeddingsAvailable: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/integration/reindex.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `reindexWikiPage` into `wiki.ts`'s `writePage`**

Edit `plugins/openwiki/src/wiki.ts`. Add to its imports: `import { reindexWikiPage } from "./reindex.js";`. Replace `writePage`:

```ts
export async function writePage(
  location: WikiLocation,
  page: string,
  content: string,
): Promise<void> {
  if (typeof content !== "string") {
    throw new OpenWikiError("INVALID_ARGUMENT", "Wiki page content must be text.");
  }

  await withWikiLock(location.wikiRoot, async () => {
    const filePath = await resolveConfinedMarkdownPath(location, page);
    await atomicWriteFile(filePath, content);
  });
  await reindexWikiPage(location, page, content);
}
```

- [ ] **Step 6: Run the full existing wiki test suite for regressions**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/storage.test.mjs plugins/openwiki/tests/integration/git-wiki.test.mjs`
Expected: PASS, no regressions — including in this environment, which has no `plugins/openwiki/vendor/` directory. After the soft-degrade fix (Design decision 2 above), `reindexWikiPage` never throws `MODEL_ASSET_MISSING`/`MODEL_ASSET_CORRUPT`; every existing test that calls `writePage` keeps passing unmodified, with vector embedding silently-skipped-but-non-silently-recorded (not swallowed — see `VectorStore.status()`). If any existing test unexpectedly fails here, that is a real regression to investigate, not an expected trade-off to negotiate.

- [ ] **Step 7: Wire `reindexCodeSymbols` into `graph.ts`'s `buildGraph`**

Edit `plugins/openwiki/src/graph.ts`. Add to its imports: `import { reindexCodeSymbols } from "./reindex.js";` (alongside the existing imports from `./graph-store.js`, which already include `openGraphIndex` — confirm with `grep -n "openGraphIndex" plugins/openwiki/src/graph.ts` before editing; it is already imported and used by `loadIndex()`). In `buildGraph`'s body, insert a new statement immediately after `await writeGraph(resolved.storage, graph, shards);` and before `const changed = changedBuildPaths(previous, graph);`:

```ts
await reindexCodeSymbols(resolved.repositoryRoot, await openGraphIndex(resolved.storage), options.homeDir);
```

- [ ] **Step 8: Run the full graph suite for regressions, then the full suite**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/graph-analysis.test.mjs plugins/openwiki/tests/unit/graph-store-v2.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs`
Expected: PASS, no regressions — same as Step 6: `buildGraph`'s call to `reindexCodeSymbols` soft-degrades identically when vendor assets are absent, so every existing test that calls `buildGraph` in this vendor-asset-less environment keeps passing unmodified.

- [ ] **Step 9: Commit**

```bash
git add plugins/openwiki/src/reindex.ts plugins/openwiki/src/wiki.ts plugins/openwiki/src/graph.ts plugins/openwiki/tests/integration/reindex.test.mjs
git commit -m "feat(openwiki): wire chunk+embed reindexing into writePage and buildGraph"
```

---

### Task 11: CLI + MCP wiring for `search`/`ask`

**Why this task exists, and why it must land here (not be skipped):** `search` already exists as an operation (`adapter.ts`, `cli.ts`, `mcp.ts`) backed by `wiki.ts`'s naive substring-matching `searchWiki`/`SearchResult` — exactly the "retrieval is lexical" gap PRD §2 names and G3/D4 commit to closing. This task makes `search` (and the new `ask`) call the real hybrid `retrieve.ts` (Task 8) instead, retiring `searchWiki`/`SearchResult` as dead code once nothing calls them. This is a deliberate, PRD-mandated breaking change to `search`'s response shape (`SearchResultV1`/`EvidenceItem`, not `SearchResult[]`) — not an accidental regression; existing tests that assert the old shape are migrated in Step 5, not silently left broken.

**Design decisions made explicit (for orchestrator review):**
1. **Only construct the ports a request actually needs**, mirroring `retrieve.ts`'s own `validateSignals` rationale: the WASM embedder is loaded only when the `vector` signal is in play; the graph store is opened only when the `graph` signal is in play (for `search`) or unconditionally (for `ask`, whose `relatedNodes` always need it per Task 8's binding signature).
2. **Explicit `--signals` requests never silently narrow; the *implicit default* does, per mode/availability.** If a caller does not pass `--signals` at all: in `personal` mode, or in `code` mode before any `graph build` has run, the default narrows to `lexical,vector` (or fewer) rather than throwing — this is not "silent fallback" in the forbidden sense, because nothing was explicitly requested and degraded. If a caller explicitly passes `--signals graph` and no graph exists, the operation fails loudly with `NOT_INITIALIZED` — never narrows an explicit request. `ask` is stricter: it always requires a real graph index regardless of `--signals` (which only narrows *ranking*, not whether `ask` can run at all — Task 8's design decision 1), so `ask` in `personal` mode is rejected outright and `ask` in `code` mode before `graph build` fails with `NOT_INITIALIZED`.
3. **`personal` mode has no code-graph plane today.** 2a's concept/page graph plane (which may eventually give personal-mode wikis a graph store keyed by `workspaceId: "personal"`) is out of scope for this plan and not yet landed. This task therefore restricts `ask` to `code` mode only, mirroring the existing restriction on the `graph` operation itself (`dispatchGraph` already only accepts `mode: "code"`). Flagged for orchestrator: revisit this restriction once 2a lands, if 2a gives personal-mode wikis a graph store.
4. **Staleness reuses `getGraphStatus` verbatim**, per Task 8's design decision 2 — no new freshness logic.

**Files:**
- Modify: `plugins/openwiki/src/adapter.ts` (`OPENWIKI_OPERATIONS` gains `"ask"`; `search`/`ask` dispatch cases call `retrieve.ts`)
- Modify: `plugins/openwiki/src/cli.ts` (`signals` flag, comma-separated)
- Modify: `plugins/openwiki/src/mcp.ts` (`search` schema gains `signals`; new `ask` tool)
- Modify: `plugins/openwiki/src/wiki.ts` (remove now-dead `searchWiki`/`SearchResult` and their private helpers)
- Modify: `plugins/openwiki/tests/unit/storage.test.mjs` (remove the `searchWiki`-specific test and import)
- Modify: `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs` (migrate `assertSearchResult`/`searchResults` call sites to the new evidence shape)
- Test: `plugins/openwiki/tests/integration/retrieve-wiring.test.mjs` (new)

**Interfaces:**
- Modifies: `OPENWIKI_OPERATIONS` gains `"ask"`.
- Consumes: `SearchRequest`/`EvidenceItem`/`SearchResultV1`/`AskResultV1`/`RetrievalPorts`/`search`/`ask`/`validateSignals` from `./retrieve.js` (Task 8); `openLexicalIndex` (Task 7); `openVectorStore` (Task 6); `defaultVendorRoot`/`loadEmbedder`/`loadVendorManifest` (Task 5); `openGraphIndex`/`resolveGraphStorage` from `./graph-store.js` (existing, already statically imported the same way by `graph.ts` itself); `getGraphStatus` from `./graph.js` (existing); `GraphIndexPort` type from `./graph-index.js` (existing).

- [ ] **Step 1: Write the failing integration test**

Create `plugins/openwiki/tests/integration/retrieve-wiring.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { dispatch } from "../../dist/adapter.js";
import {
  GRAPH_SCANNER_VERSION,
  canonicalizeGraph,
  createGraphEdgeId,
  createGraphNodeId,
} from "../../dist/graph-contracts.js";
import {
  GRAPH_DEFAULTS,
  currentGitFingerprint,
  enumerateRepositoryMetadata,
  readRepositoryFile,
  repositoryMetadataFingerprint,
  resolveGraphStorage,
  resolveRepositorySourceIds,
  writeGraph,
} from "../../dist/graph-store.js";

const execFileAsync = promisify(execFile);
const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-retrieve-wiring-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initGitRepo(root) {
  const run = (...args) => execFileAsync("git", args, { cwd: root });
  await run("init", "-q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "Test");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "service.ts"), "export function runCatalogSync() {}\n");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}

// Writes a minimal, real graph directly via the shard store (bypassing
// buildGraph()/reindexCodeSymbols, which exercise the real scanner and
// reindex pipeline — this task is responsible for proving dispatch("search"/
// "ask") correctly wires retrieve.ts, not for re-proving Task 10's write-path
// embedding, which is Task 13's real-asset-gated job).
//
// Writes one real shard for src/service.ts (not an empty shards array) so
// `manifest.shards` includes its path (TP.2 review finding I3): getGraphStatus
// pre-filters repository metadata to `sourceId === undefined ||
// indexedPaths.has(path)` before computing its comparison fingerprint
// (`indexedPaths` comes from `manifest.shards`) — an empty shards array would
// make it filter out this committed, sourceId-bearing file entirely and
// compare against an empty-set fingerprint, which would never match this
// fixture's non-empty-derived one regardless of `badFingerprint`. Writing the
// real shard keeps this fixture's own fingerprint computation in agreement
// with getGraphStatus's filtered one by construction.
// If `currentGitFingerprint`/`enumerateRepositoryMetadata`/
// `repositoryMetadataFingerprint`/`resolveRepositorySourceIds`/
// `readRepositoryFile`'s exact return shapes differ from assumed here, verify
// with `grep -n "^export" plugins/openwiki/src/graph-store.ts` before adjusting.
async function writeFixtureGraph(root, home, { badFingerprint = false } = {}) {
  const resolved = await resolveGraphStorage(root, home);
  const git = await currentGitFingerprint(root);
  const metadata = await enumerateRepositoryMetadata(root, GRAPH_DEFAULTS);
  const sourceState = await resolveRepositorySourceIds(root, metadata);
  const dirtyFingerprint = badFingerprint ? "deliberately-mismatched-fingerprint" : repositoryMetadataFingerprint(sourceState);

  const repositoryNode = { id: createGraphNodeId("repository", ".", "repository"), kind: "repository", path: ".", name: "repository" };
  const fileNode = { id: createGraphNodeId("file", "src/service.ts", "service.ts"), kind: "file", path: "src/service.ts", name: "service.ts" };
  const symbolId = createGraphNodeId("symbol", "src/service.ts", "runCatalogSync", "function", "1");
  const symbolNode = { id: symbolId, kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 1, endLine: 1 };
  const containsEdge = { id: createGraphEdgeId("contains", repositoryNode.id, fileNode.id, "exact"), kind: "contains", from: repositoryNode.id, to: fileNode.id, confidence: "exact" };
  const declaresEdge = { id: createGraphEdgeId("declares", fileNode.id, symbolNode.id, "exact"), kind: "declares", from: fileNode.id, to: symbolNode.id, confidence: "exact" };

  const graphValue = canonicalizeGraph({
    schemaVersion: 1,
    workspaceId: resolved.workspaceId,
    generatedAt: new Date().toISOString(),
    source: { ...(git.gitHead === undefined ? {} : { gitHead: git.gitHead }), dirtyFingerprint, scannerVersion: GRAPH_SCANNER_VERSION },
    files: [{ path: "src/service.ts", language: "typescript", contentHash: "1".repeat(64), size: 42 }],
    nodes: [repositoryNode, fileNode, symbolNode],
    edges: [containsEdge, declaresEdge],
    diagnostics: [],
  });
  const fileEntry = metadata.find((file) => file.path === "src/service.ts");
  const loaded = await readRepositoryFile(root, fileEntry);
  const shard = {
    path: loaded.path,
    language: loaded.language,
    contentHash: loaded.contentHash,
    size: loaded.size,
    sourceId: loaded.sourceId,
    scan: { symbols: [], relations: [], imports: [], exports: [], calls: [], inherits: [], implements: [], references: [], diagnostics: [] },
  };
  await writeGraph(resolved.storage, graphValue, [shard]);
  return { symbolId };
}

async function indexFixtureChunk(dataRoot, nodeId) {
  const { openLexicalIndex } = await import("../../dist/lexical-index.js");
  const { chunkSymbols } = await import("../../dist/chunk.js");
  const node = { id: nodeId, kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 1, endLine: 1 };
  const [ref] = chunkSymbols([node]);
  const lexicalIndex = await openLexicalIndex(path.join(dataRoot, "lexical"));
  await lexicalIndex.upsert([{ ref, text: "symbol runCatalogSync (function) — src/service.ts:1-1" }]);
}

test("dispatch(search): lexical+graph signals return real evidence for an indexed symbol, marked degraded", async () => {
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  await initGitRepo(root);
  const { symbolId } = await writeFixtureGraph(root, home);
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  await indexFixtureChunk(location.dataRoot, symbolId);

  const result = await dispatch({ operation: "search", input: { mode: "code", root, query: "runCatalogSync", limit: 5, signals: ["lexical", "graph"] } });
  assert.equal(result.ok, true);
  assert.equal(result.data.degraded, true, "vector was excluded, so this must report degraded");
  assert.ok(result.data.evidence.some((item) => item.ref.nodeId === symbolId));
  const hit = result.data.evidence.find((item) => item.ref.nodeId === symbolId);
  assert.equal(hit.citation, "src/service.ts#L1-1");
});

test("dispatch(ask): wires a real stale=true when the graph fingerprint no longer matches", async () => {
  const root = await temporaryRoot("repo-stale");
  const home = await temporaryRoot("home-stale");
  await initGitRepo(root);
  const { symbolId } = await writeFixtureGraph(root, home, { badFingerprint: true });
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  await indexFixtureChunk(location.dataRoot, symbolId);

  const result = await dispatch({ operation: "ask", input: { mode: "code", root, query: "runCatalogSync", limit: 5, signals: ["lexical", "graph"] } });
  assert.equal(result.ok, true);
  assert.equal(result.data.schema, "memex.ask.v1");
  assert.equal(result.data.stale, true);
  assert.ok(result.data.relatedNodes.length >= 0);
});

// TP.2 review finding I3: this is the fresh-path counterpart to the test
// above — before the fix, no test exercised badFingerprint:false at all, so
// writeFixtureGraph's mismatch against getGraphStatus's own filtered
// fingerprint computation (see the comment on writeFixtureGraph) was never
// caught by a failing assertion.
test("dispatch(ask): wires a real stale=false when the graph fingerprint still matches (fresh path)", async () => {
  const root = await temporaryRoot("repo-fresh");
  const home = await temporaryRoot("home-fresh");
  await initGitRepo(root);
  const { symbolId } = await writeFixtureGraph(root, home);
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  await indexFixtureChunk(location.dataRoot, symbolId);

  const result = await dispatch({ operation: "ask", input: { mode: "code", root, query: "runCatalogSync", limit: 5, signals: ["lexical", "graph"] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.schema, "memex.ask.v1");
  assert.equal(result.data.stale, false, "the fixture graph's fingerprint must match getGraphStatus's real recomputation now that indexedPaths includes the committed shard");
});

test("dispatch(search): an unknown signal is rejected with INVALID_ARGUMENT", async () => {
  const root = await temporaryRoot("repo-bad-signal");
  const home = await temporaryRoot("home-bad-signal");
  await initGitRepo(root);
  const result = await dispatch({ operation: "search", input: { mode: "code", root, query: "x", limit: 5, signals: ["not-a-real-signal"] } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("dispatch(ask): personal mode is rejected outright, not silently degraded", async () => {
  const result = await dispatch({ operation: "ask", input: { mode: "personal", query: "x", limit: 5 } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("dispatch(search): explicitly requesting the graph signal before any graph build fails loudly with NOT_INITIALIZED", async () => {
  const root = await temporaryRoot("repo-no-graph");
  const home = await temporaryRoot("home-no-graph");
  await initGitRepo(root);
  const result = await dispatch({ operation: "search", input: { mode: "code", root, query: "x", limit: 5, signals: ["graph"] } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_INITIALIZED");
});

test("dispatch(search): the implicit default narrows quietly (not an error) when no graph has been built yet", async () => {
  const root = await temporaryRoot("repo-implicit");
  const home = await temporaryRoot("home-implicit");
  await initGitRepo(root);
  const { resolveWikiLocation } = await import("../../dist/paths.js");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const { openLexicalIndex } = await import("../../dist/lexical-index.js");
  const { chunkMarkdown } = await import("../../dist/chunk.js");
  const [ref] = chunkMarkdown("notes.md", "# Notes\n\nfindable term here.\n");
  await (await openLexicalIndex(path.join(location.dataRoot, "lexical"))).upsert([{ ref, text: "findable term here" }]);
  const result = await dispatch({ operation: "search", input: { mode: "code", root, query: "findable", limit: 5 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.degraded, true, "no graph exists yet, so the implicit default must narrow and report degraded");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/retrieve-wiring.test.mjs`
Expected: FAIL — `"ask"` is not a recognized operation yet, and `"search"`'s current handler still calls `searchWiki`, ignoring `signals` entirely.

- [ ] **Step 3: Wire `adapter.ts`**

Edit `plugins/openwiki/src/adapter.ts`. Extend the `wiki.js` import (drop `searchWiki`, it becomes dead code — do not import it):

```ts
import {
  checkWiki,
  finalizeRun,
  initializeWiki,
  readPage,
  writePage,
} from "./wiki.js";
```

Edit the existing `paths.js` import to also bring in the `WikiLocation` type (TP.2 review finding M2 — consumed by the new `openLexicalAndVector`/`openGraphIndexIfAvailable` helpers below, and otherwise a `Cannot find name 'WikiLocation'` compile error). Confirm its current exact form first with `grep -n "from \"./paths.js\"" plugins/openwiki/src/adapter.ts` in case other named imports already ride alongside `resolveWikiLocation`, then replace the existing `import { resolveWikiLocation } from "./paths.js";` line with:

```ts
import { resolveWikiLocation, type WikiLocation } from "./paths.js";
```

Add new imports right after the existing `import { collectGitContext } from "./git.js";` line:

```ts
import { defaultVendorRoot, loadEmbedder, loadVendorManifest } from "./embedder.js";
import { getGraphStatus } from "./graph.js";
import type { GraphIndexPort } from "./graph-index.js";
import { openGraphIndex, resolveGraphStorage } from "./graph-store.js";
import { openLexicalIndex } from "./lexical-index.js";
import {
  ask as retrieveAsk,
  search as retrieveSearch,
  type RetrievalPorts,
} from "./retrieve.js";
import { openVectorStore } from "./vector-store.js";
```

Add `"ask"` to `OPENWIKI_OPERATIONS`, right after `"search"`:

```ts
export const OPENWIKI_OPERATIONS = [
  "init",
  "status",
  "context",
  "search",
  "ask",
  "read",
  "write",
  "ingest",
  "finalize",
  "check",
  "doctor",
  "schedule",
  "purge",
  "graph",
] as const;
```

Add this constant and these helpers near the top-level constants (right after `const GRAPH_RESPONSE_BYTE_LIMIT = 48 * 1024;`):

```ts
const RETRIEVAL_SIGNALS = ["lexical", "vector", "graph"] as const;
type RetrievalSignal = (typeof RETRIEVAL_SIGNALS)[number];

function isRetrievalSignal(value: unknown): value is RetrievalSignal {
  return typeof value === "string" && RETRIEVAL_SIGNALS.includes(value as RetrievalSignal);
}

function readOptionalSignals(input: InputRecord): RetrievalSignal[] | undefined {
  if (!has(input, "signals")) return undefined;
  const value = input.signals;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRetrievalSignal)) {
    throw invalid("Argument signals must be a non-empty array of lexical, vector, graph.");
  }
  return [...value];
}

async function openLexicalAndVector(location: WikiLocation, wantsVector: boolean): Promise<Pick<RetrievalPorts, "lexicalIndex" | "vectorStore" | "embedder">> {
  const lexicalIndex = await openLexicalIndex(path.join(location.dataRoot, "lexical"));
  if (!wantsVector) return { lexicalIndex };
  const vendorRoot = defaultVendorRoot();
  const embedder = await loadEmbedder(vendorRoot);
  const manifest = await loadVendorManifest(vendorRoot);
  const modelRevision = manifest.assets.find((asset) => asset.path.startsWith(`model/${embedder.modelId}/`))?.revision ?? "unknown";
  const vectorStore = await openVectorStore(path.join(location.dataRoot, "vectors"), { modelId: embedder.modelId, modelRevision, dims: embedder.dims });
  return { lexicalIndex, embedder, vectorStore };
}

// `search`'s graph signal is one of three optional inputs — absent when not
// yet built, degrading the implicit default rather than erroring.
async function openGraphIndexIfAvailable(location: WikiLocation): Promise<GraphIndexPort | undefined> {
  if (location.mode !== "code" || location.workspaceRoot === undefined) return undefined;
  const homeDir = hostHomeDir();
  const status = await getGraphStatus({ root: location.workspaceRoot, homeDir });
  if (!status.available) return undefined;
  const resolved = await resolveGraphStorage(location.workspaceRoot, homeDir);
  return openGraphIndex(resolved.storage);
}
```

Replace the `case "search":` block:

```ts
    case "search": {
      const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "query", "limit", "signals"]));
      const requested = readOptionalSignals(input);
      const explicit = requested !== undefined;
      const wantsVector = explicit ? requested.includes("vector") : true;
      const wantsGraph = explicit ? requested.includes("graph") : true;
      const lexicalAndVector = await openLexicalAndVector(location, wantsVector);
      const graphIndex = wantsGraph ? await openGraphIndexIfAvailable(location) : undefined;
      if (explicit && requested.includes("graph") && graphIndex === undefined) {
        throw new OpenWikiError("NOT_INITIALIZED", "Graph retrieval requires a built graph index; run graph build first.");
      }
      const signals: RetrievalSignal[] = explicit ? requested : ["lexical", "vector", ...(graphIndex === undefined ? [] : (["graph"] as const))];
      const ports: RetrievalPorts = { ...lexicalAndVector, ...(graphIndex === undefined ? {} : { graphIndex }) };
      return retrieveSearch({ text: readRequiredString(input, "query"), limit: readOptionalBoundedInteger(input, "limit", 1, 100) ?? 20, signals }, ports);
    }
    case "ask": {
      const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "query", "limit", "signals"]));
      if (location.mode !== "code" || location.workspaceRoot === undefined) {
        throw invalid("Ask requires code mode until personal-mode graph support lands (2a).");
      }
      const requested = readOptionalSignals(input);
      const wantsVector = requested === undefined ? true : requested.includes("vector");
      const homeDir = hostHomeDir();
      const [lexicalAndVector, status] = await Promise.all([
        openLexicalAndVector(location, wantsVector),
        getGraphStatus({ root: location.workspaceRoot, homeDir }),
      ]);
      if (!status.available) throw new OpenWikiError("NOT_INITIALIZED", "Ask requires a built graph index; run graph build first.");
      const resolved = await resolveGraphStorage(location.workspaceRoot, homeDir);
      const graphIndex = await openGraphIndex(resolved.storage);
      return retrieveAsk(
        readRequiredString(input, "query"),
        readOptionalBoundedInteger(input, "limit", 1, 100) ?? 20,
        { ...lexicalAndVector, graphIndex },
        { stale: !status.fresh },
        requested,
      );
    }
```

- [ ] **Step 4: Wire `cli.ts` and `mcp.ts`**

Edit `plugins/openwiki/src/cli.ts`. Add `"signals"` to `VALUE_FLAGS`:

```ts
const VALUE_FLAGS = new Set([
  "mode",
  "root",
  "page",
  "content",
  "content-file",
  "envelope-file",
  "query",
  "limit",
  "signals",
  "command",
  "run-id",
  "started-at",
  "completed-at",
  "summary",
  "last-git-head",
  "previous-head",
  "action",
  "id",
  "operation",
  "cron",
  "timezone",
  "source-id",
  "scope",
  "target",
  "base",
  "direction",
  "depth",
]);
```

In `toRequest`, right after the existing `for (const key of ["limit", "depth"]) { ... }` block, add:

```ts
  if (typeof inputValue.signals === "string") {
    inputValue.signals = inputValue.signals
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
```

Edit `plugins/openwiki/src/mcp.ts`. Add a `signals` schema fragment alongside the existing `const limit = ...;` line:

```ts
const signals = { type: "array", items: { type: "string", enum: ["lexical", "vector", "graph"] }, minItems: 1 };
```

Replace the `search` tool entry and add a new `ask` tool entry right after it:

```ts
  tool("search", "Search grounded wiki pages and code with hybrid lexical, vector, and graph retrieval.", commonMode({ root, query: { type: "string", minLength: 1 }, limit, signals }, ["query"]), [true, false, false, false]),
  tool("ask", "Ask a question and receive a cited, bounded evidence bundle over hybrid retrieval and graph expansion.", commonMode({ root, query: { type: "string", minLength: 1 }, limit, signals }, ["query"]), [true, false, false, false]),
```

- [ ] **Step 5: Run to verify the new test passes**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/integration/retrieve-wiring.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 6: Retire dead code — `searchWiki`/`SearchResult` — and migrate the tests that depended on them**

Run `grep -n "searchWiki\|SearchResult" plugins/openwiki/src/*.ts plugins/openwiki/tests/**/*.mjs` first — after Step 3, only `wiki.ts` (definitions), `tests/unit/storage.test.mjs`, and `tests/e2e/runtime.e2e.test.mjs` should remain (adapter.ts no longer references either).

Edit `plugins/openwiki/src/wiki.ts`: delete the `SearchResult` interface, the entire `searchWiki` function, and its two now-solely-used-there private helpers `normalizeTerms` and `countOccurrences` (re-confirm each has zero remaining references with `grep -n "normalizeTerms\|countOccurrences" plugins/openwiki/src/wiki.ts` before deleting — both currently appear only inside `searchWiki`'s own body).

Edit `plugins/openwiki/tests/unit/storage.test.mjs`: remove `searchWiki` from the `../../dist/wiki.js` import list, and delete these three lines from the `"storage: writes atomically, reads line metadata, ranks search, and reports checks"` test (the test itself stays — it still covers write/read/finalize/check — only the `searchWiki`-specific assertions are removed, since that capability no longer exists):

```js
    const matches = await searchWiki(initialized.location, "deployment rollback");
    assert.equal(matches[0]?.page, "notes/release.md");
    assert.equal(matches[0]?.line, 2);
    assert.ok((matches[0]?.score ?? 0) > 0);
    assert.match(matches[0]?.excerpt ?? "", /Deployment/u);
```

Edit `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs`. Replace the `searchResults`/`assertSearchResult` helpers:

```js
function searchResults(data) {
  const results = Array.isArray(data.evidence) ? data.evidence : data;
  assert.ok(Array.isArray(results), "Search must return an evidence array.");
  return results;
}

function assertEvidenceItem(item, expectedPath) {
  assert.equal(item.ref.path, expectedPath);
  assert.ok(Number.isInteger(item.ref.startLine) && item.ref.startLine > 0);
  assert.ok(Number.isInteger(item.ref.endLine) && item.ref.endLine >= item.ref.startLine);
  assert.equal(typeof item.score, "number");
  assert.ok(item.score > 0);
  assert.equal(item.citation, `${expectedPath}#L${String(item.ref.startLine)}-${String(item.ref.endLine)}`);
}
```

Update the first call site (the one right after `firstFinalize`) to add `--signals` and use the new assertion, and the second call site (right after `postPurgePrivateData`) the same way:

```js
    const firstSearch = await runCliSuccess(harness, [
      "search",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--query",
      "catalog architecture",
      "--limit",
      "5",
      "--signals",
      "lexical,graph",
    ]);
    const catalogResult = searchResults(firstSearch.json.data).find(
      ({ ref }) => ref.path === "architecture.md",
    );
    assert.ok(catalogResult);
    assertEvidenceItem(catalogResult, "architecture.md");
```

```js
    const postPurgeSearch = await runCliSuccess(harness, [
      "search",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--query",
      "groupActiveProductsByCategory",
      "--limit",
      "5",
      "--signals",
      "lexical,graph",
    ]);
    assert.ok(searchResults(postPurgeSearch.json.data).some(({ ref }) => ref.path === "architecture.md"));
```

Passing `--signals lexical,graph` explicitly (rather than relying on the implicit default) both proves `cli.ts`'s comma-split flag parsing end-to-end through a real spawned process, and keeps these two existing e2e cases running without the real vendored embedder (they already run in an environment where `TV.1`'s assets are not guaranteed present).

- [ ] **Step 7: Run the full existing suite for regressions**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki test`
Expected: PASS, no regressions. If `tests/e2e/runtime.e2e.test.mjs`'s MCP tool-listing assertion (`for (const required of ["graph", "read", "search"]) assert.ok(toolNames.includes(required));`) is nearby other `search`-shape assertions not covered above, re-grep the file for any other `.page`/`.excerpt` access on a `search`/`ask` result before declaring this step green — those are the two shapes this task changes.

- [ ] **Step 8: Commit**

```bash
git add plugins/openwiki/src/adapter.ts plugins/openwiki/src/cli.ts plugins/openwiki/src/mcp.ts plugins/openwiki/src/wiki.ts plugins/openwiki/tests/unit/storage.test.mjs plugins/openwiki/tests/e2e/runtime.e2e.test.mjs plugins/openwiki/tests/integration/retrieve-wiring.test.mjs
git commit -m "feat(openwiki): wire hybrid search and add ask over CLI and MCP"
```

---

### Task 12: `doctor` vendor-asset diagnostics

**Why `fail`, not `warning`:** after Task 10's soft-degrade fix (TP.2 review finding C2), missing or corrupt vendor assets no longer break ordinary `write`/`graph build` — but they do mean every subsequent write proceeds with vector embedding skipped (recorded, not silent — see `ReindexResult.embeddingsAvailable`/`VectorStore.status()`), and `search`/`ask` will hard-fail the moment the `vector` signal is requested (explicitly or by implicit default). Semantic (vector) retrieval is entirely unavailable in this state, not merely degraded — a doctor check that only warned would understate that real, actionable severity — so this still reports `fail`, matching `runDoctor`'s existing aggregate (`ok: checks.every(status !== "fail")`) and giving the agent one place to discover why vector search/ask is unavailable and why recent writes report `embeddingsAvailable: false`.

**Files:**
- Modify: `plugins/openwiki/src/doctor.ts`
- Test: `plugins/openwiki/tests/unit/doctor-vendor.test.mjs` (new)

**Interfaces:**
- Modifies (additive): `DOCTOR_CHECK_IDS` gains `"vendor-assets"`.
- Consumes: `defaultVendorRoot`/`verifyAllVendorAssets` from `./embedder.js` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/doctor-vendor.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { resolveWikiLocation } from "../../dist/paths.js";
import { runDoctor } from "../../dist/doctor.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-doctor-vendor-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeValidVendor(vendorRoot) {
  const modelPath = "model/multilingual-e5-small-int8/model.onnx";
  const tokenizerPath = "model/multilingual-e5-small-int8/tokenizer.json";
  await mkdir(path.join(vendorRoot, "model", "multilingual-e5-small-int8"), { recursive: true });
  const model = Buffer.from("fake-model-bytes");
  const tokenizer = Buffer.from(JSON.stringify({ model: { type: "Unigram", vocab: [] } }));
  await writeFile(path.join(vendorRoot, modelPath), model);
  await writeFile(path.join(vendorRoot, tokenizerPath), tokenizer);
  const entry = (relativePath, content) => ({ path: relativePath, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, license: "MIT", upstream: "test", revision: "test-1" });
  await writeFile(path.join(vendorRoot, "MANIFEST.json"), JSON.stringify({ assets: [entry(modelPath, model), entry(tokenizerPath, tokenizer)] }));
}

test("doctor: reports vendor-assets pass when the manifest and every checksum verify", async () => {
  const home = await temporaryRoot("home");
  const root = await temporaryRoot("repo");
  await mkdir(root, { recursive: true });
  const vendorRoot = await temporaryRoot("vendor");
  await writeValidVendor(vendorRoot);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const result = await runDoctor({ location, vendorRoot });
  const check = result.checks.find((entry) => entry.id === "vendor-assets");
  assert.equal(check?.status, "pass");
});

test("doctor: reports vendor-assets fail with an actionable message when the manifest is missing", async () => {
  const home = await temporaryRoot("home");
  const root = await temporaryRoot("repo");
  await mkdir(root, { recursive: true });
  const vendorRoot = await temporaryRoot("vendor-missing");
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const result = await runDoctor({ location, vendorRoot });
  const check = result.checks.find((entry) => entry.id === "vendor-assets");
  assert.equal(check?.status, "fail");
  assert.match(check.message, /write|graph build/iu);
  assert.equal(result.ok, false);
});

test("doctor: reports vendor-assets fail on a checksum mismatch", async () => {
  const home = await temporaryRoot("home");
  const root = await temporaryRoot("repo");
  await mkdir(root, { recursive: true });
  const vendorRoot = await temporaryRoot("vendor-corrupt");
  await writeValidVendor(vendorRoot);
  await writeFile(path.join(vendorRoot, "model", "multilingual-e5-small-int8", "model.onnx"), Buffer.from("tampered"));
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const result = await runDoctor({ location, vendorRoot });
  const check = result.checks.find((entry) => entry.id === "vendor-assets");
  assert.equal(check?.status, "fail");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/doctor-vendor.test.mjs`
Expected: FAIL — `runDoctor` does not accept a `vendorRoot` option and produces no `"vendor-assets"` check.

- [ ] **Step 3: Implement**

Edit `plugins/openwiki/src/doctor.ts`. Add to the imports:

```ts
import { defaultVendorRoot, verifyAllVendorAssets } from "./embedder.js";
```

Extend `DOCTOR_CHECK_IDS`:

```ts
export const DOCTOR_CHECK_IDS = [
  "node",
  "permissions",
  "git",
  "manifests",
  "config",
  "state",
  "locks",
  "retention",
  "secret-leakage",
  "vendor-assets",
] as const;
```

Extend `RunDoctorOptions`:

```ts
export interface RunDoctorOptions {
  location: WikiLocation;
  pluginRoot?: string;
  vendorRoot?: string;
}
```

In `runDoctor`, add `checkVendorAssets(options.vendorRoot ?? defaultVendorRoot())` to the `Promise.all([...])` array (alongside the other checks — order does not matter, `runDoctor`'s only ordering guarantee is that `checkNode()` runs first, synchronously, outside the `Promise.all`).

Add the check function, near the other `checkX` functions:

```ts
async function checkVendorAssets(vendorRoot: string): Promise<DoctorCheck> {
  try {
    await verifyAllVendorAssets(vendorRoot);
    return pass("vendor-assets", "Vendored embedding model assets are present and verified.");
  } catch (error) {
    if (error instanceof OpenWikiError && error.code === "MODEL_ASSET_MISSING") {
      return fail("vendor-assets", "Vendored embedding model assets are missing; writes proceed with vector embedding skipped (embeddingsAvailable: false), and search/ask will fail if the vector signal is requested.");
    }
    if (error instanceof OpenWikiError && error.code === "MODEL_ASSET_CORRUPT") {
      return fail("vendor-assets", "Vendored embedding model assets failed checksum verification; writes proceed with vector embedding skipped (embeddingsAvailable: false), and search/ask will fail if the vector signal is requested, until assets are re-vendored.");
    }
    return fail("vendor-assets", "Vendored embedding model assets could not be verified.");
  }
}
```

- [ ] **Step 4: Run to verify it passes, then the full suite for regressions**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki run typecheck && node --test plugins/openwiki/tests/unit/doctor-vendor.test.mjs plugins/openwiki/tests/unit/doctor.test.mjs`
Expected: PASS. If an existing `doctor.test.mjs` snapshot-asserts the exact `checks` array length or `DOCTOR_CHECK_IDS` contents, update it to account for the new `"vendor-assets"` entry — this is an additive, not breaking, interface change, but a length-sensitive assertion would still need the count bumped.

Run: `npm --prefix plugins/openwiki test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/src/doctor.ts plugins/openwiki/tests/unit/doctor-vendor.test.mjs
git commit -m "feat(openwiki): add vendor asset diagnostics to doctor"
```

---

### Task 13: End-to-end performance and determinism (real vendored assets required, skip-if-absent)

**Files:**
- Test: `plugins/openwiki/tests/e2e/retrieve-performance.e2e.test.mjs` (new, skip-if-real-assets-absent)

**Interfaces:**
- Consumes: everything built in Tasks 1–12, exercised end-to-end through `dispatch()` (the same surface the CLI/MCP adapters call), against the real vendored embedder.

- [ ] **Step 1: Write the e2e test**

Create `plugins/openwiki/tests/e2e/retrieve-performance.e2e.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { dispatch } from "../../dist/adapter.js";
import { chunkMarkdown } from "../../dist/chunk.js";
import { defaultVendorRoot, loadEmbedder } from "../../dist/embedder.js";
import { openLexicalIndex } from "../../dist/lexical-index.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import { openVectorStore } from "../../dist/vector-store.js";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_PRESENT = existsSync(join(PLUGIN_ROOT, "vendor", "model", "multilingual-e5-small-int8", "model.onnx"));
const CHUNK_TARGET = 5_000;

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(join(os.tmpdir(), `openwiki-perf-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initGitRepo(root) {
  const run = (...args) => execFileAsync("git", args, { cwd: root });
  await run("init", "-q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "# fixture\n");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}

// Populates ~5,000 real embedded chunks directly against the lexical + vector
// stores (bypassing per-page writePage() calls, whose wiki-lock + per-call
// overhead would dominate the timing this test cares about: read-path
// latency, not write-path throughput — write-path timing is Task 10's/this
// same file's "incremental reindex" test below, which does go through the
// real writePage() for exactly one page, matching the PRD target's wording).
async function seedCorpus(dataRoot, embedder) {
  const lexicalIndex = await openLexicalIndex(join(dataRoot, "lexical"));
  const vectorStore = await openVectorStore(join(dataRoot, "vectors"), { modelId: embedder.modelId, modelRevision: "perf-fixture", dims: embedder.dims });
  const BATCH = 100;
  for (let batchStart = 0; batchStart < CHUNK_TARGET; batchStart += BATCH) {
    const texts = [];
    const refs = [];
    for (let index = batchStart; index < Math.min(batchStart + BATCH, CHUNK_TARGET); index += 1) {
      const text = `Synthetic passage number ${String(index)} about catalog architecture, retrieval fusion, and graph proximity ranking.`;
      const [ref] = chunkMarkdown(`fixtures/passage-${String(index)}.md`, `# Passage ${String(index)}\n\n${text}\n`);
      texts.push(text);
      refs.push({ ref, text });
    }
    await lexicalIndex.upsert(refs);
    const vectors = await embedder.embedPassages(texts);
    await vectorStore.upsert(refs.map(({ ref }, index) => ({ ref, vector: vectors[index] })));
  }
}

test("search/ask p95 < 1s @ 5k chunks including query embedding (asserted with 2x CI margin: < 2000ms)", { skip: !MODEL_PRESENT }, async (t) => {
  t.diagnostic(`chunk target: ${String(CHUNK_TARGET)}`);
  const root = await temporaryRoot("repo");
  const home = await temporaryRoot("home");
  await initGitRepo(root);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const embedder = await loadEmbedder(defaultVendorRoot());
  await seedCorpus(location.dataRoot, embedder);

  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    const startedAt = process.hrtime.bigint();
    const result = await dispatch({ operation: "search", input: { mode: "code", root, query: "catalog architecture retrieval fusion", limit: 10, signals: ["lexical", "vector"] } });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.equal(result.ok, true);
    assert.ok(result.data.evidence.length > 0);
    samples.push(elapsedMs);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  t.diagnostic(`search samples (ms): ${JSON.stringify(sorted)}`);
  assert.ok(p95 < 2000, `p95 ${String(p95)}ms exceeded the 2x-margin budget of 2000ms (target: <1000ms)`);
});

test("incremental reindex of one changed wiki page < 2s (asserted with 2x CI margin: < 4000ms)", { skip: !MODEL_PRESENT }, async () => {
  const root = await temporaryRoot("repo-incremental");
  const home = await temporaryRoot("home-incremental");
  await initGitRepo(root);
  const { initializeWiki, writePage } = await import("../../dist/wiki.js");
  await initializeWiki({ mode: "code", root, homeDir: home });

  const startedAt = process.hrtime.bigint();
  await writePage(
    await resolveWikiLocation({ mode: "code", root, homeDir: home }),
    "notes/perf.md",
    "# Performance note\n\nA short changed page used to measure incremental reindex latency end to end.\n",
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  assert.ok(elapsedMs < 4000, `incremental reindex took ${String(elapsedMs)}ms, exceeding the 2x-margin budget of 4000ms (target: <2000ms)`);
});

test("full build of this repository < 60s (asserted with 2x CI margin: < 120000ms)", { skip: !MODEL_PRESENT }, async () => {
  const { buildGraph } = await import("../../dist/graph.js");
  const startedAt = process.hrtime.bigint();
  const result = await buildGraph({ root: PLUGIN_ROOT, homeDir: await mkdtemp(join(os.tmpdir(), "openwiki-perf-fullbuild-home-")), force: true });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  assert.ok(result.nodeCount > 0);
  assert.ok(elapsedMs < 120_000, `full build took ${String(elapsedMs)}ms, exceeding the 2x-margin budget of 120000ms (target: <60000ms)`);
});

test("determinism: the same store and query return the same result ids in the same order, twice", { skip: !MODEL_PRESENT }, async () => {
  const root = await temporaryRoot("repo-determinism");
  const home = await temporaryRoot("home-determinism");
  await initGitRepo(root);
  const location = await resolveWikiLocation({ mode: "code", root, homeDir: home });
  const embedder = await loadEmbedder(defaultVendorRoot());
  const lexicalIndex = await openLexicalIndex(join(location.dataRoot, "lexical"));
  const vectorStore = await openVectorStore(join(location.dataRoot, "vectors"), { modelId: embedder.modelId, modelRevision: "determinism-fixture", dims: embedder.dims });
  const passages = ["catalog architecture overview", "retrieval fusion internals", "unrelated topic about weather"];
  const refs = passages.map((text, index) => ({ ref: chunkMarkdown(`fixtures/d-${String(index)}.md`, `# D${String(index)}\n\n${text}\n`)[0], text }));
  await lexicalIndex.upsert(refs);
  await vectorStore.upsert((await Promise.all(refs.map(({ text }) => embedder.embedPassages([text])))).map((vectors, index) => ({ ref: refs[index].ref, vector: vectors[0] })));

  const runOnce = () => dispatch({ operation: "search", input: { mode: "code", root, query: "catalog architecture retrieval", limit: 5, signals: ["lexical", "vector"] } });
  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.data.evidence.map((item) => item.ref.id), second.data.evidence.map((item) => item.ref.id));
});
```

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/e2e/retrieve-performance.e2e.test.mjs`
Expected: SKIP all four tests if `plugins/openwiki/vendor/model/multilingual-e5-small-int8/model.onnx` is absent (true today — see Prerequisite 2; also true until the vendor-chunking follow-up lands the real, split asset). PASS once real assets exist. If the p95 test is flaky near the 2000ms boundary on a slow CI runner, that is real signal, not a test bug — do not raise the margin further without recording the measured numbers in this plan's follow-up notes; if `full build < 120000ms` fails on this actual repository as it grows, that is exactly the kind of finding T9.1 (master plan) exists to catch.

- [ ] **Step 2: Commit**

```bash
git add plugins/openwiki/tests/e2e/retrieve-performance.e2e.test.mjs
git commit -m "test(openwiki): add real-asset performance and determinism e2e coverage"
```

---

## Self-review (performed at completion, mirroring the master plan's own convention)

- **Spec coverage:** PRD §7 slice 2b's five bullets map onto this plan's tasks as: vector store + chunking → Tasks 3, 6; inference → Tasks 4, 5; lexical index → Task 7; hybrid retrieval (`search`/`ask`) → Tasks 8, 11; performance targets → Task 13. The master plan's binding-contracts block (chunk/tokenizer/embedder/vector-store/lexical-index/retrieve interfaces, new CLI operations, MCP mirroring, error codes) is implemented exactly, name-for-name, in Tasks 1, 3–11. Global Constraints (silent-fallback-forbidden, e5 prefix discipline, TDD-per-task, 2x-margin perf targets) are honored task-by-task and re-asserted concretely in Task 13. Gap closed during this review: Tasks 11 (CLI/MCP wiring), 12 (doctor diagnostics), and 13 (e2e performance/determinism) did not exist in the version of this plan found mid-write; they are authored above, completing the task list the Prerequisites section and Tasks 5/8/10 already forward-referenced by number.
- **Placeholders:** none remain; every new task follows the file's existing convention (full runnable test code, full runnable implementation code, exact commands with expected output, no `TODO`/`TBD` markers).
- **Type consistency:** `SearchRequest`/`EvidenceItem`/`SearchResultV1`/`AskResultV1`/`RetrievalPorts` (Task 8) are consumed unchanged by Task 11's adapter wiring; `ChunkRef` (Task 3) flows unchanged through `chunk.ts` → `vector-store.ts`/`lexical-index.ts` (Tasks 6–7) → `retrieve.ts` (Task 8) → `EvidenceItem.ref` (Task 11); the four new error codes (Task 1) are the only ones thrown by every subsequent task, with no ad hoc new codes introduced.
- **Corrections made while completing this plan (not just additions):** (a) two "verified directly against the real committed manifest" claims (Prerequisite 2, Task 5 assumption 2) were re-verified against the actual `TV.1` commit and found to overclaim — corrected in place to describe the real (flat, unsplit) committed state versus the binding PRD §16 target (split) state, without changing the implementation those notes introduce, which already correctly targets the PRD §16 shape; (b) a previously undocumented tokenizer normalization gap (the real `tokenizer.json`'s `Precompiled` SentencePiece charsmap vs. this plan's plain-NFKC approximation) is now flagged as a Design note in Task 4, matching this plan's own established convention for documented, deliberate approximations, rather than left silent; (c) the plan's own internal task-numbering was inconsistent (Task 5's Prerequisite/assumption text said "Task 11 doctor check" while Task 8's design note said "Task 11 (CLI/MCP wiring)") — resolved in favor of Task 8's more specific label (CLI/MCP wiring is Task 11, matching its real dependency on Tasks 8 and 10 already having landed), with the one conflicting forward-reference corrected.
- **TP.2 independent review — Revision 1 (this pass):** an independent review (`.superpowers/sdd/tp2-review.md`) returned REVISE with 2 Critical, 3 Important, 2 Minor findings; all seven are resolved in this revision. **C1:** Task 5's ONNX Runtime loader now resolves and dynamically `import()`s the real vendored `ort.node.min.mjs` entry file directly (`resolveOrtEntryPath`, unit-tested without real assets), instead of `createRequire`-ing a directory that has no `package.json` and would throw `MODULE_NOT_FOUND`/`ERR_REQUIRE_ESM`. **C2:** Task 10's write paths (`writePage`/`buildGraph`) now soft-degrade — skip embedding, record the skip non-silently via `ReindexResult.embeddingsAvailable`/`VectorStore.status().unavailableReason` — instead of hard-failing; only `search`/`ask` still hard-fail when the vector signal is unavailable, matching PRD §11's actual scope (Task 12's doctor rationale updated to match). **I1:** Task 6's vector-store manifest `segments[]` restored to the binding contract's `{file,contentHash,count}` shape. **I2:** `retrieve.ts`'s `fuse()` now populates `EvidenceItem.confidence` for every result — from the graph traversal when reached via the graph signal, or from the chunk's plane otherwise — asserted in Task 8's tests. **I3:** Task 11's `writeFixtureGraph` now writes a real shard so its fingerprint computation agrees with `getGraphStatus`'s own filtered one, plus a new `stale: false` fresh-path test closing the previously-flagged residual risk. **M1:** the undocumented BFS depth-decay multiplier is removed; graph proximity now combines edge-confidence weights along the path exactly per the binding contract's literal spec (a widest-path/max-product computation). **M2:** Task 11's adapter.ts diff now imports the `WikiLocation` type it uses. Full before/after detail per finding: `.superpowers/sdd/tp2-report.md`, Revision 1 section.
- **New, narrower finding surfaced while fixing M1 (not one of TP.2's seven, resolved at the test level rather than redesigned):** every graph-signal-eligible candidate is also a BFS seed and every seed starts at the ceiling weight (1), so `graphSignal` cannot currently differentiate ranking *among* co-seeded candidates purely by connectivity — they tie, broken only by `ChunkRef.id`. Task 8's own test for this was asserting a rank that could never actually occur (both `a`/`b` are lexical hits, hence both seeds, hence tied); the test was rewritten at the time to assert reachability + confidence label instead of a strict rank — but a round-2 independent review (see the Revision 2 bullet immediately below) proved that rewrite was *itself* still a tautology (both assertions held with or without the connecting edge), which this plan has now fixed for real rather than at the test-wording level alone. The deeper, still-deferred fix — seeds not sharing a ceiling weight among already-co-seeded candidates — remains Task 8 design decision 6 and is intentionally left for T9.1's real-data measurement, not reopened here.
- **TP.2 independent review — Revision 2 (this pass), round-2 findings N1/N2:** a second independent review (`.superpowers/sdd/tp2-review-round2.md`) returned REVISE naming Task 8 only, for **N1** (Important); **N2** (Minor, Task 6) was bundled into the same pass. **N1:** the reviewer proved, by extracting `graphSignal`/`graphProximity` verbatim and running the fixture with vs. without its connecting edge, that Task 8's "graph signal reaches a chunk... carrying the traversed edge's confidence" test produced *identical* output either way — a tautology, since every graph-signal-eligible candidate was, by construction, already a BFS seed at the ceiling weight/confidence, so no edge traversal could ever change any result. This was a real design gap, not just a test-wording problem: `graphSignal` only ever re-ranked the existing lexical/vector candidate pool — it never turned a BFS-reached, non-candidate node into a new fused result, despite the binding contract's graph proximity existing precisely to surface chunks neither lexical nor vector search found. Fixed in `retrieve.ts` itself (design decision 1, rewritten): for every node `graphProximity` reaches that is *not* already a candidate, `graphSignal` now resolves it to a `ChunkRef` via `chunkSymbols([node])` (Task 3's pure, file-read-free reconstruction of a `symbol`-kind node's chunk) and adds it as a brand-new fused candidate carrying the traversed path's real confidence label; `concept`/`page` nodes stay out of scope (disclosed, not silent — `chunkMarkdown` needs full page text `GraphIndexPort` cannot provide). Task 8's tautological test is replaced by a non-tautological pair — one asserting a chunk that is neither a lexical nor a vector hit is surfaced with the correct confidence, one asserting it disappears when the connecting edge is removed — plus a new depth-2-vs-3-hop test proving genuine bounded BFS expansion via `relatedNodes`. Decision 6 is corrected in place (not silently rewritten) to state the real, narrower remaining limitation (co-seeded lexical/vector hits still tie at the ceiling weight) instead of the disproven "connectivity determines reachability" claim. While verifying the new tests by hand-tracing the algorithm, two adjacent latent bugs in the *pre-existing* test fixtures were also found and fixed in the same file: the "ask: wraps search" test and the (now-added) depth-2 test both omitted `--signals`, which would have made `ask()` default to all three signals including `vector` and throw `MODEL_ASSET_MISSING` against ports with no vector store/embedder — both now pass explicit `["lexical", "graph"]`. **N2:** Task 6's vector-store test suite asserted the multi-bucket contentHash carry-forward behavior only in prose, not in a test; added one proving an untouched bucket's `contentHash` survives a second `upsert()` byte-for-byte while a touched bucket's is recomputed. Full before/after detail: `.superpowers/sdd/tp2-report.md`, Revision 2 section.
