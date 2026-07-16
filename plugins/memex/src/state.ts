import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import { atomicWriteFile } from "./atomic.js";
import { parseWikiState, type WikiStateV1 } from "./contracts.js";
import { MemexError } from "./errors.js";
import type { WikiLocation } from "./paths.js";

const MAX_STATE_BYTES = 1024 * 1024;

export async function readState(location: WikiLocation): Promise<WikiStateV1> {
  let handle;
  try {
    handle = await open(
      location.statePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_STATE_BYTES) {
      throw new MemexError("INVALID_STATE", "Wiki state file is invalid.");
    }
    const content = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new MemexError("INVALID_STATE", "Wiki state is not valid JSON.");
    }
    const state = parseWikiState(parsed);
    if (
      state.mode !== location.mode ||
      state.workspaceId !== location.workspaceId ||
      state.wikiRoot !== location.wikiRoot
    ) {
      throw new MemexError(
        "INVALID_STATE",
        "Wiki state does not match the resolved wiki location.",
      );
    }
    return state;
  } catch (error) {
    if (error instanceof MemexError) {
      throw error;
    }
    if (isFileNotFoundError(error)) {
      throw new MemexError("NOT_INITIALIZED", "Memex is not initialized.");
    }
    if (isSymbolicLinkError(error)) {
      throw new MemexError(
        "SYMLINK_ESCAPE",
        "Wiki state path must not be a symbolic link.",
      );
    }
    throw new MemexError("IO_FAILURE", "Unable to read wiki state.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeState(
  location: WikiLocation,
  state: WikiStateV1,
): Promise<void> {
  const validated = parseWikiState(state);
  await atomicWriteFile(
    location.statePath,
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

export async function tryReadState(
  location: WikiLocation,
): Promise<WikiStateV1 | null> {
  try {
    return await readState(location);
  } catch (error) {
    if (error instanceof MemexError && error.code === "NOT_INITIALIZED") {
      return null;
    }
    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSymbolicLinkError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOOP";
}
