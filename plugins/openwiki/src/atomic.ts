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

import { OpenWikiError } from "./errors.js";

const LOCK_FILE_NAME = ".openwiki.lock";

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
    if (error instanceof OpenWikiError) {
      throw error;
    }
    throw new OpenWikiError("IO_FAILURE", "Atomic file write failed.");
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
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isAlreadyExistsError(error)) {
      await rejectExistingLock(lockPath);
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to acquire the OpenWiki lock.");
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
      throw new OpenWikiError(
        "SYMLINK_ESCAPE",
        "OpenWiki lock path must not be a symbolic link.",
      );
    }
  } catch (error) {
    if (error instanceof OpenWikiError) {
      throw error;
    }
  }

  throw new OpenWikiError(
    "LOCKED",
    "OpenWiki is locked; lock ownership cannot be inferred safely.",
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
    throw new OpenWikiError(
      "LOCKED",
      "OpenWiki lock ownership changed before release.",
    );
  }

  if (current !== serializedLock) {
    throw new OpenWikiError(
      "LOCKED",
      "OpenWiki lock ownership changed before release.",
    );
  }

  try {
    await unlink(lockPath);
  } catch {
    throw new OpenWikiError("IO_FAILURE", "Unable to release the OpenWiki lock.");
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new OpenWikiError(
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
