import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WikiMode } from "./contracts.js";
import { MemexError } from "./errors.js";

export interface ResolveWikiLocationOptions {
  mode: WikiMode;
  root?: string;
  homeDir?: string;
}

export interface WikiLocation {
  mode: WikiMode;
  workspaceId: string;
  workspaceRoot?: string;
  wikiRoot: string;
  statePath: string;
  dataRoot: string;
}

// The plugin was previously distributed as `openwiki` and stored all data
// under `~/.openwiki/`. This helper names that legacy root so `migrate.ts`
// and the doctor's legacy-storage check can detect and relocate it without
// hardcoding the literal path in more than one place. It intentionally does
// not participate in `resolveWikiLocation`: the legacy root is a one-time
// migration source, never a location the runtime resolves into for reads
// or writes.
export function legacyStorageRoot(homeDir: string): string {
  return path.join(homeDir, ".openwiki");
}

// Centralized so every caller (dispatch, doctor, migration) resolves the
// host home directory identically; Windows sets USERPROFILE rather than
// HOME, and tests isolate storage by overriding these environment
// variables rather than the real process home directory.
export function hostHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export async function resolveWikiLocation(
  options: ResolveWikiLocationOptions,
): Promise<WikiLocation> {
  if (options.mode === "code") {
    if (!options.root) {
      throw new MemexError(
        "INVALID_ARGUMENT",
        "Code mode requires a repository root.",
      );
    }

    const workspaceRoot = await resolveExistingDirectory(options.root);
    const wikiRoot = await resolveProspectivePath(workspaceRoot, "memex");
    const homeDir = await resolveExistingDirectory(options.homeDir ?? os.homedir());
    const workspaceId = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex");

    return {
      mode: "code",
      workspaceId,
      workspaceRoot,
      wikiRoot,
      statePath: path.join(wikiRoot, ".last-update.json"),
      dataRoot: await resolveProspectivePath(
        homeDir,
        path.join(".memex", "data", workspaceId),
      ),
    };
  }

  const homeDir = await resolveExistingDirectory(options.homeDir ?? os.homedir());
  const privateRoot = await resolveProspectivePath(homeDir, ".memex");
  const wikiRoot = await resolveProspectivePath(privateRoot, "wiki");
  const dataRoot = await resolveProspectivePath(
    homeDir,
    path.join(".memex", "data", "personal"),
  );

  return {
    mode: "personal",
    workspaceId: "personal",
    wikiRoot,
    statePath: path.join(privateRoot, ".last-update.json"),
    dataRoot,
  };
}

export async function resolveConfinedMarkdownPath(
  location: WikiLocation,
  page: string,
): Promise<string> {
  validatePagePath(page);

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(location.wikiRoot);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new MemexError("NOT_INITIALIZED", "Memex is not initialized.");
    }
    throw new MemexError("IO_FAILURE", "Unable to resolve the wiki root.");
  }

  const candidate = path.join(canonicalRoot, ...page.split("/"));
  return resolveProspectivePath(canonicalRoot, path.relative(canonicalRoot, candidate));
}

function validatePagePath(page: string): void {
  if (
    page.length === 0 ||
    page.includes("\0") ||
    page.includes("\\") ||
    path.isAbsolute(page) ||
    path.win32.isAbsolute(page)
  ) {
    throw new MemexError(
      "PATH_OUTSIDE_ROOT",
      "Wiki page path must be relative to the wiki root.",
    );
  }

  const segments = page.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new MemexError(
      "PATH_OUTSIDE_ROOT",
      "Wiki page path must stay inside the wiki root.",
    );
  }

  if (!page.endsWith(".md")) {
    throw new MemexError(
      "INVALID_ARGUMENT",
      "Wiki pages must use the .md extension.",
    );
  }
}

async function resolveExistingDirectory(input: string): Promise<string> {
  try {
    const resolved = await realpath(path.resolve(input));
    if (!(await stat(resolved)).isDirectory()) {
      throw new MemexError(
        "NOT_FOUND",
        "Configured root directory was not found.",
      );
    }
    return resolved;
  } catch {
    throw new MemexError("NOT_FOUND", "Configured root directory was not found.");
  }
}

async function resolveProspectivePath(
  canonicalRoot: string,
  relativePath: string,
): Promise<string> {
  const segments = relativePath.split(path.sep).filter((segment) => segment.length > 0);
  let current = canonicalRoot;

  for (const segment of segments) {
    const candidate = path.join(current, segment);
    try {
      const resolved = await realpath(candidate);
      assertInside(canonicalRoot, resolved);
      current = resolved;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        current = candidate;
        continue;
      }
      if (error instanceof MemexError) {
        throw error;
      }
      throw new MemexError("IO_FAILURE", "Unable to resolve a confined path.");
    }
  }

  assertInside(canonicalRoot, current);
  return current;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }

  throw new MemexError(
    "SYMLINK_ESCAPE",
    "Resolved path escapes the allowed wiki root.",
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
