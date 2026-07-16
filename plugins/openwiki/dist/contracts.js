import { OpenWikiError } from "./errors.js";
export const WIKI_MODES = ["code", "personal"];
export const SOURCE_KINDS = [
    "git-repo",
    "gmail",
    "hackernews",
    "notion",
    "slack",
    "web-search",
    "x",
];
export const SOURCE_HOSTS = ["codex", "claude", "cli"];
export const WIKI_COMMANDS = ["init", "update", "ingest"];
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const MAX_ENVELOPE_ITEMS = 500;
export const MAX_ITEM_TEXT_BYTES = 128 * 1024;
export const MAX_METADATA_VALUE_BYTES = 4 * 1024;
const WIKI_MODE_SET = new Set(WIKI_MODES);
const SOURCE_KIND_SET = new Set(SOURCE_KINDS);
const SOURCE_HOST_SET = new Set(SOURCE_HOSTS);
const WIKI_COMMAND_SET = new Set(WIKI_COMMANDS);
const WIKI_STATE_KEYS = new Set([
    "schemaVersion",
    "mode",
    "workspaceId",
    "wikiRoot",
    "createdAt",
    "updatedAt",
    "contentHash",
    "lastGitHead",
    "lastRun",
]);
const LAST_RUN_KEYS = new Set([
    "id",
    "command",
    "startedAt",
    "completedAt",
    "changed",
    "summary",
]);
const SOURCE_ENVELOPE_KEYS = new Set([
    "schemaVersion",
    "sourceId",
    "kind",
    "fetchedAt",
    "cursor",
    "provenance",
    "items",
]);
const PROVENANCE_KEYS = new Set(["host", "accountHint", "query"]);
const SOURCE_ITEM_KEYS = new Set([
    "externalId",
    "title",
    "text",
    "url",
    "occurredAt",
    "metadata",
]);
export const ENRICH_SCHEMA_TAG = "memex.enrich.v1";
export const MAX_ENRICH_ENVELOPE_BYTES = 256 * 1024;
export const MAX_ENRICH_NODES = 200;
export const MAX_ENRICH_EDGES = 800;
const ENRICH_ENVELOPE_KEYS = new Set(["schema", "sourcePath", "sourceContentHash", "nodes", "edges"]);
const ENRICH_NODE_KEYS = new Set(["kind", "name", "path", "summary"]);
const ENRICH_EDGE_KEYS = new Set(["kind", "from", "to", "confidence"]);
const ENRICH_NODE_KIND_SET = new Set(["concept", "page"]);
const ENRICH_EDGE_KIND_SET = new Set(["mentions", "describes", "grounds", "related"]);
const AGENT_CONFIDENCE_SET = new Set(["extracted", "inferred", "ambiguous"]);
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export function parseWikiState(input) {
    const state = requireRecord(input, "INVALID_STATE", "Wiki state must be an object.");
    requireKnownKeys(state, WIKI_STATE_KEYS, "INVALID_STATE", "Wiki state");
    if (state.schemaVersion !== 1) {
        throw new OpenWikiError("INVALID_STATE", "Unsupported wiki state schema version. Expected 1.");
    }
    if (!isWikiMode(state.mode)) {
        throw new OpenWikiError("INVALID_STATE", "Wiki state mode is invalid.");
    }
    const lastRun = requireRecord(state.lastRun, "INVALID_STATE", "Wiki state lastRun must be an object.");
    requireKnownKeys(lastRun, LAST_RUN_KEYS, "INVALID_STATE", "Wiki state lastRun");
    if (!isWikiCommand(lastRun.command)) {
        throw new OpenWikiError("INVALID_STATE", "Wiki state lastRun command is invalid.");
    }
    if (typeof lastRun.changed !== "boolean") {
        throw new OpenWikiError("INVALID_STATE", "Wiki state lastRun changed must be boolean.");
    }
    const lastGitHead = readOptionalString(state, "lastGitHead", "INVALID_STATE", "Wiki state lastGitHead");
    return {
        schemaVersion: 1,
        mode: state.mode,
        workspaceId: requireNonEmptyString(state.workspaceId, "INVALID_STATE", "Wiki state workspaceId"),
        wikiRoot: requireNonEmptyString(state.wikiRoot, "INVALID_STATE", "Wiki state wikiRoot"),
        createdAt: requireTimestamp(state.createdAt, "INVALID_STATE", "Wiki state createdAt"),
        updatedAt: requireTimestamp(state.updatedAt, "INVALID_STATE", "Wiki state updatedAt"),
        contentHash: requireNonEmptyString(state.contentHash, "INVALID_STATE", "Wiki state contentHash"),
        ...(lastGitHead === undefined ? {} : { lastGitHead }),
        lastRun: {
            id: requireNonEmptyString(lastRun.id, "INVALID_STATE", "Wiki state lastRun id"),
            command: lastRun.command,
            startedAt: requireTimestamp(lastRun.startedAt, "INVALID_STATE", "Wiki state lastRun startedAt"),
            completedAt: requireTimestamp(lastRun.completedAt, "INVALID_STATE", "Wiki state lastRun completedAt"),
            changed: lastRun.changed,
            summary: requireString(lastRun.summary, "INVALID_STATE", "Wiki state lastRun summary"),
        },
    };
}
export function parseSourceEnvelope(input) {
    enforceEnvelopeByteLimit(input, MAX_ENVELOPE_BYTES, "Source envelope");
    const envelope = requireRecord(input, "INVALID_ARGUMENT", "Source envelope must be an object.");
    requireKnownKeys(envelope, SOURCE_ENVELOPE_KEYS, "INVALID_ARGUMENT", "Source envelope");
    if (envelope.schemaVersion !== 1) {
        throw new OpenWikiError("INVALID_ARGUMENT", "Unsupported source envelope schema version. Expected 1.");
    }
    if (!isSourceKind(envelope.kind)) {
        throw new OpenWikiError("UNSUPPORTED_SOURCE", "Source envelope kind is unsupported.");
    }
    const provenance = parseProvenance(envelope.provenance);
    if (!Array.isArray(envelope.items)) {
        throw new OpenWikiError("INVALID_ARGUMENT", "Source envelope items must be an array.");
    }
    if (envelope.items.length > MAX_ENVELOPE_ITEMS) {
        throw new OpenWikiError("SOURCE_TOO_LARGE", `Source envelope exceeds the ${String(MAX_ENVELOPE_ITEMS)} item limit.`);
    }
    const items = envelope.items.map((item, index) => parseSourceItem(item, index));
    const externalIds = new Set();
    for (const item of items) {
        if (externalIds.has(item.externalId)) {
            throw new OpenWikiError("INVALID_ARGUMENT", "Source envelope contains duplicate externalId values.");
        }
        externalIds.add(item.externalId);
    }
    const cursor = readOptionalString(envelope, "cursor", "INVALID_ARGUMENT", "Source envelope cursor");
    return {
        schemaVersion: 1,
        sourceId: requireNonEmptyString(envelope.sourceId, "INVALID_ARGUMENT", "Source envelope sourceId"),
        kind: envelope.kind,
        fetchedAt: requireTimestamp(envelope.fetchedAt, "INVALID_ARGUMENT", "Source envelope fetchedAt"),
        ...(cursor === undefined ? {} : { cursor }),
        provenance,
        items,
    };
}
function parseProvenance(input) {
    const provenance = requireRecord(input, "INVALID_ARGUMENT", "Source envelope provenance must be an object.");
    requireKnownKeys(provenance, PROVENANCE_KEYS, "INVALID_ARGUMENT", "Source envelope provenance");
    if (!isSourceHost(provenance.host)) {
        throw new OpenWikiError("INVALID_ARGUMENT", "Source envelope provenance host is invalid.");
    }
    const accountHint = readOptionalBoundedString(provenance, "accountHint", "Source envelope provenance accountHint");
    const query = readOptionalBoundedString(provenance, "query", "Source envelope provenance query");
    return {
        host: provenance.host,
        ...(accountHint === undefined ? {} : { accountHint }),
        ...(query === undefined ? {} : { query }),
    };
}
function parseSourceItem(input, index) {
    const label = `Source envelope item ${String(index)}`;
    const item = requireRecord(input, "INVALID_ARGUMENT", `${label} must be an object.`);
    requireKnownKeys(item, SOURCE_ITEM_KEYS, "INVALID_ARGUMENT", label);
    const externalId = requireNonEmptyString(item.externalId, "INVALID_ARGUMENT", `${label} externalId`);
    const text = requireBoundedString(item.text, `${label} text`);
    const title = readOptionalBoundedString(item, "title", `${label} title`);
    const url = readOptionalBoundedString(item, "url", `${label} url`);
    const occurredAt = readOptionalTimestamp(item, "occurredAt", `${label} occurredAt`);
    const metadata = parseOptionalMetadata(item, label);
    return {
        externalId,
        ...(title === undefined ? {} : { title }),
        text,
        ...(url === undefined ? {} : { url }),
        ...(occurredAt === undefined ? {} : { occurredAt }),
        ...(metadata === undefined ? {} : { metadata }),
    };
}
function parseOptionalMetadata(item, label) {
    if (!Object.hasOwn(item, "metadata")) {
        return undefined;
    }
    const metadata = requireRecord(item.metadata, "INVALID_ARGUMENT", `${label} metadata must be an object.`);
    const entries = [];
    for (const [key, value] of Object.entries(metadata)) {
        if (!isMetadataValue(value)) {
            throw new OpenWikiError("INVALID_ARGUMENT", `${label} metadata values must be JSON primitives.`);
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new OpenWikiError("INVALID_ARGUMENT", `${label} metadata numbers must be finite.`);
        }
        if (typeof value === "string" &&
            utf8ByteLength(value) > MAX_METADATA_VALUE_BYTES) {
            throw new OpenWikiError("SOURCE_TOO_LARGE", `${label} metadata value exceeds the ${String(MAX_METADATA_VALUE_BYTES)} byte limit.`);
        }
        entries.push([key, value]);
    }
    return Object.fromEntries(entries);
}
export function parseEnrichEnvelope(input) {
    enforceEnvelopeByteLimit(input, MAX_ENRICH_ENVELOPE_BYTES, "Enrich envelope");
    const envelope = requireRecord(input, "INVALID_ARGUMENT", "Enrich envelope must be an object.");
    requireKnownKeys(envelope, ENRICH_ENVELOPE_KEYS, "INVALID_ARGUMENT", "Enrich envelope");
    if (envelope.schema !== ENRICH_SCHEMA_TAG) {
        throw new OpenWikiError("INVALID_ARGUMENT", `Unsupported enrich envelope schema. Expected ${ENRICH_SCHEMA_TAG}.`);
    }
    const sourcePath = requireRelativePath(envelope.sourcePath, "Enrich envelope sourcePath");
    const sourceContentHash = requireHash(envelope.sourceContentHash, "Enrich envelope sourceContentHash");
    if (!Array.isArray(envelope.nodes)) {
        throw new OpenWikiError("INVALID_ARGUMENT", "Enrich envelope nodes must be an array.");
    }
    if (envelope.nodes.length > MAX_ENRICH_NODES) {
        throw new OpenWikiError("SOURCE_TOO_LARGE", `Enrich envelope exceeds the ${String(MAX_ENRICH_NODES)} node limit.`);
    }
    const nodes = envelope.nodes.map((node, index) => parseEnrichNode(node, index));
    if (!Array.isArray(envelope.edges)) {
        throw new OpenWikiError("INVALID_ARGUMENT", "Enrich envelope edges must be an array.");
    }
    if (envelope.edges.length > MAX_ENRICH_EDGES) {
        throw new OpenWikiError("SOURCE_TOO_LARGE", `Enrich envelope exceeds the ${String(MAX_ENRICH_EDGES)} edge limit.`);
    }
    const edges = envelope.edges.map((edge, index) => parseEnrichEdge(edge, index));
    return { schema: ENRICH_SCHEMA_TAG, sourcePath, sourceContentHash, nodes, edges };
}
function parseEnrichNode(input, index) {
    const label = `Enrich envelope node ${String(index)}`;
    const node = requireRecord(input, "INVALID_ARGUMENT", `${label} must be an object.`);
    requireKnownKeys(node, ENRICH_NODE_KEYS, "INVALID_ARGUMENT", label);
    if (typeof node.kind !== "string" || !ENRICH_NODE_KIND_SET.has(node.kind)) {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} kind must be concept or page.`);
    }
    const name = requireNonEmptyString(node.name, "INVALID_ARGUMENT", `${label} name`);
    const path = requireRelativePath(node.path, `${label} path`);
    const summary = readOptionalBoundedString(node, "summary", `${label} summary`);
    return { kind: node.kind, name, path, ...(summary === undefined ? {} : { summary }) };
}
function parseEnrichEdge(input, index) {
    const label = `Enrich envelope edge ${String(index)}`;
    const edge = requireRecord(input, "INVALID_ARGUMENT", `${label} must be an object.`);
    requireKnownKeys(edge, ENRICH_EDGE_KEYS, "INVALID_ARGUMENT", label);
    if (typeof edge.kind !== "string" || !ENRICH_EDGE_KIND_SET.has(edge.kind)) {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} kind must be mentions, describes, grounds, or related.`);
    }
    const from = requireNonEmptyString(edge.from, "INVALID_ARGUMENT", `${label} from`);
    const to = requireNonEmptyString(edge.to, "INVALID_ARGUMENT", `${label} to`);
    if (typeof edge.confidence !== "string" || !AGENT_CONFIDENCE_SET.has(edge.confidence)) {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} confidence must be extracted, inferred, or ambiguous.`);
    }
    return { kind: edge.kind, from, to, confidence: edge.confidence };
}
function requireRelativePath(value, label) {
    const text = requireNonEmptyString(value, "INVALID_ARGUMENT", label);
    if (text.startsWith("/") || text.includes("\\") || text.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be a repository-relative path.`);
    }
    return text;
}
function requireHash(value, label) {
    const text = requireNonEmptyString(value, "INVALID_ARGUMENT", label);
    if (!HEX_SHA256_PATTERN.test(text)) {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be a SHA-256 hash.`);
    }
    return text.toLowerCase();
}
function enforceEnvelopeByteLimit(input, maxBytes, label) {
    let serializedValue;
    try {
        serializedValue = JSON.stringify(input);
    }
    catch {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be JSON serializable.`);
    }
    if (typeof serializedValue !== "string") {
        throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be JSON serializable.`);
    }
    if (utf8ByteLength(serializedValue) > maxBytes) {
        throw new OpenWikiError("SOURCE_TOO_LARGE", `${label} exceeds the ${String(maxBytes)} byte limit.`);
    }
}
function requireRecord(value, code, message) {
    if (!isRecord(value)) {
        throw new OpenWikiError(code, message);
    }
    return value;
}
function requireKnownKeys(value, allowedKeys, code, label) {
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
        throw new OpenWikiError(code, `${label} contains unknown fields.`);
    }
}
function requireNonEmptyString(value, code, label) {
    const parsed = requireString(value, code, label);
    if (parsed.length === 0) {
        throw new OpenWikiError(code, `${label} must not be empty.`);
    }
    return parsed;
}
function requireString(value, code, label) {
    if (typeof value !== "string") {
        throw new OpenWikiError(code, `${label} must be a string.`);
    }
    return value;
}
function readOptionalString(record, key, code, label) {
    return Object.hasOwn(record, key)
        ? requireNonEmptyString(record[key], code, label)
        : undefined;
}
function requireBoundedString(value, label) {
    const parsed = requireString(value, "INVALID_ARGUMENT", label);
    if (utf8ByteLength(parsed) > MAX_ITEM_TEXT_BYTES) {
        throw new OpenWikiError("SOURCE_TOO_LARGE", `${label} exceeds the ${String(MAX_ITEM_TEXT_BYTES)} byte limit.`);
    }
    return parsed;
}
function readOptionalBoundedString(record, key, label) {
    return Object.hasOwn(record, key)
        ? requireBoundedString(record[key], label)
        : undefined;
}
function requireTimestamp(value, code, label) {
    if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
        throw new OpenWikiError(code, `${label} must be a canonical ISO-8601 timestamp.`);
    }
    return value;
}
function readOptionalTimestamp(record, key, label) {
    return Object.hasOwn(record, key)
        ? requireTimestamp(record[key], "INVALID_ARGUMENT", label)
        : undefined;
}
function isCanonicalTimestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
        return false;
    }
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWikiMode(value) {
    return typeof value === "string" && WIKI_MODE_SET.has(value);
}
function isSourceKind(value) {
    return typeof value === "string" && SOURCE_KIND_SET.has(value);
}
function isSourceHost(value) {
    return typeof value === "string" && SOURCE_HOST_SET.has(value);
}
function isWikiCommand(value) {
    return typeof value === "string" && WIKI_COMMAND_SET.has(value);
}
function isMetadataValue(value) {
    return (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean");
}
function utf8ByteLength(value) {
    let bytes = 0;
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        bytes +=
            codePoint <= 0x7f
                ? 1
                : codePoint <= 0x7ff
                    ? 2
                    : codePoint <= 0xffff
                        ? 3
                        : 4;
    }
    return bytes;
}
