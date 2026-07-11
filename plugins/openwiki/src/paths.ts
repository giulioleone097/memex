import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WikiMode } from "./contracts.js";
import { OpenWikiError } from "./errors.js";

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

export async function resolveWikiLocation(
  options: ResolveWikiLocationOptions,
): Promise<WikiLocation> {
  if (options.mode === "code") {
    if (!options.root) {
      throw new OpenWikiError(
        "INVALID_ARGUMENT",
        "Code mode requires a repository root.",
      );
    }

    const workspaceRoot = await resolveExistingDirectory(options.root);
    const wikiRoot = await resolveProspectivePath(workspaceRoot, "openwiki");
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
        path.join(".openwiki", "data", workspaceId),
      ),
    };
  }

  const homeDir = await resolveExistingDirectory(options.homeDir ?? os.homedir());
  const privateRoot = await resolveProspectivePath(homeDir, ".openwiki");
  const wikiRoot = await resolveProspectivePath(privateRoot, "wiki");
  const dataRoot = await resolveProspectivePath(
    homeDir,
    path.join(".openwiki", "data", "personal"),
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
      throw new OpenWikiError("NOT_INITIALIZED", "OpenWiki is not initialized.");
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to resolve the wiki root.");
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
    throw new OpenWikiError(
      "PATH_OUTSIDE_ROOT",
      "Wiki page path must be relative to the wiki root.",
    );
  }

  const segments = page.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new OpenWikiError(
      "PATH_OUTSIDE_ROOT",
      "Wiki page path must stay inside the wiki root.",
    );
  }

  if (!page.endsWith(".md")) {
    throw new OpenWikiError(
      "INVALID_ARGUMENT",
      "Wiki pages must use the .md extension.",
    );
  }
}

async function resolveExistingDirectory(input: string): Promise<string> {
  try {
    const resolved = await realpath(path.resolve(input));
    if (!(await stat(resolved)).isDirectory()) {
      throw new OpenWikiError(
        "NOT_FOUND",
        "Configured root directory was not found.",
      );
    }
    return resolved;
  } catch {
    throw new OpenWikiError("NOT_FOUND", "Configured root directory was not found.");
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
      if (error instanceof OpenWikiError) {
        throw error;
      }
      throw new OpenWikiError("IO_FAILURE", "Unable to resolve a confined path.");
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

  throw new OpenWikiError(
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
