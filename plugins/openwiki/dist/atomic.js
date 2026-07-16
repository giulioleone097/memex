import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, } from "node:fs/promises";
import path from "node:path";
import { OpenWikiError } from "./errors.js";
const LOCK_FILE_NAME = ".openwiki.lock";
export async function atomicWriteFile(filePath, content) {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNotSymlink(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await assertNotSymlink(filePath);
        await rename(temporaryPath, filePath);
        await syncDirectory(directory);
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        if (error instanceof OpenWikiError) {
            throw error;
        }
        throw new OpenWikiError("IO_FAILURE", "Atomic file write failed.");
    }
}
export async function withWikiLock(root, operation) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let canonicalRoot;
    try {
        canonicalRoot = await realpath(root);
    }
    catch {
        throw new OpenWikiError("IO_FAILURE", "Unable to resolve the lock root.");
    }
    const lockPath = path.join(canonicalRoot, LOCK_FILE_NAME);
    const token = randomUUID();
    const serializedLock = `${JSON.stringify({
        version: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token,
    })}\n`;
    let handle;
    try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(serializedLock, "utf8");
        await handle.sync();
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        if (isAlreadyExistsError(error)) {
            await rejectExistingLock(lockPath);
        }
        throw new OpenWikiError("IO_FAILURE", "Unable to acquire the OpenWiki lock.");
    }
    try {
        return await operation();
    }
    finally {
        await handle.close().catch(() => undefined);
        await releaseOwnedLock(lockPath, serializedLock);
    }
}
async function rejectExistingLock(lockPath) {
    try {
        if ((await lstat(lockPath)).isSymbolicLink()) {
            throw new OpenWikiError("SYMLINK_ESCAPE", "OpenWiki lock path must not be a symbolic link.");
        }
    }
    catch (error) {
        if (error instanceof OpenWikiError) {
            throw error;
        }
    }
    throw new OpenWikiError("LOCKED", "OpenWiki is locked; lock ownership cannot be inferred safely.");
}
async function releaseOwnedLock(lockPath, serializedLock) {
    let current;
    try {
        current = await readFile(lockPath, "utf8");
    }
    catch {
        throw new OpenWikiError("LOCKED", "OpenWiki lock ownership changed before release.");
    }
    if (current !== serializedLock) {
        throw new OpenWikiError("LOCKED", "OpenWiki lock ownership changed before release.");
    }
    try {
        await unlink(lockPath);
    }
    catch {
        throw new OpenWikiError("IO_FAILURE", "Unable to release the OpenWiki lock.");
    }
}
async function assertNotSymlink(filePath) {
    try {
        if ((await lstat(filePath)).isSymbolicLink()) {
            throw new OpenWikiError("SYMLINK_ESCAPE", "Refused to replace a symbolic-link target.");
        }
    }
    catch (error) {
        if (isFileNotFoundError(error)) {
            return;
        }
        throw error;
    }
}
async function syncDirectory(directory) {
    let handle;
    try {
        handle = await open(directory, "r");
        await handle.sync();
    }
    catch (error) {
        if (!isUnsupportedDirectorySyncError(error)) {
            throw error;
        }
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function isAlreadyExistsError(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function isFileNotFoundError(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isUnsupportedDirectorySyncError(error) {
    return (error instanceof Error &&
        "code" in error &&
        (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EPERM"));
}
const DEFAULT_WAIT_MS = 50;
const DEFAULT_STALE_MS = 5 * 60 * 1000;
export async function withFileWriteLock(lockPath, operation, options = {}) {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const directory = path.dirname(lockPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(directory);
    const serialized = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() })}\n`;
    const deadline = Date.now() + waitMs;
    let handle;
    while (handle === undefined) {
        try {
            handle = await open(lockPath, "wx", 0o600);
            await handle.writeFile(serialized, "utf8");
            await handle.sync();
        }
        catch (error) {
            await handle?.close().catch(() => undefined);
            handle = undefined;
            if (!isAlreadyExists(error))
                throw new OpenWikiError("IO_FAILURE", "Unable to acquire the write lock.");
            if (await recoverStaleLock(lockPath, staleMs))
                continue;
            if (Date.now() >= deadline)
                throw new OpenWikiError("LOCKED", "Store writer is busy.");
            await wait(10);
        }
    }
    try {
        return await operation();
    }
    finally {
        await handle.close().catch(() => undefined);
        await releaseLock(lockPath, serialized);
    }
}
export async function atomicWriteBinaryFile(filePath, content) {
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
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        if (error instanceof OpenWikiError)
            throw error;
        throw new OpenWikiError("IO_FAILURE", "Atomic binary file write failed.");
    }
}
async function recoverStaleLock(lockPath, staleMs) {
    let serialized;
    try {
        const details = await lstat(lockPath);
        if (details.isSymbolicLink() || !details.isFile())
            throw new OpenWikiError("SYMLINK_ESCAPE", "Writer lock must be a regular file.");
        serialized = await readFile(lockPath, "utf8");
    }
    catch (error) {
        if (error instanceof OpenWikiError)
            throw error;
        return false;
    }
    const lock = parseLock(serialized);
    if (lock === undefined || Date.now() - lock.createdAt < staleMs || processAlive(lock.pid))
        return false;
    try {
        if (await readFile(lockPath, "utf8") !== serialized)
            return false;
        await unlink(lockPath);
        return true;
    }
    catch {
        return false;
    }
}
async function releaseLock(lockPath, serialized) {
    try {
        if (await readFile(lockPath, "utf8") !== serialized)
            throw new OpenWikiError("LOCKED", "Writer lock ownership changed before release.");
        await unlink(lockPath);
    }
    catch (error) {
        if (error instanceof OpenWikiError)
            throw error;
        throw new OpenWikiError("IO_FAILURE", "Unable to release the writer lock.");
    }
}
function parseLock(serialized) {
    try {
        const value = JSON.parse(serialized);
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const record = value;
        if (record.schemaVersion !== 1 || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.createdAt !== "string" || typeof record.token !== "string")
            return undefined;
        const createdAt = Date.parse(record.createdAt);
        return Number.isFinite(createdAt) ? { pid: record.pid, createdAt } : undefined;
    }
    catch {
        return undefined;
    }
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
}
async function assertRegularDirectory(directory) {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory())
        throw new OpenWikiError("SYMLINK_ESCAPE", "Lock directory must not be a symbolic link.");
}
function isAlreadyExists(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function wait(milliseconds) {
    return new Promise((resolve) => { globalThis.setTimeout(resolve, milliseconds); });
}
