import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { defaultVendorRoot, verifyAllVendorAssets } from "./embedder.js";
import { MemexError } from "./errors.js";
import { ladybugWasmAvailable } from "./ladybug-wasm.js";
import { ladybugNativeAvailable } from "./ladybug-native.js";
import { TOMBSTONE_FILE_NAME } from "./migrate.js";
import { legacyStorageRoot, type WikiLocation } from "./paths.js";
import { containsSensitive } from "./redact.js";
import { listSources, MAX_SOURCE_RETENTION_RUNS } from "./sources.js";
import { readState } from "./state.js";

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
  "graph-cypher",
  "legacy-storage",
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];
export type DoctorCheckStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  id: DoctorCheckId;
  status: DoctorCheckStatus;
  message: string;
}

export interface RunDoctorOptions {
  location: WikiLocation;
  homeDir: string;
  pluginRoot?: string;
  vendorRoot?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

const execFileAsync = promisify(execFile);
const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATHS = [
  path.join(".codex-plugin", "plugin.json"),
  path.join(".claude-plugin", "plugin.json"),
] as const;
const MAX_DOCTOR_FILE_BYTES = 2 * 1024 * 1024 + 1;
const MAX_DOCTOR_FILES = 1_000;

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorResult> {
  const pluginRoot = options.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const checks = [
    checkNode(),
    ...(await Promise.all([
      checkPermissions(options.location),
      checkGit(options.location),
      checkManifests(pluginRoot),
      checkConfig(pluginRoot),
      checkState(options.location),
      checkLocks(options.location),
      checkRetention(options.location),
      checkSecretLeakage(options.location),
      checkVendorAssets(options.vendorRoot ?? defaultVendorRoot()),
      checkGraphCypher(options.vendorRoot ?? defaultVendorRoot()),
      checkLegacyStorage(options.homeDir),
    ])),
  ];

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

function checkNode(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 20
    ? pass("node", "Node.js runtime satisfies the required major version.")
    : fail("node", "Node.js 20 or newer is required.");
}

async function checkPermissions(location: WikiLocation): Promise<DoctorCheck> {
  try {
    const wikiStatus = await lstatOrNull(location.wikiRoot);
    if (wikiStatus === null) {
      return fail("permissions", "Wiki root is not initialized.");
    }
    if (wikiStatus.isSymbolicLink() || !wikiStatus.isDirectory()) {
      return fail("permissions", "Wiki root is not a safe directory.");
    }
    await access(location.wikiRoot, fsConstants.R_OK | fsConstants.W_OK);

    const dataStatus = await lstatOrNull(location.dataRoot);
    if (dataStatus === null) {
      return warning("permissions", "Private data root has not been created yet.");
    }
    if (dataStatus.isSymbolicLink() || !dataStatus.isDirectory()) {
      return fail("permissions", "Private data root is not a safe directory.");
    }
    await access(location.dataRoot, fsConstants.R_OK | fsConstants.W_OK);
    return pass("permissions", "Wiki and private data roots are accessible.");
  } catch {
    return fail("permissions", "Wiki or private data root permissions are invalid.");
  }
}

async function checkGit(location: WikiLocation): Promise<DoctorCheck> {
  try {
    await execFileAsync("git", ["--version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    if (location.mode === "code") {
      if (location.workspaceRoot === undefined) {
        return fail("git", "Code mode is missing a repository root.");
      }
      const result = await execFileAsync(
        "git",
        ["-C", location.workspaceRoot, "rev-parse", "--is-inside-work-tree"],
        { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      );
      if (result.stdout.trim() !== "true") {
        return fail("git", "Configured code root is not a Git worktree.");
      }
    }
    return pass("git", "Git runtime is available.");
  } catch {
    return fail("git", "Git runtime or repository inspection failed.");
  }
}

async function checkManifests(pluginRoot: string): Promise<DoctorCheck> {
  try {
    for (const relativePath of MANIFEST_PATHS) {
      await readJsonFileNoFollow(path.join(pluginRoot, relativePath), 256 * 1024);
    }
    return pass("manifests", "Codex and Claude plugin manifests are readable.");
  } catch {
    return fail("manifests", "Codex or Claude plugin manifest is invalid.");
  }
}

async function checkConfig(pluginRoot: string): Promise<DoctorCheck> {
  try {
    await readJsonFileNoFollow(path.join(pluginRoot, ".mcp.json"), 256 * 1024);
    return pass("config", "Shared MCP configuration is readable.");
  } catch {
    return fail("config", "Shared MCP configuration is invalid.");
  }
}

async function checkState(location: WikiLocation): Promise<DoctorCheck> {
  try {
    await readState(location);
    return pass("state", "Wiki state is valid for the resolved location.");
  } catch {
    return fail("state", "Wiki state is missing, malformed, or inconsistent.");
  }
}

async function checkLocks(location: WikiLocation): Promise<DoctorCheck> {
  try {
    const lockPaths = [
      path.join(location.wikiRoot, ".memex.lock"),
      path.join(location.dataRoot, ".memex.lock"),
    ];
    for (const lockPath of lockPaths) {
      if ((await lstatOrNull(lockPath)) !== null) {
        return fail("locks", "A Memex operation lock is active.");
      }
    }
    return pass("locks", "No Memex operation lock is active.");
  } catch {
    return fail("locks", "Memex lock state could not be inspected safely.");
  }
}

async function checkRetention(location: WikiLocation): Promise<DoctorCheck> {
  try {
    const sources = await listSources(location);
    if (sources.some((source) => source.runCount > MAX_SOURCE_RETENTION_RUNS)) {
      return fail("retention", "One or more sources exceed retention limits.");
    }
    return pass("retention", "Persisted source runs satisfy retention limits.");
  } catch {
    return fail("retention", "Persisted source retention state is invalid.");
  }
}

async function checkSecretLeakage(location: WikiLocation): Promise<DoctorCheck> {
  try {
    const dataRootStatus = await lstatOrNull(location.dataRoot);
    if (dataRootStatus === null) {
      return pass(
        "secret-leakage",
        "No credential-shaped value was found in private data.",
      );
    }
    if (dataRootStatus.isSymbolicLink() || !dataRootStatus.isDirectory()) {
      return fail("secret-leakage", "Private data root is not a safe directory.");
    }
    const targets = [
      path.join(location.dataRoot, "raw"),
      path.join(location.dataRoot, "schedules.json"),
    ];
    const files: string[] = [];
    for (const target of targets) {
      await collectFilesNoFollow(target, files);
      if (files.length > MAX_DOCTOR_FILES) {
        return fail("secret-leakage", "Private data secret scan exceeded its safe cap.");
      }
    }

    for (const file of files) {
      const content = await readTextFileNoFollow(file, MAX_DOCTOR_FILE_BYTES);
      let inspected: unknown = content;
      try {
        inspected = JSON.parse(content);
      } catch {
        // Malformed state is reported by its owning check; raw text is still scanned.
      }
      if (containsSensitive(inspected)) {
        return fail(
          "secret-leakage",
          "Private data contains a credential-shaped value.",
        );
      }
    }
    return pass("secret-leakage", "No credential-shaped value was found in private data.");
  } catch {
    return fail("secret-leakage", "Private data could not be scanned safely.");
  }
}

// Reports "fail", not "warning": after the write-path soft-degrade fix
// (reindex.ts), missing/corrupt vendor assets no longer break ordinary
// write/graph build, but semantic (vector) retrieval is entirely
// unavailable in this state — search/ask hard-fail the moment the vector
// signal is requested (explicitly or by implicit default), and every
// subsequent write proceeds with embedding silently-but-non-silently
// skipped (ReindexResult.embeddingsAvailable / VectorStore.status()). That
// is real, actionable severity a mere warning would understate.
async function checkVendorAssets(vendorRoot: string): Promise<DoctorCheck> {
  try {
    await verifyAllVendorAssets(vendorRoot);
    return pass("vendor-assets", "Vendored embedding model assets are present and verified.");
  } catch (error) {
    const reason = error instanceof MemexError ? error.message : "Vendor asset verification failed unexpectedly.";
    return fail(
      "vendor-assets",
      `${reason} Vector search/ask will be unavailable and write/graph build will proceed with embedding skipped until the vendored model assets are restored.`,
    );
  }
}

// Reports the active graph Cypher tier. Native (opt-in @ladybugdb/core) is
// preferred; the vendored wasm tier is the self-sufficient default. Pure-only
// (no Cypher) is a "warning": query/context/impact still work on the pure-TS
// port, but the `graph cypher` surface is unavailable until the vendored wasm
// assets are restored.
async function checkGraphCypher(vendorRoot: string): Promise<DoctorCheck> {
  const native = ladybugNativeAvailable();
  const wasm = await ladybugWasmAvailable(vendorRoot);
  if (native) {
    return pass("graph-cypher", `Cypher tier: native (@ladybugdb/core) active${wasm ? "; vendored wasm available as fallback" : ""}.`);
  }
  if (wasm) {
    return pass("graph-cypher", "Cypher tier: vendored wasm active (install @ladybugdb/core to enable the native turbo tier).");
  }
  return warning("graph-cypher", "Cypher tier: pure only — `graph cypher` is unavailable because the vendored LadybugDB wasm assets are missing or corrupt.");
}

// Reports "warning", not "fail": an un-migrated legacy root does not break
// any current operation (the runtime never reads or writes `~/.openwiki`
// itself), but the user's prior data is stranded there until `migrate` runs.
async function checkLegacyStorage(homeDir: string): Promise<DoctorCheck> {
  try {
    const legacyRoot = legacyStorageRoot(homeDir);
    const status = await lstatOrNull(legacyRoot);
    if (status === null) {
      return pass("legacy-storage", "No legacy ~/.openwiki storage root was found.");
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      return warning(
        "legacy-storage",
        "A legacy ~/.openwiki path exists but is not a safe directory; inspect it manually before running migrate.",
      );
    }

    const entries = await readdir(legacyRoot);
    const alreadyMigrated =
      entries.length === 0 || (entries.length === 1 && entries[0] === TOMBSTONE_FILE_NAME);
    if (alreadyMigrated) {
      return pass("legacy-storage", "Legacy ~/.openwiki storage has already been migrated.");
    }

    return warning(
      "legacy-storage",
      "An un-migrated legacy ~/.openwiki storage root was found; run the migrate operation to move it to ~/.memex.",
    );
  } catch {
    return warning("legacy-storage", "Legacy storage root could not be inspected safely.");
  }
}

async function collectFilesNoFollow(target: string, files: string[]): Promise<void> {
  const status = await lstatOrNull(target);
  if (status === null) {
    return;
  }
  if (status.isSymbolicLink()) {
    throw new MemexError(
      "SYMLINK_ESCAPE",
      "Doctor secret scan must not follow symbolic links.",
    );
  }
  if (status.isFile()) {
    files.push(target);
    return;
  }
  if (!status.isDirectory()) {
    throw new MemexError("INVALID_STATE", "Private data contains an invalid entry.");
  }

  const entries = await readdir(target);
  for (const entry of entries) {
    await collectFilesNoFollow(path.join(target, entry), files);
    if (files.length > MAX_DOCTOR_FILES) {
      return;
    }
  }
}

async function readJsonFileNoFollow(
  filePath: string,
  byteLimit: number,
): Promise<unknown> {
  const content = await readTextFileNoFollow(filePath, byteLimit);
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MemexError("INVALID_STATE", "JSON configuration is invalid.");
  }
  return parsed;
}

async function readTextFileNoFollow(
  filePath: string,
  byteLimit: number,
): Promise<string> {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > byteLimit) {
      throw new MemexError("INVALID_STATE", "Inspected file is invalid.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function lstatOrNull(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function pass(id: DoctorCheckId, message: string): DoctorCheck {
  return { id, status: "pass", message };
}

function warning(id: DoctorCheckId, message: string): DoctorCheck {
  return { id, status: "warning", message };
}

function fail(id: DoctorCheckId, message: string): DoctorCheck {
  return { id, status: "fail", message };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
