// Optional native LadybugDB tier (@ladybugdb/core prebuilt binaries). Declared
// as an optionalDependency: absence (or an unsupported platform) yields null and
// the resolver falls through to the vendored wasm tier. The native API differs
// from the wasm one (getAll vs getAllObjects, plain-number INT64, no worker to
// shut down), which is exactly what the LadybugConnection abstraction absorbs.
import { createRequire } from "node:module";
import { LadybugCypherEngine, syncGraphToLadybug } from "./ladybug-backend.js";
/**
 * Reports whether the optional native `@ladybugdb/core` dependency is resolvable
 * for this platform, without loading the addon. Safe for the doctor check.
 */
export function ladybugNativeAvailable() {
    try {
        createRequire(import.meta.url).resolve("@ladybugdb/core");
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Opens a native LadybugConnection, or returns null when `@ladybugdb/core` is
 * not installed / has no prebuilt binary for this platform (the expected,
 * non-exceptional case for the opt-in tier).
 */
export function openLadybugNativeConnection(options = {}) {
    let mod;
    try {
        const require = createRequire(import.meta.url);
        mod = require("@ladybugdb/core");
    }
    catch {
        return null;
    }
    let database;
    let connection;
    try {
        database = new mod.Database(options.databasePath ?? ":memory:");
        connection = new mod.Connection(database);
    }
    catch {
        return null;
    }
    const shape = async (result) => {
        const [rows, columns] = await Promise.all([result.getAll(), Promise.resolve(result.getColumnNames())]);
        if (result.close)
            result.close();
        return { columns, rows, truncated: false };
    };
    return {
        async query(cypher, params) {
            const result = params === undefined
                ? await connection.query(cypher)
                : await connection.execute(await connection.prepare(cypher), params);
            return shape(result);
        },
        async close() {
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
export async function openNativeTier(graph, databasePath) {
    const connection = openLadybugNativeConnection(databasePath === undefined ? {} : { databasePath });
    if (!connection)
        return null;
    try {
        await syncGraphToLadybug(connection, graph);
    }
    catch (error) {
        await connection.close().catch(() => undefined);
        throw error;
    }
    const engine = new LadybugCypherEngine(connection);
    return { cypher: engine, close: () => engine.close() };
}
