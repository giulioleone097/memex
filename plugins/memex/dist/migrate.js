import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemexError } from "./errors.js";
import { legacyStorageRoot } from "./paths.js";
const NEW_ROOT_NAME = ".memex";
// Exported so the doctor's legacy-storage check recognizes an
// already-migrated legacy root without duplicating the literal filename.
export const TOMBSTONE_FILE_NAME = "MIGRATED.md";
/**
 * One-time migration of the plugin's previous `~/.openwiki/` storage root
 * (from the `openwiki` distribution) to the current `~/.memex/` root.
 *
 * Branches:
 * - Legacy root missing               -> no-op (`migrated: false`, `entries: 0`).
 * - Legacy root is a symlink          -> `SYMLINK_ESCAPE` (existing confinement error).
 * - Legacy root already tombstoned    -> no-op; a prior run already relocated the data.
 * - New root already holds data       -> `MIGRATION_CONFLICT`; refuses to guess which
 *                                        root is authoritative.
 * - Otherwise                         -> atomic same-filesystem rename, with a
 *                                        copy-then-verify-then-remove fallback across
 *                                        filesystems, followed by a tombstone written
 *                                        into a freshly recreated legacy root.
 */
export async function runMigration(homeDir) {
    const from = legacyStorageRoot(homeDir);
    const to = path.join(homeDir, NEW_ROOT_NAME);
    const tombstonePath = path.join(from, TOMBSTONE_FILE_NAME);
    const legacyStatus = await lstatOrNull(from);
    if (legacyStatus === null) {
        return { migrated: false, from, to, entries: 0 };
    }
    if (legacyStatus.isSymbolicLink()) {
        throw new MemexError("SYMLINK_ESCAPE", "Legacy storage root must not be a symbolic link.");
    }
    if (!legacyStatus.isDirectory()) {
        throw new MemexError("INVALID_STATE", "Legacy storage root is not a directory.");
    }
    if (await isTombstonedOnly(from)) {
        return { migrated: false, from, to, entries: 0, tombstonePath };
    }
    const newStatus = await lstatOrNull(to);
    let targetExists = false;
    if (newStatus !== null) {
        if (newStatus.isSymbolicLink()) {
            throw new MemexError("SYMLINK_ESCAPE", "New storage root must not be a symbolic link.");
        }
        if (!newStatus.isDirectory()) {
            throw new MemexError("INVALID_STATE", "New storage root is not a directory.");
        }
        if ((await readdir(to)).length > 0) {
            throw new MemexError("MIGRATION_CONFLICT", "Both the legacy ~/.openwiki root and the new ~/.memex root contain data; resolve manually before migrating.");
        }
        targetExists = true;
    }
    const entries = (await readdir(from)).length;
    await moveDirectory(from, to, targetExists);
    await mkdir(from, { recursive: true, mode: 0o700 });
    await writeTombstone(tombstonePath, to);
    return { migrated: true, from, to, entries, tombstonePath };
}
async function moveDirectory(from, to, targetExists) {
    if (targetExists) {
        // Already confirmed empty above; some platforms refuse to rename onto
        // an existing directory even when it is empty, so clear it first.
        await rm(to, { recursive: true, force: true });
    }
    try {
        await rename(from, to);
        return;
    }
    catch (error) {
        if (!isCrossDeviceError(error)) {
            throw new MemexError("IO_FAILURE", "Unable to move legacy storage to the new root.");
        }
    }
    try {
        await cp(from, to, { recursive: true });
    }
    catch {
        throw new MemexError("IO_FAILURE", "Unable to copy legacy storage to the new root.");
    }
    const sourceCount = await countFilesRecursive(from);
    const destinationCount = await countFilesRecursive(to);
    if (sourceCount !== destinationCount) {
        throw new MemexError("IO_FAILURE", "Legacy storage copy could not be verified; the original was left untouched.");
    }
    await rm(from, { recursive: true, force: true });
}
async function countFilesRecursive(directory) {
    let total = 0;
    const dirEntries = await readdir(directory, { withFileTypes: true });
    for (const entry of dirEntries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            total += await countFilesRecursive(entryPath);
        }
        else {
            total += 1;
        }
    }
    return total;
}
async function isTombstonedOnly(from) {
    const entries = await readdir(from);
    return entries.length === 1 && entries[0] === TOMBSTONE_FILE_NAME;
}
async function writeTombstone(tombstonePath, newRoot) {
    const content = `# Migrated\n\nThis directory previously held Memex storage (from the plugin's earlier distribution as \`openwiki\`). It has moved to:\n\n\`${newRoot}\`\n\nThis file is a tombstone confirming the migration completed. Do not recreate files here; re-running \`migrate\` is a safe no-op.\n`;
    await writeFile(tombstonePath, content, "utf8");
}
function isCrossDeviceError(error) {
    return error instanceof Error && "code" in error && error.code === "EXDEV";
}
async function lstatOrNull(target) {
    try {
        return await lstat(target);
    }
    catch (error) {
        if (isFileNotFoundError(error)) {
            return null;
        }
        throw new MemexError("IO_FAILURE", "Unable to inspect a storage root.");
    }
}
function isFileNotFoundError(error) {
    return (error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
