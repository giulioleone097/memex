import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { atomicWriteFile } from "./atomic.js";
import { parseWikiState, parseWikiStateFileV2, } from "./contracts.js";
import { MemexError } from "./errors.js";
const MAX_STATE_BYTES = 1024 * 1024;
export async function readState(location) {
    return (await readHydratedState(location)).state;
}
/** Persist a legacy v1 state as portable v2 at an explicit locked mutation boundary. */
export async function readStateForWrite(location) {
    const hydrated = await readHydratedState(location);
    if (hydrated.needsUpgrade) {
        await writePortableState(location.statePath, hydrated.state);
    }
    return hydrated.state;
}
async function readHydratedState(location) {
    const document = await readStateDocument(location.statePath);
    if (isSchemaVersion(document, 2)) {
        return {
            state: hydratePortableState(location, parseWikiStateFileV2(document)),
            needsUpgrade: false,
        };
    }
    const legacy = parseWikiState(document);
    if (legacy.mode !== location.mode) {
        throw new MemexError("INVALID_STATE", "Wiki state does not match the resolved wiki mode.");
    }
    return {
        state: {
            ...legacy,
            workspaceId: location.workspaceId,
            wikiRoot: location.wikiRoot,
        },
        needsUpgrade: true,
    };
}
export async function writeState(location, state) {
    const validated = parseWikiState(state);
    assertRuntimeIdentity(location, validated);
    await writePortableState(location.statePath, validated);
}
export async function tryReadState(location) {
    try {
        return await readState(location);
    }
    catch (error) {
        if (error instanceof MemexError && error.code === "NOT_INITIALIZED") {
            return null;
        }
        throw error;
    }
}
export async function tryReadStateForWrite(location) {
    try {
        return await readStateForWrite(location);
    }
    catch (error) {
        if (error instanceof MemexError && error.code === "NOT_INITIALIZED") {
            return null;
        }
        throw error;
    }
}
async function readStateDocument(filePath) {
    let handle;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const fileStat = await handle.stat();
        if (!fileStat.isFile() || fileStat.size > MAX_STATE_BYTES) {
            throw new MemexError("INVALID_STATE", "Wiki state file is invalid.");
        }
        const content = await handle.readFile("utf8");
        try {
            return JSON.parse(content);
        }
        catch {
            throw new MemexError("INVALID_STATE", "Wiki state is not valid JSON.");
        }
    }
    catch (error) {
        if (error instanceof MemexError) {
            throw error;
        }
        if (isFileNotFoundError(error)) {
            throw new MemexError("NOT_INITIALIZED", "Memex is not initialized.");
        }
        if (isSymbolicLinkError(error)) {
            throw new MemexError("SYMLINK_ESCAPE", "Wiki state path must not be a symbolic link.");
        }
        throw new MemexError("IO_FAILURE", "Unable to read wiki state.");
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function hydratePortableState(location, portable) {
    if (portable.mode !== location.mode) {
        throw new MemexError("INVALID_STATE", "Wiki state does not match the resolved wiki mode.");
    }
    return {
        ...portable,
        schemaVersion: 1,
        workspaceId: location.workspaceId,
        wikiRoot: location.wikiRoot,
    };
}
function assertRuntimeIdentity(location, state) {
    if (state.mode !== location.mode ||
        state.workspaceId !== location.workspaceId ||
        state.wikiRoot !== location.wikiRoot) {
        throw new MemexError("INVALID_STATE", "Wiki state does not match the resolved wiki location.");
    }
}
async function writePortableState(filePath, state) {
    const portable = {
        schemaVersion: 2,
        mode: state.mode,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        contentHash: state.contentHash,
        ...(state.lastGitHead === undefined ? {} : { lastGitHead: state.lastGitHead }),
        lastRun: state.lastRun,
    };
    const validated = parseWikiStateFileV2(portable);
    await atomicWriteFile(filePath, `${JSON.stringify(validated, null, 2)}\n`);
}
function isSchemaVersion(value, schemaVersion) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Reflect.get(value, "schemaVersion") === schemaVersion);
}
function isFileNotFoundError(error) {
    return (error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
function isSymbolicLinkError(error) {
    return error instanceof Error && "code" in error && error.code === "ELOOP";
}
