import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { MemexError } from "./errors.js";

const LOCK_FILE_NAME = ".memex.lock";

export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(filePath);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
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
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof MemexError) {
      throw error;
    }
    throw new MemexError("IO_FAILURE", "Atomic file write failed.");
  }
}

export async function withWikiLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new MemexError("IO_FAILURE", "Unable to resolve the lock root.");
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
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isAlreadyExistsError(error)) {
      await rejectExistingLock(lockPath);
    }
    throw new MemexError("IO_FAILURE", "Unable to acquire the Memex lock.");
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await releaseOwnedLock(lockPath, serializedLock);
  }
}

async function rejectExistingLock(lockPath: string): Promise<never> {
  try {
    if ((await lstat(lockPath)).isSymbolicLink()) {
      throw new MemexError(
        "SYMLINK_ESCAPE",
        "Memex lock path must not be a symbolic link.",
      );
    }
  } catch (error) {
    if (error instanceof MemexError) {
      throw error;
    }
  }

  throw new MemexError(
    "LOCKED",
    "Memex is locked; lock ownership cannot be inferred safely.",
  );
}

async function releaseOwnedLock(
  lockPath: string,
  serializedLock: string,
): Promise<void> {
  let current: string;
  try {
    current = await readFile(lockPath, "utf8");
  } catch {
    throw new MemexError(
      "LOCKED",
      "Memex lock ownership changed before release.",
    );
  }

  if (current !== serializedLock) {
    throw new MemexError(
      "LOCKED",
      "Memex lock ownership changed before release.",
    );
  }

  try {
    await unlink(lockPath);
  } catch {
    throw new MemexError("IO_FAILURE", "Unable to release the Memex lock.");
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new MemexError(
        "SYMLINK_ESCAPE",
        "Refused to replace a symbolic-link target.",
      );
    }
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EPERM")
  );
}

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
      if (!isAlreadyExists(error)) throw new MemexError("IO_FAILURE", "Unable to acquire the write lock.");
      if (await recoverStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) throw new MemexError("LOCKED", "Store writer is busy.");
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
    if (error instanceof MemexError) throw error;
    throw new MemexError("IO_FAILURE", "Atomic binary file write failed.");
  }
}

async function recoverStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let serialized: string;
  try {
    const details = await lstat(lockPath);
    if (details.isSymbolicLink() || !details.isFile()) throw new MemexError("SYMLINK_ESCAPE", "Writer lock must be a regular file.");
    serialized = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error instanceof MemexError) throw error;
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
    if (await readFile(lockPath, "utf8") !== serialized) throw new MemexError("LOCKED", "Writer lock ownership changed before release.");
    await unlink(lockPath);
  } catch (error) {
    if (error instanceof MemexError) throw error;
    throw new MemexError("IO_FAILURE", "Unable to release the writer lock.");
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
  if (details.isSymbolicLink() || !details.isDirectory()) throw new MemexError("SYMLINK_ESCAPE", "Lock directory must not be a symbolic link.");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { globalThis.setTimeout(resolve, milliseconds); });
}
