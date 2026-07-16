import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { atomicWriteFile, withWikiLock } from "./atomic.js";
import type { WikiCommand, WikiStateV1 } from "./contracts.js";
import { OpenWikiError } from "./errors.js";
import type { GraphIndexPort } from "./graph-index.js";
import { reindexWikiPage } from "./reindex.js";
import {
  resolveConfinedMarkdownPath,
  resolveWikiLocation,
  type ResolveWikiLocationOptions,
  type WikiLocation,
} from "./paths.js";
import { readState, tryReadState, writeState } from "./state.js";

export const REQUIRED_WIKI_PAGES = [
  "quickstart.md",
  "architecture.md",
  "source-map.md",
  "workflows.md",
  "domain-concepts.md",
  "operations.md",
  "integrations.md",
  "testing.md",
] as const;

const DEFAULT_TEMPLATES_ROOT = fileURLToPath(
  new URL("../templates", import.meta.url),
);

export interface InitializeWikiOptions extends ResolveWikiLocationOptions {
  templatesRoot?: string;
  now?: string;
  runId?: string;
}

export interface InitializeWikiResult {
  changed: boolean;
  createdPages: string[];
  location: WikiLocation;
  state: WikiStateV1;
}

export interface PageReadResult {
  page: string;
  content: string;
  lineCount: number;
}

export interface SearchResult {
  page: string;
  line: number;
  excerpt: string;
  score: number;
}

export interface FinalizeRunOptions {
  location: WikiLocation;
  command: WikiCommand;
  runId: string;
  startedAt: string;
  completedAt?: string;
  summary: string;
  lastGitHead?: string;
}

export interface FinalizeRunResult {
  changed: boolean;
  state: WikiStateV1;
}

export interface WikiCheckIssue {
  code: "BROKEN_LINK" | "DANGLING_NODE_REF" | "INVALID_STATE" | "MISSING_PAGE" | "MISSING_PAGE_EDGE" | "MISSING_PAGE_NODE" | "STALE_STATE" | "SYMLINK";
  message: string;
  page?: string;
}

export interface WikiCheckResult {
  ok: boolean;
  issues: WikiCheckIssue[];
}

export interface WikiCheckOptions {
  graph?: GraphIndexPort;
}

export async function initializeWiki(
  options: InitializeWikiOptions,
): Promise<InitializeWikiResult> {
  const location = await resolveWikiLocation(options);
  await mkdir(location.wikiRoot, { recursive: true, mode: 0o700 });

  return withWikiLock(location.wikiRoot, async () => {
    const createdPages: string[] = [];
    const templatesRoot = options.templatesRoot ?? DEFAULT_TEMPLATES_ROOT;

    for (const page of REQUIRED_WIKI_PAGES) {
      const destination = await resolveConfinedMarkdownPath(location, page);
      if (await pathExists(destination)) {
        continue;
      }

      const templatePath = path.join(templatesRoot, options.mode, page);
      let template: string;
      try {
        template = await readFile(templatePath, "utf8");
      } catch {
        throw new OpenWikiError(
          "IO_FAILURE",
          "Required OpenWiki template could not be read.",
        );
      }
      await atomicWriteFile(destination, template);
      createdPages.push(page);
    }

    const existingState = await tryReadState(location);
    if (existingState && createdPages.length === 0) {
      return {
        changed: false,
        createdPages,
        location,
        state: existingState,
      };
    }

    const now = options.now ?? new Date().toISOString();
    const contentHash = await createWikiContentHash(location);
    const state: WikiStateV1 = {
      schemaVersion: 1,
      mode: location.mode,
      workspaceId: location.workspaceId,
      wikiRoot: location.wikiRoot,
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now,
      contentHash,
      ...(existingState?.lastGitHead
        ? { lastGitHead: existingState.lastGitHead }
        : {}),
      lastRun: {
        id: options.runId ?? randomUUID(),
        command: "init",
        startedAt: now,
        completedAt: now,
        changed: true,
        summary: existingState
          ? "Restored missing standard wiki pages."
          : "Initialized OpenWiki standard pages.",
      },
    };
    await writeState(location, state);

    return {
      changed: true,
      createdPages,
      location,
      state,
    };
  });
}

export async function readPage(
  location: WikiLocation,
  page: string,
): Promise<PageReadResult> {
  const filePath = await resolveConfinedMarkdownPath(location, page);
  const content = await readFileNoFollow(filePath, "NOT_FOUND", "Wiki page was not found.");
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;

  return {
    page,
    content,
    lineCount: normalized.length === 0 ? 0 : normalized.split(/\r?\n/u).length,
  };
}

export async function writePage(
  location: WikiLocation,
  page: string,
  content: string,
): Promise<void> {
  if (typeof content !== "string") {
    throw new OpenWikiError("INVALID_ARGUMENT", "Wiki page content must be text.");
  }

  await withWikiLock(location.wikiRoot, async () => {
    const filePath = await resolveConfinedMarkdownPath(location, page);
    await atomicWriteFile(filePath, content);
  });
  await reindexWikiPage(location, page, content);
}

export async function searchWiki(
  location: WikiLocation,
  query: unknown,
  limit = 20,
): Promise<SearchResult[]> {
  const terms = normalizeTerms(query);
  if (terms.length === 0) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Search query must contain searchable terms.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Search limit must be between 1 and 100.");
  }

  const pages = await listMarkdownPages(location);
  const results: SearchResult[] = [];

  for (const page of pages) {
    const content = (await readPage(location, page)).content;
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const excerpt = lines[index]?.trim() ?? "";
      if (excerpt.length === 0) {
        continue;
      }
      const normalizedLine = excerpt.toLocaleLowerCase("en-US");
      const matches = terms.filter((term) => normalizedLine.includes(term));
      if (matches.length === 0) {
        continue;
      }
      const occurrences = matches.reduce(
        (count, term) => count + countOccurrences(normalizedLine, term),
        0,
      );
      results.push({
        page,
        line: index + 1,
        excerpt,
        score: matches.length / terms.length + occurrences / 1000,
      });
    }
  }

  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.page.localeCompare(right.page) ||
        left.line - right.line,
    )
    .slice(0, limit);
}

export async function finalizeRun(
  options: FinalizeRunOptions,
): Promise<FinalizeRunResult> {
  return withWikiLock(options.location.wikiRoot, async () => {
    const current = await readState(options.location);
    const contentHash = await createWikiContentHash(options.location);
    if (contentHash === current.contentHash) {
      return { changed: false, state: current };
    }

    const completedAt = options.completedAt ?? new Date().toISOString();
    const lastGitHead = options.lastGitHead ?? current.lastGitHead;
    const next: WikiStateV1 = {
      ...current,
      updatedAt: completedAt,
      contentHash,
      ...(lastGitHead === undefined ? {} : { lastGitHead }),
      lastRun: {
        id: options.runId,
        command: options.command,
        startedAt: options.startedAt,
        completedAt,
        changed: true,
        summary: options.summary,
      },
    };
    await writeState(options.location, next);
    return { changed: true, state: next };
  });
}

export async function checkWiki(
  location: WikiLocation,
  options: WikiCheckOptions = {},
): Promise<WikiCheckResult> {
  const issues: WikiCheckIssue[] = [];
  let state: WikiStateV1 | null = null;

  try {
    state = await readState(location);
  } catch {
    issues.push({
      code: "INVALID_STATE",
      message: "Wiki state is missing or invalid.",
    });
  }

  for (const page of REQUIRED_WIKI_PAGES) {
    try {
      await readPage(location, page);
    } catch {
      issues.push({
        code: "MISSING_PAGE",
        message: "Required wiki page is missing.",
        page,
      });
    }
  }

  let pages: string[] = [];
  try {
    pages = await listMarkdownPages(location);
  } catch (error) {
    if (error instanceof OpenWikiError && error.code === "SYMLINK_ESCAPE") {
      issues.push({
        code: "SYMLINK",
        message: "Wiki contains a symbolic link.",
      });
    } else {
      throw error;
    }
  }

  for (const page of pages) {
    const content = (await readPage(location, page)).content;
    for (const target of findMarkdownLinks(content)) {
      const resolvedTarget = resolveLinkedPage(page, target);
      if (resolvedTarget.kind === "skip") {
        continue;
      }
      if (resolvedTarget.kind === "invalid") {
        issues.push({
          code: "BROKEN_LINK",
          message: "Wiki page contains a local link outside the wiki root.",
          page,
        });
        continue;
      }
      try {
        await readPage(location, resolvedTarget.page);
      } catch {
        issues.push({
          code: "BROKEN_LINK",
          message: "Wiki page contains a broken local link.",
          page,
        });
      }
    }
  }

  if (options.graph !== undefined) {
    const graph = options.graph;
    const [allNodes, allEdges] = await Promise.all([graph.allNodes(), graph.allEdges()]);
    const nodeIds = new Set(allNodes.map((node) => node.id));
    // Graph node paths are repository-relative (e.g. "openwiki/quickstart.md"), while `pages`
    // (from listMarkdownPages) is relative to the wiki root itself (e.g. "quickstart.md").
    // Bridge the two conventions using the same workspaceRoot/wikiRoot relationship
    // resolveWikiLocation already establishes, instead of hardcoding the "openwiki" directory name.
    const wikiRootPrefix = location.workspaceRoot === undefined
      ? undefined
      : path.relative(location.workspaceRoot, location.wikiRoot).split(path.sep).join("/");
    for (const page of pages) {
      const graphPagePath = wikiRootPrefix === undefined || wikiRootPrefix === "" ? page : `${wikiRootPrefix}/${page}`;
      const pageNode = allNodes.find((node) => node.kind === "page" && node.path === graphPagePath);
      if (pageNode === undefined) {
        issues.push({
          code: "MISSING_PAGE_NODE",
          message: "Wiki page has no corresponding page graph node.",
          page,
        });
        continue;
      }
      const hasEvidence = allEdges.some(
        (edge) => (edge.from === pageNode.id || edge.to === pageNode.id) && (edge.kind === "describes" || edge.kind === "mentions"),
      );
      if (!hasEvidence) {
        issues.push({
          code: "MISSING_PAGE_EDGE",
          message: "Wiki page node has no describes or mentions edge.",
          page,
        });
      }
    }
    for (const edge of allEdges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        issues.push({
          code: "DANGLING_NODE_REF",
          message: `Graph edge ${edge.id} references a node that does not exist.`,
        });
      }
    }
  }

  if (state) {
    try {
      if ((await createWikiContentHash(location)) !== state.contentHash) {
        issues.push({
          code: "STALE_STATE",
          message: "Wiki content differs from finalized state.",
        });
      }
    } catch (error) {
      if (error instanceof OpenWikiError && error.code === "SYMLINK_ESCAPE") {
        if (!issues.some((issue) => issue.code === "SYMLINK")) {
          issues.push({
            code: "SYMLINK",
            message: "Wiki contains a symbolic link.",
          });
        }
      } else {
        throw error;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export async function createWikiContentHash(
  location: WikiLocation,
): Promise<string> {
  const pages = await listMarkdownPages(location);
  const hash = createHash("sha256");
  for (const page of pages) {
    hash.update(page);
    hash.update("\0");
    hash.update((await readPage(location, page)).content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listMarkdownPages(location: WikiLocation): Promise<string[]> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(location.wikiRoot);
  } catch {
    throw new OpenWikiError("NOT_INITIALIZED", "OpenWiki is not initialized.");
  }

  const pages: string[] = [];
  await walkMarkdown(canonicalRoot, canonicalRoot, pages);
  return pages.sort((left, right) => left.localeCompare(right));
}

async function walkMarkdown(
  root: string,
  directory: string,
  pages: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new OpenWikiError("IO_FAILURE", "Unable to enumerate wiki pages.");
  }

  for (const entry of entries) {
    if (entry.name === ".openwiki.lock") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new OpenWikiError(
        "SYMLINK_ESCAPE",
        "Wiki content must not contain symbolic links.",
      );
    }
    if (entry.isDirectory()) {
      await walkMarkdown(root, entryPath, pages);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      pages.push(path.relative(root, entryPath).split(path.sep).join("/"));
    }
  }
}

async function readFileNoFollow(
  filePath: string,
  missingCode: "NOT_FOUND" | "IO_FAILURE",
  missingMessage: string,
): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new OpenWikiError("NOT_FOUND", missingMessage);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof OpenWikiError) {
      throw error;
    }
    if (isFileNotFoundError(error)) {
      throw new OpenWikiError(missingCode, missingMessage);
    }
    if (isSymbolicLinkError(error)) {
      throw new OpenWikiError(
        "SYMLINK_ESCAPE",
        "Wiki page path must not be a symbolic link.",
      );
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to read wiki page.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeTerms(query: unknown): string[] {
  if (typeof query !== "string") {
    return [];
  }
  return [
    ...new Set(
      query
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}_-]+/gu) ?? [],
    ),
  ];
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  for (
    let index = value.indexOf(term);
    index >= 0;
    index = value.indexOf(term, index + term.length)
  ) {
    count += 1;
  }
  return count;
}

function findMarkdownLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(
      (target) =>
        target.length > 0 &&
        !target.startsWith("#") &&
        !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target),
    );
}

type LinkedPageResolution =
  | { kind: "skip" }
  | { kind: "invalid" }
  | { kind: "page"; page: string };

function resolveLinkedPage(
  sourcePage: string,
  target: string,
): LinkedPageResolution {
  const withoutFragment = target.split(/[?#]/u, 1)[0];
  if (!withoutFragment || !withoutFragment.endsWith(".md")) {
    return { kind: "skip" };
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePage), withoutFragment),
  );
  if (resolved === ".." || resolved.startsWith("../")) {
    return { kind: "invalid" };
  }
  return { kind: "page", page: resolved };
}

async function pathExists(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new OpenWikiError(
        "IO_FAILURE",
        "Required wiki page path is not a regular file.",
      );
    }
    return true;
  } catch (error) {
    if (error instanceof OpenWikiError) {
      throw error;
    }
    if (isFileNotFoundError(error)) {
      return false;
    }
    if (isSymbolicLinkError(error)) {
      throw new OpenWikiError(
        "SYMLINK_ESCAPE",
        "Wiki page path must not be a symbolic link.",
      );
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to inspect wiki page.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isSymbolicLinkError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOOP";
}
