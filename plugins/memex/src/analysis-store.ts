import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, withWikiLock } from "./atomic.js";
import { MemexError } from "./errors.js";
import { resolveWikiLocation } from "./paths.js";

// Field shape kept in sync by hand with CommunitySummary in analyze.ts (Task 3); if one gains/loses a field,
// update the other to match.
export interface CommunitySummaryV1 {
  id: string;
  memberCount: number;
  topTerms: string[];
  members: string[];
  membersTruncated: boolean;
}

export interface CommunitiesSnapshotV1 {
  schemaVersion: 1;
  generation: string;
  generatedAt: string;
  communities: CommunitySummaryV1[];
  membership: Record<string, string>;
}

export interface AnalysisStorage {
  root: string;
  manifestPath: string;
}

export async function resolveAnalysisStorage(root: string, homeDir?: string): Promise<{ storage: AnalysisStorage; workspaceId: string }> {
  const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
  const analysisRoot = path.join(location.dataRoot, "analysis");
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 });
  return { workspaceId: location.workspaceId, storage: { root: analysisRoot, manifestPath: path.join(analysisRoot, "communities.json") } };
}

export async function probeAnalysisStorage(root: string, homeDir?: string): Promise<{ initialized: boolean; storage: AnalysisStorage }> {
  const resolved = await resolveAnalysisStorage(root, homeDir);
  try {
    await readFile(resolved.storage.manifestPath, "utf8");
    return { initialized: true, storage: resolved.storage };
  } catch {
    return { initialized: false, storage: resolved.storage };
  }
}

export async function writeCommunitiesSnapshot(storage: AnalysisStorage, snapshot: CommunitiesSnapshotV1): Promise<void> {
  await withWikiLock(storage.root, async () => {
    await atomicWriteFile(storage.manifestPath, `${JSON.stringify(snapshot)}\n`);
  });
}

export async function readCommunitiesSnapshot(storage: AnalysisStorage): Promise<CommunitiesSnapshotV1> {
  let raw: string;
  try {
    raw = await readFile(storage.manifestPath, "utf8");
  } catch {
    throw new MemexError("NOT_INITIALIZED", "No recoverable Memex communities snapshot exists.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemexError("INVALID_STATE", "Communities snapshot is invalid JSON.");
  }
  return parseCommunitiesSnapshot(parsed);
}

export function parseCommunitiesSnapshot(value: unknown): CommunitiesSnapshotV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generation !== "string" ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.communities) ||
    !isRecord(value.membership)
  ) {
    throw new MemexError("INVALID_STATE", "Communities snapshot schema is invalid.");
  }
  const membership: Record<string, string> = {};
  for (const [nodeId, communityId] of Object.entries(value.membership)) {
    if (typeof communityId !== "string") {
      throw new MemexError("INVALID_STATE", "Communities snapshot membership is invalid.");
    }
    membership[nodeId] = communityId;
  }
  return {
    schemaVersion: 1,
    generation: value.generation,
    generatedAt: value.generatedAt,
    communities: value.communities.map(parseCommunitySummary),
    membership,
  };
}

function parseCommunitySummary(value: unknown): CommunitySummaryV1 {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !nonNegativeInteger(value.memberCount) ||
    !Array.isArray(value.topTerms) ||
    !value.topTerms.every((term) => typeof term === "string") ||
    !Array.isArray(value.members) ||
    !value.members.every((member) => typeof member === "string") ||
    typeof value.membersTruncated !== "boolean"
  ) {
    throw new MemexError("INVALID_STATE", "Community summary is invalid.");
  }
  return { id: value.id, memberCount: value.memberCount, topTerms: value.topTerms, members: value.members, membersTruncated: value.membersTruncated };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
