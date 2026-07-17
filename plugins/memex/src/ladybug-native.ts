// Optional native LadybugDB tier (@ladybugdb/core prebuilt binaries). Declared
// as an optionalDependency: absence (or an unsupported platform) yields null and
// the resolver falls through to the vendored wasm tier. The native API differs
// from the wasm one (getAll vs getAllObjects, plain-number INT64, no worker to
// shut down), which is exactly what the LadybugConnection abstraction absorbs.
import { createRequire } from "node:module";

import { LadybugCypherEngine, syncGraphToLadybug, type LadybugConnection } from "./ladybug-backend.js";
import type { CypherParam, CypherResult, CypherTierResolution } from "./graph-index.js";
import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";

interface NativeQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
  getColumnNames(): Promise<string[]> | string[];
  hasNext(): boolean;
  getNext(): Promise<Record<string, unknown>>;
  close?(): void;
}
interface NativePreparedStatement { readonly __brand?: "native-prepared"; }
interface NativeConnection {
  query(cypher: string): Promise<NativeQueryResult>;
  prepare(cypher: string): Promise<NativePreparedStatement>;
  execute(statement: NativePreparedStatement, params: Record<string, unknown>): Promise<NativeQueryResult>;
  close(): Promise<void>;
}
interface NativeDatabase { close(): Promise<void>; }
interface NativeModule {
  Database: new (databasePath?: string) => NativeDatabase;
  Connection: new (database: NativeDatabase) => NativeConnection;
}

export interface OpenNativeOptions {
  /** ":memory:" (default) or an on-disk path. */
  databasePath?: string;
}

/**
 * Reports whether the optional native `@ladybugdb/core` dependency is resolvable
 * for this platform, without loading the addon. Safe for the doctor check.
 */
export function ladybugNativeAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("@ladybugdb/core");
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a native LadybugConnection, or returns null when `@ladybugdb/core` is
 * not installed / has no prebuilt binary for this platform (the expected,
 * non-exceptional case for the opt-in tier).
 */
export function openLadybugNativeConnection(options: OpenNativeOptions = {}): LadybugConnection | null {
  let mod: NativeModule;
  try {
    const require = createRequire(import.meta.url);
    mod = require("@ladybugdb/core") as NativeModule;
  } catch {
    return null;
  }
  let database: NativeDatabase;
  let connection: NativeConnection;
  try {
    database = new mod.Database(options.databasePath ?? ":memory:");
    connection = new mod.Connection(database);
  } catch {
    return null;
  }

  const shape = async (result: NativeQueryResult, maxRows?: number): Promise<CypherResult> => {
    const columns = await Promise.resolve(result.getColumnNames());
    if (maxRows === undefined) {
      const rows = await result.getAll();
      if (result.close) result.close();
      return { columns, rows, truncated: false };
    }
    // Cursor read bounded by maxRows. Native getNext() yields a row object.
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    while (result.hasNext()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(await result.getNext());
    }
    if (result.close) result.close();
    return { columns, rows, truncated };
  };

  return {
    async query(cypher: string, params?: Record<string, CypherParam>, maxRows?: number): Promise<CypherResult> {
      const result = params === undefined
        ? await connection.query(cypher)
        : await connection.execute(await connection.prepare(cypher), params);
      return shape(result, maxRows);
    },
    async close(): Promise<void> {
      await connection.close();
      await database.close();
    },
  };
}

/**
 * Builds the native Cypher tier by opening a native connection and syncing the
 * graph snapshot. Returns null when the native dependency is absent (resolver
 * degrades to wasm); throws only on an unexpected sync/engine failure.
 */
export async function openNativeTier(
  graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] },
  databasePath?: string,
): Promise<CypherTierResolution | null> {
  const connection = openLadybugNativeConnection(databasePath === undefined ? {} : { databasePath });
  if (!connection) return null;
  try {
    await syncGraphToLadybug(connection, graph);
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  const engine = new LadybugCypherEngine(connection);
  return { cypher: engine, close: () => engine.close() };
}
