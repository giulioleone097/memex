import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, withWikiLock } from "./atomic.js";
import { OpenWikiError } from "./errors.js";
import { resolveWikiLocation } from "./paths.js";
export async function resolveAnalysisStorage(root, homeDir) {
    const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
    const analysisRoot = path.join(location.dataRoot, "analysis");
    await mkdir(analysisRoot, { recursive: true, mode: 0o700 });
    return { workspaceId: location.workspaceId, storage: { root: analysisRoot, manifestPath: path.join(analysisRoot, "communities.json") } };
}
export async function probeAnalysisStorage(root, homeDir) {
    const resolved = await resolveAnalysisStorage(root, homeDir);
    try {
        await readFile(resolved.storage.manifestPath, "utf8");
        return { initialized: true, storage: resolved.storage };
    }
    catch {
        return { initialized: false, storage: resolved.storage };
    }
}
export async function writeCommunitiesSnapshot(storage, snapshot) {
    await withWikiLock(storage.root, async () => {
        await atomicWriteFile(storage.manifestPath, `${JSON.stringify(snapshot)}\n`);
    });
}
export async function readCommunitiesSnapshot(storage) {
    let raw;
    try {
        raw = await readFile(storage.manifestPath, "utf8");
    }
    catch {
        throw new OpenWikiError("NOT_INITIALIZED", "No recoverable OpenWiki communities snapshot exists.");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new OpenWikiError("INVALID_STATE", "Communities snapshot is invalid JSON.");
    }
    return parseCommunitiesSnapshot(parsed);
}
export function parseCommunitiesSnapshot(value) {
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.generation !== "string" ||
        typeof value.generatedAt !== "string" ||
        !Array.isArray(value.communities) ||
        !isRecord(value.membership)) {
        throw new OpenWikiError("INVALID_STATE", "Communities snapshot schema is invalid.");
    }
    const membership = {};
    for (const [nodeId, communityId] of Object.entries(value.membership)) {
        if (typeof communityId !== "string") {
            throw new OpenWikiError("INVALID_STATE", "Communities snapshot membership is invalid.");
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
function parseCommunitySummary(value) {
    if (!isRecord(value) ||
        typeof value.id !== "string" ||
        !nonNegativeInteger(value.memberCount) ||
        !Array.isArray(value.topTerms) ||
        !value.topTerms.every((term) => typeof term === "string") ||
        !Array.isArray(value.members) ||
        !value.members.every((member) => typeof member === "string") ||
        typeof value.membersTruncated !== "boolean") {
        throw new OpenWikiError("INVALID_STATE", "Community summary is invalid.");
    }
    return { id: value.id, memberCount: value.memberCount, topTerms: value.topTerms, members: value.members, membersTruncated: value.membersTruncated };
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
