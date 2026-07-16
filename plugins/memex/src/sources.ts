import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, withWikiLock } from "./atomic.js";
import {
  MAX_ENVELOPE_BYTES,
  parseSourceEnvelope,
  type SourceEnvelopeV1,
  type SourceKind,
} from "./contracts.js";
import { MemexError } from "./errors.js";
import type { WikiLocation } from "./paths.js";
import { redactSensitive } from "./redact.js";

export const DEFAULT_SOURCE_RETENTION_RUNS = 20;
export const MAX_SOURCE_RETENTION_RUNS = 20;

const RAW_DIRECTORY_NAME = "raw";
const SCHEDULES_FILE_NAME = "schedules.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface IngestSourceOptions {
  location: WikiLocation;
  envelope: unknown;
  retentionRuns?: number;
}

export interface IngestSourceResult {
  sourceId: string;
  kind: SourceKind;
  runHash: string;
  stored: boolean;
  acceptedItems: number;
  duplicateItems: number;
  retainedRuns: number;
}

export interface SourceSummary {
  sourceId: string;
  kind: SourceKind;
  runCount: number;
  itemCount: number;
  latestFetchedAt: string;
  latestRunHash: string;
}

export const PURGE_SCOPES = ["raw", "schedules", "personal-wiki", "all"] as const;
export type PurgeScope = (typeof PURGE_SCOPES)[number];
export type RemovedPurgeScope = Exclude<PurgeScope, "all">;

export interface PurgeDataOptions {
  location: WikiLocation;
  scope: PurgeScope;
}

export interface PurgeDataResult {
  requestedScope: PurgeScope;
  removedScopes: RemovedPurgeScope[];
}

interface StoredRun {
  filePath: string;
  runHash: string;
  envelope: SourceEnvelopeV1;
}

export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function ingestSource(
  options: IngestSourceOptions,
): Promise<IngestSourceResult> {
  const retentionRuns = parseRetentionRuns(options.retentionRuns);
  const validatedInput = parseSourceEnvelope(options.envelope);
  const redacted = parseSourceEnvelope(redactSensitive(validatedInput));

  await ensureDirectory(options.location.dataRoot);

  return withWikiLock(options.location.dataRoot, async () => {
    const rawRoot = path.join(options.location.dataRoot, RAW_DIRECTORY_NAME);
    const sourceDirectory = path.join(rawRoot, canonicalJsonHash(redacted.sourceId));
    await ensureDirectory(rawRoot);
    await ensureDirectory(sourceDirectory);

    const existingRuns = await readRunsFromSourceDirectory(sourceDirectory);
    assertRunIdentity(existingRuns, redacted.sourceId);
    if (
      existingRuns.some((run) => run.envelope.kind !== redacted.kind)
    ) {
      throw new MemexError(
        "INVALID_ARGUMENT",
        "Source id is already associated with a different source kind.",
      );
    }

    const knownItems = new Set<string>();
    for (const run of existingRuns) {
      for (const item of run.envelope.items) {
        knownItems.add(itemIdentity(run.envelope.sourceId, item));
      }
    }

    const novelItems = redacted.items.filter(
      (item) => !knownItems.has(itemIdentity(redacted.sourceId, item)),
    );
    const persistedEnvelope: SourceEnvelopeV1 = {
      ...redacted,
      items: novelItems,
    };
    const runHash = canonicalJsonHash(persistedEnvelope);
    let stored = false;

    if (novelItems.length > 0) {
      await atomicWriteFile(
        path.join(sourceDirectory, `${runHash}.json`),
        `${JSON.stringify(persistedEnvelope)}\n`,
      );
      stored = true;
    }

    const currentRuns = await readRunsFromSourceDirectory(sourceDirectory);
    const retainedRuns = await retainLatestRuns(currentRuns, retentionRuns);

    return {
      sourceId: redacted.sourceId,
      kind: redacted.kind,
      runHash,
      stored,
      acceptedItems: novelItems.length,
      duplicateItems: redacted.items.length - novelItems.length,
      retainedRuns,
    };
  });
}

export async function listSources(location: WikiLocation): Promise<SourceSummary[]> {
  if (!(await directoryExistsWithoutSymlink(location.dataRoot))) {
    return [];
  }
  const rawRoot = path.join(location.dataRoot, RAW_DIRECTORY_NAME);
  const sourceDirectories = await listSourceDirectories(rawRoot);
  const summaries: SourceSummary[] = [];

  for (const sourceDirectory of sourceDirectories) {
    const runs = await readRunsFromSourceDirectory(sourceDirectory);
    if (runs.length === 0) {
      continue;
    }
    const latest = [...runs].sort(compareRunsNewestFirst)[0];
    if (latest === undefined) {
      continue;
    }
    assertRunIdentity(runs, latest.envelope.sourceId);

    summaries.push({
      sourceId: latest.envelope.sourceId,
      kind: latest.envelope.kind,
      runCount: runs.length,
      itemCount: runs.reduce((total, run) => total + run.envelope.items.length, 0),
      latestFetchedAt: latest.envelope.fetchedAt,
      latestRunHash: latest.runHash,
    });
  }

  return summaries.sort((left, right) => compareStrings(left.sourceId, right.sourceId));
}

export async function purgeData(
  options: PurgeDataOptions,
): Promise<PurgeDataResult> {
  const scope = parsePurgeScope(options.scope);
  if (scope === "personal-wiki" && options.location.mode !== "personal") {
    throw new MemexError(
      "INVALID_ARGUMENT",
      "The personal-wiki purge scope requires personal mode.",
    );
  }
  if (
    (scope === "personal-wiki" || scope === "all") &&
    options.location.mode === "personal"
  ) {
    await assertPersonalWikiUnlocked(options.location);
  }

  const removedScopes: RemovedPurgeScope[] = [];
  const privateScopes = getPrivatePurgeScopes(scope);
  const dataRootExists = await directoryExistsWithoutSymlink(options.location.dataRoot);

  if (privateScopes.length > 0 && dataRootExists) {
    await withWikiLock(options.location.dataRoot, async () => {
      for (const privateScope of privateScopes) {
        const target =
          privateScope === "raw"
            ? path.join(options.location.dataRoot, RAW_DIRECTORY_NAME)
            : path.join(options.location.dataRoot, SCHEDULES_FILE_NAME);
        if (await removeTreeNoFollow(target)) {
          removedScopes.push(privateScope);
        }
      }
    });
  }

  if (
    (scope === "personal-wiki" || scope === "all") &&
    options.location.mode === "personal"
  ) {
    const removedWikiRoot = await removeTreeNoFollow(options.location.wikiRoot);
    const removedState = await removeTreeNoFollow(options.location.statePath);
    if (removedWikiRoot || removedState) {
      removedScopes.push("personal-wiki");
    }
  }

  return { requestedScope: scope, removedScopes };
}

async function assertPersonalWikiUnlocked(location: WikiLocation): Promise<void> {
  const wikiStatus = await inspectPath(location.wikiRoot);
  if (wikiStatus === null || wikiStatus.isSymbolicLink() || !wikiStatus.isDirectory()) {
    return;
  }
  if ((await inspectPath(path.join(location.wikiRoot, ".memex.lock"))) !== null) {
    throw new MemexError(
      "LOCKED",
      "Memex is locked; purge cannot infer safe ownership.",
    );
  }
}

function canonicalJson(value: unknown, ancestors = new WeakSet()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return withCanonicalGuard(value, ancestors, () =>
      `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`,
    );
  }
  if (isPlainRecord(value)) {
    return withCanonicalGuard(value, ancestors, () => {
      const entries = Object.keys(value)
        .sort(compareStrings)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`);
      return `{${entries.join(",")}}`;
    });
  }

  throw new MemexError(
    "INVALID_ARGUMENT",
    "Canonical hashing requires a JSON-compatible value.",
  );
}

function withCanonicalGuard<T>(
  value: object,
  ancestors: WeakSet<object>,
  operation: () => T,
): T {
  if (ancestors.has(value)) {
    throw new MemexError(
      "INVALID_ARGUMENT",
      "Canonical hashing does not accept cyclic values.",
    );
  }
  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function itemIdentity(
  sourceId: string,
  item: SourceEnvelopeV1["items"][number],
): string {
  return `${sourceId}\0${item.externalId}\0${canonicalJsonHash(item)}`;
}

function parseRetentionRuns(value: number | undefined): number {
  const parsed = value ?? DEFAULT_SOURCE_RETENTION_RUNS;
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SOURCE_RETENTION_RUNS
  ) {
    throw new MemexError(
      "INVALID_ARGUMENT",
      `Source retention must be an integer from 1 to ${String(MAX_SOURCE_RETENTION_RUNS)}.`,
    );
  }
  return parsed;
}

function parsePurgeScope(value: unknown): PurgeScope {
  if (!isPurgeScope(value)) {
    throw new MemexError(
      "INVALID_ARGUMENT",
      "Purge scope must be raw, schedules, personal-wiki, or all.",
    );
  }
  return value;
}

function getPrivatePurgeScopes(scope: PurgeScope): Array<"raw" | "schedules"> {
  if (scope === "raw" || scope === "schedules") {
    return [scope];
  }
  if (scope === "all") {
    return ["raw", "schedules"];
  }
  return [];
}

async function retainLatestRuns(
  runs: StoredRun[],
  retentionRuns: number,
): Promise<number> {
  const ordered = [...runs].sort(compareRunsNewestFirst);
  for (const run of ordered.slice(retentionRuns)) {
    await unlinkRegularFile(run.filePath);
  }
  return Math.min(ordered.length, retentionRuns);
}

function compareRunsNewestFirst(left: StoredRun, right: StoredRun): number {
  const timestampOrder = compareStrings(right.envelope.fetchedAt, left.envelope.fetchedAt);
  return timestampOrder === 0 ? compareStrings(right.runHash, left.runHash) : timestampOrder;
}

function assertRunIdentity(
  runs: StoredRun[],
  sourceId: string,
): void {
  const sourceDirectoryName = canonicalJsonHash(sourceId);
  const persistedKind = runs[0]?.envelope.kind;
  for (const run of runs) {
    if (
      run.envelope.sourceId !== sourceId ||
      run.envelope.kind !== persistedKind ||
      path.basename(path.dirname(run.filePath)) !== sourceDirectoryName
    ) {
      throw new MemexError(
        "INVALID_STATE",
        "Persisted source runs contain inconsistent source identity.",
      );
    }
  }
}

async function listSourceDirectories(rawRoot: string): Promise<string[]> {
  const status = await inspectPath(rawRoot);
  if (status === null) {
    return [];
  }
  if (status.isSymbolicLink()) {
    throw new MemexError(
      "SYMLINK_ESCAPE",
      "Raw source storage must not be a symbolic link.",
    );
  }
  if (!status.isDirectory()) {
    throw new MemexError("INVALID_STATE", "Raw source storage is invalid.");
  }

  try {
    const entries = await readdir(rawRoot, { withFileTypes: true });
    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new MemexError(
          "SYMLINK_ESCAPE",
          "Raw source storage contains a symbolic link.",
        );
      }
      if (!entry.isDirectory() || !HASH_PATTERN.test(entry.name)) {
        throw new MemexError("INVALID_STATE", "Raw source storage is invalid.");
      }
      directories.push(path.join(rawRoot, entry.name));
    }
    return directories.sort(compareStrings);
  } catch (error) {
    throw mapStorageError(error, "Unable to enumerate raw source storage.");
  }
}

async function readRunsFromSourceDirectory(
  sourceDirectory: string,
): Promise<StoredRun[]> {
  const status = await inspectPath(sourceDirectory);
  if (status === null) {
    return [];
  }
  if (status.isSymbolicLink()) {
    throw new MemexError(
      "SYMLINK_ESCAPE",
      "Source run directory must not be a symbolic link.",
    );
  }
  if (!status.isDirectory()) {
    throw new MemexError("INVALID_STATE", "Source run directory is invalid.");
  }

  let entries;
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    throw mapStorageError(error, "Unable to enumerate source runs.");
  }

  const runs: StoredRun[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new MemexError(
        "SYMLINK_ESCAPE",
        "Source runs must not contain symbolic links.",
      );
    }
    const runHash = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    if (!entry.isFile() || !HASH_PATTERN.test(runHash)) {
      throw new MemexError("INVALID_STATE", "Persisted source run is invalid.");
    }
    const filePath = path.join(sourceDirectory, entry.name);
    const envelope = await readStoredEnvelope(filePath);
    if (
      canonicalJsonHash(envelope) !== runHash ||
      canonicalJsonHash(envelope.sourceId) !== path.basename(sourceDirectory)
    ) {
      throw new MemexError(
        "INVALID_STATE",
        "Persisted source run integrity check failed.",
      );
    }
    runs.push({ filePath, runHash, envelope });
  }

  return runs;
}

async function readStoredEnvelope(filePath: string): Promise<SourceEnvelopeV1> {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_ENVELOPE_BYTES + 1) {
      throw new MemexError("INVALID_STATE", "Persisted source run is invalid.");
    }
    const content = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new MemexError(
        "INVALID_STATE",
        "Persisted source run is not valid JSON.",
      );
    }
    try {
      return parseSourceEnvelope(parsed);
    } catch (error) {
      if (error instanceof MemexError) {
        throw new MemexError("INVALID_STATE", "Persisted source run is invalid.");
      }
      throw error;
    }
  } catch (error) {
    if (isSymlinkError(error)) {
      throw new MemexError(
        "SYMLINK_ESCAPE",
        "Persisted source run must not be a symbolic link.",
      );
    }
    throw mapStorageError(error, "Unable to read persisted source run.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  const existing = await inspectPath(directory);
  if (existing?.isSymbolicLink()) {
    throw new MemexError(
      "SYMLINK_ESCAPE",
      "Private Memex storage must not be a symbolic link.",
    );
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new MemexError("IO_FAILURE", "Private Memex storage is invalid.");
  }
  if (existing !== null) {
    return;
  }

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const created = await lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new MemexError(
        "SYMLINK_ESCAPE",
        "Private Memex storage must not be a symbolic link.",
      );
    }
  } catch (error) {
    throw mapStorageError(error, "Unable to create private Memex storage.");
  }
}

async function directoryExistsWithoutSymlink(directory: string): Promise<boolean> {
  const status = await inspectPath(directory);
  if (status === null) {
    return false;
  }
  if (status.isSymbolicLink()) {
    throw new MemexError(
      "SYMLINK_ESCAPE",
      "Private Memex storage must not be a symbolic link.",
    );
  }
  if (!status.isDirectory()) {
    throw new MemexError("IO_FAILURE", "Private Memex storage is invalid.");
  }
  return true;
}

async function inspectPath(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw mapStorageError(error, "Unable to inspect private Memex storage.");
  }
}

async function unlinkRegularFile(filePath: string): Promise<void> {
  const status = await inspectPath(filePath);
  if (status === null) {
    return;
  }
  if (status.isSymbolicLink()) {
    throw new MemexError(
      "SYMLINK_ESCAPE",
      "Source retention must not follow symbolic links.",
    );
  }
  if (!status.isFile()) {
    throw new MemexError("INVALID_STATE", "Persisted source run is invalid.");
  }
  try {
    await unlink(filePath);
  } catch (error) {
    throw mapStorageError(error, "Unable to apply source retention.");
  }
}

async function removeTreeNoFollow(target: string): Promise<boolean> {
  const status = await inspectPath(target);
  if (status === null) {
    return false;
  }

  try {
    if (!status.isDirectory() || status.isSymbolicLink()) {
      await unlink(target);
      return true;
    }

    const entries = await readdir(target);
    for (const entry of entries) {
      await removeTreeNoFollow(path.join(target, entry));
    }
    await rmdir(target);
    return true;
  } catch (error) {
    throw mapStorageError(error, "Unable to purge Memex data.");
  }
}

function mapStorageError(error: unknown, message: string): MemexError {
  if (error instanceof MemexError) {
    return error;
  }
  return new MemexError("IO_FAILURE", message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPurgeScope(value: unknown): value is PurgeScope {
  return (
    value === "raw" ||
    value === "schedules" ||
    value === "personal-wiki" ||
    value === "all"
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isSymlinkError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOOP";
}
