// Loads the vendored LadybugDB wasm (nodejs variant) and adapts it to the
// uniform LadybugConnection surface. The wasm module is a CommonJS package
// loaded via createRequire; it spawns a Node worker thread that keeps the event
// loop alive, so it is treated as a per-process singleton: connections close
// individually, and the module itself is torn down once via shutdownLadybugWasm.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { defaultVendorRoot } from "./embedder.js";
import { MemexError } from "./errors.js";
import type { LadybugConnection } from "./ladybug-backend.js";
import type { CypherParam, CypherResult } from "./graph-index.js";

const GROUP = "ladybug-wasm";

interface LadybugWasmManifestFile { path: string; sha256: string; bytes: number; }
interface LadybugWasmManifest { entry: string; files: LadybugWasmManifestFile[]; }

interface LbugQueryResult {
  isSuccess(): boolean;
  getErrorMessage(): Promise<string>;
  getColumnNames(): Promise<string[]>;
  getAllObjects(): Promise<Record<string, unknown>[]>;
}
interface LbugPreparedStatement { readonly __brand?: "prepared"; }
interface LbugRawConnection {
  query(cypher: string): Promise<LbugQueryResult>;
  prepare(cypher: string): Promise<LbugPreparedStatement>;
  execute(statement: LbugPreparedStatement, params: Record<string, unknown>): Promise<LbugQueryResult>;
  close(): Promise<void>;
}
interface LbugDatabase { readonly __brand?: "database"; }
interface LbugModule {
  Database: new (databasePath?: string) => LbugDatabase;
  Connection: new (database: LbugDatabase) => LbugRawConnection;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

let cachedModule: LbugModule | undefined;
let verifiedRoot: string | undefined;

function groupRoot(vendorRoot: string): string {
  return path.join(vendorRoot, GROUP);
}

async function sha256File(absolute: string): Promise<string> {
  return createHash("sha256").update(await readFile(absolute)).digest("hex");
}

async function verifyAssets(root: string): Promise<LadybugWasmManifest> {
  let manifest: LadybugWasmManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, "MANIFEST.json"), "utf8")) as LadybugWasmManifest;
  } catch {
    throw new MemexError("MODEL_ASSET_MISSING", "Ladybug wasm manifest is missing or invalid.");
  }
  if (!Array.isArray(manifest.files) || typeof manifest.entry !== "string") {
    throw new MemexError("MODEL_ASSET_CORRUPT", "Ladybug wasm manifest is malformed.");
  }
  for (const file of manifest.files) {
    const absolute = path.join(root, file.path);
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch {
      throw new MemexError("MODEL_ASSET_MISSING", `Ladybug wasm asset is missing: ${file.path}.`);
    }
    if (size !== file.bytes) throw new MemexError("MODEL_ASSET_CORRUPT", `Ladybug wasm asset size mismatch: ${file.path}.`);
    if ((await sha256File(absolute)) !== file.sha256.toLowerCase()) {
      throw new MemexError("MODEL_ASSET_CORRUPT", `Ladybug wasm asset checksum mismatch: ${file.path}.`);
    }
  }
  return manifest;
}

async function loadModule(vendorRoot: string): Promise<LbugModule> {
  if (cachedModule !== undefined && verifiedRoot === vendorRoot) return cachedModule;
  const root = groupRoot(vendorRoot);
  const manifest = await verifyAssets(root);
  const entryPath = path.join(root, manifest.entry);
  let required: unknown;
  try {
    const require = createRequire(import.meta.url);
    required = require(entryPath);
  } catch (error) {
    throw new MemexError("MODEL_ASSET_CORRUPT", `Failed to load the Ladybug wasm module: ${(error as Error).message}`);
  }
  const mod = required as LbugModule;
  if (typeof mod.Database !== "function" || typeof mod.Connection !== "function") {
    throw new MemexError("MODEL_ASSET_CORRUPT", "Ladybug wasm module does not expose Database/Connection.");
  }
  if (mod.init) await mod.init();
  cachedModule = mod;
  verifiedRoot = vendorRoot;
  return mod;
}

export interface OpenWasmOptions {
  vendorRoot?: string;
  /** ":memory:" (default) or an on-disk path for a persistent database. */
  databasePath?: string;
}

/**
 * Opens a LadybugConnection backed by the vendored wasm engine. Throws a
 * MemexError if the assets are missing/corrupt or the module cannot load — the
 * tier resolver catches this and degrades to pure with the message as the reason.
 * The returned connection's close() releases only the connection; call
 * shutdownLadybugWasm() once at process teardown to terminate the worker thread.
 */
export async function openLadybugWasmConnection(options: OpenWasmOptions = {}): Promise<LadybugConnection> {
  const vendorRoot = options.vendorRoot ?? defaultVendorRoot();
  const mod = await loadModule(vendorRoot);
  const database = new mod.Database(options.databasePath ?? ":memory:");
  const connection = new mod.Connection(database);

  const run = async (raw: LbugQueryResult): Promise<CypherResult> => {
    if (!raw.isSuccess()) throw new Error(await raw.getErrorMessage());
    const [columns, rows] = await Promise.all([raw.getColumnNames(), raw.getAllObjects()]);
    return { columns, rows, truncated: false };
  };

  return {
    async query(cypher: string, params?: Record<string, CypherParam>): Promise<CypherResult> {
      if (params === undefined) return run(await connection.query(cypher));
      const statement = await connection.prepare(cypher);
      return run(await connection.execute(statement, params));
    },
    async close(): Promise<void> {
      await connection.close();
    },
  };
}

/** Terminates the wasm module's worker thread. Idempotent; safe if never opened. */
export async function shutdownLadybugWasm(): Promise<void> {
  const mod = cachedModule;
  cachedModule = undefined;
  verifiedRoot = undefined;
  if (mod?.close) await mod.close();
}
