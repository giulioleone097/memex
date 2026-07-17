// Loads the vendored LadybugDB wasm (nodejs variant) and adapts it to the
// uniform LadybugConnection surface. The wasm module is a CommonJS package
// loaded via createRequire; it spawns a Node worker thread that keeps the event
// loop alive, so it is treated as a per-process singleton: connections close
// individually, and the module itself is torn down once via shutdownLadybugWasm.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { defaultVendorRoot, loadVendorManifest } from "./embedder.js";
import { MemexError } from "./errors.js";
import { LadybugCypherEngine, syncGraphToLadybug, type LadybugConnection } from "./ladybug-backend.js";
import type { CypherParam, CypherResult, CypherTierResolution } from "./graph-index.js";
import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";

// Paths (relative to the shared vendor root) of the vendored nodejs variant.
const WASM_ENTRY = "ladybug-wasm/nodejs/index.js";
const WASM_BINARY = "ladybug-wasm/nodejs/lbug/lbug_wasm.wasm";

interface LbugQueryResult {
  isSuccess(): boolean;
  getErrorMessage(): Promise<string>;
  getColumnNames(): Promise<string[]>;
  getAllObjects(): Promise<Record<string, unknown>[]>;
  hasNext(): boolean;
  getNext(): Promise<unknown[]>;
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
let inflightLoad: Promise<LbugModule> | undefined;

async function sha256File(absolute: string): Promise<string> {
  return createHash("sha256").update(await readFile(absolute)).digest("hex");
}

// Verifies the two integrity-critical vendored files (the CommonJS entry and the
// wasm binary) against the shared vendor manifest before loading. The runtime
// dependency files under node_modules are covered by the shared manifest (and the
// vendor stray-file test) and fail loudly at require() if tampered with, so they
// are not re-hashed on every open.
async function verifyCriticalAssets(vendorRoot: string): Promise<void> {
  const manifest = await loadVendorManifest(vendorRoot);
  for (const relativePath of [WASM_ENTRY, WASM_BINARY]) {
    const entry = manifest.assets.find((candidate) => candidate.path === relativePath);
    if (entry?.sha256 === undefined) {
      throw new MemexError("MODEL_ASSET_MISSING", `Ladybug wasm manifest has no entry for ${relativePath}.`);
    }
    const absolute = path.join(vendorRoot, relativePath);
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch {
      throw new MemexError("MODEL_ASSET_MISSING", `Ladybug wasm asset is missing: ${relativePath}.`);
    }
    if (size !== entry.bytes) throw new MemexError("MODEL_ASSET_CORRUPT", `Ladybug wasm asset size mismatch: ${relativePath}.`);
    if ((await sha256File(absolute)) !== entry.sha256.toLowerCase()) {
      throw new MemexError("MODEL_ASSET_CORRUPT", `Ladybug wasm asset checksum mismatch: ${relativePath}.`);
    }
  }
}

async function loadModule(vendorRoot: string): Promise<LbugModule> {
  if (cachedModule !== undefined && verifiedRoot === vendorRoot) return cachedModule;
  // Share a single in-flight load between concurrent callers so the module is
  // verified, required, and init()'d exactly once per process.
  if (inflightLoad !== undefined && verifiedRoot === vendorRoot) return inflightLoad;
  verifiedRoot = vendorRoot;
  inflightLoad = (async (): Promise<LbugModule> => {
    await verifyCriticalAssets(vendorRoot);
    const entryPath = path.join(vendorRoot, WASM_ENTRY);
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
    return mod;
  })();
  try {
    return await inflightLoad;
  } catch (error) {
    verifiedRoot = undefined;
    inflightLoad = undefined;
    throw error;
  }
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

  const run = async (raw: LbugQueryResult, maxRows?: number): Promise<CypherResult> => {
    if (!raw.isSuccess()) throw new Error(await raw.getErrorMessage());
    const columns = await raw.getColumnNames();
    if (maxRows === undefined) {
      return { columns, rows: await raw.getAllObjects(), truncated: false };
    }
    // Cursor read bounded by maxRows so an unbounded (e.g. cartesian) result is
    // never fully materialized. wasm getNext() yields a positional row.
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    while (raw.hasNext()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const positional = await raw.getNext();
      const row: Record<string, unknown> = {};
      columns.forEach((column, columnIndex) => { row[column] = positional[columnIndex]; });
      rows.push(row);
    }
    return { columns, rows, truncated };
  };

  return {
    async query(cypher: string, params?: Record<string, CypherParam>, maxRows?: number): Promise<CypherResult> {
      if (params === undefined) return run(await connection.query(cypher), maxRows);
      const statement = await connection.prepare(cypher);
      return run(await connection.execute(statement, params), maxRows);
    },
    async close(): Promise<void> {
      await connection.close();
    },
  };
}

/**
 * Builds the wasm Cypher tier: opens a connection, syncs the graph snapshot into
 * it, and returns the CypherCapable engine. Throws on failure (the resolver
 * catches and degrades to pure). `close()` releases the connection only; call
 * shutdownLadybugWasm() at process teardown.
 */
export async function openWasmTier(
  graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] },
  databasePath?: string,
): Promise<CypherTierResolution> {
  const connection = await openLadybugWasmConnection(databasePath === undefined ? {} : { databasePath });
  try {
    await syncGraphToLadybug(connection, graph);
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  const engine = new LadybugCypherEngine(connection);
  return { cypher: engine, close: () => engine.close() };
}

/**
 * Reports whether the vendored wasm Cypher tier is usable, verifying the two
 * integrity-critical files without loading the module (no worker is spawned) —
 * safe for the doctor check.
 */
export async function ladybugWasmAvailable(vendorRoot: string = defaultVendorRoot()): Promise<boolean> {
  try {
    await verifyCriticalAssets(vendorRoot);
    return true;
  } catch {
    return false;
  }
}

/** Terminates the wasm module's worker thread. Idempotent; safe if never opened. */
export async function shutdownLadybugWasm(): Promise<void> {
  const mod = cachedModule;
  cachedModule = undefined;
  verifiedRoot = undefined;
  inflightLoad = undefined;
  if (mod?.close) await mod.close();
}
