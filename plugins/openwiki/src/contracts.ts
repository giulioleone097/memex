import { OpenWikiError, type OpenWikiErrorCode } from "./errors.js";

export const WIKI_MODES = ["code", "personal"] as const;
export type WikiMode = (typeof WIKI_MODES)[number];

export const SOURCE_KINDS = [
  "git-repo",
  "gmail",
  "hackernews",
  "notion",
  "slack",
  "web-search",
  "x",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_HOSTS = ["codex", "claude", "cli"] as const;
export type SourceHost = (typeof SOURCE_HOSTS)[number];

export const WIKI_COMMANDS = ["init", "update", "ingest"] as const;
export type WikiCommand = (typeof WIKI_COMMANDS)[number];

export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const MAX_ENVELOPE_ITEMS = 500;
export const MAX_ITEM_TEXT_BYTES = 128 * 1024;
export const MAX_METADATA_VALUE_BYTES = 4 * 1024;

export interface WikiStateV1 {
  schemaVersion: 1;
  mode: WikiMode;
  workspaceId: string;
  wikiRoot: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  lastGitHead?: string;
  lastRun: {
    id: string;
    command: WikiCommand;
    startedAt: string;
    completedAt: string;
    changed: boolean;
    summary: string;
  };
}

export type SourceMetadataValue = string | number | boolean | null;

export interface SourceEnvelopeV1 {
  schemaVersion: 1;
  sourceId: string;
  kind: SourceKind;
  fetchedAt: string;
  cursor?: string;
  provenance: {
    host: SourceHost;
    accountHint?: string;
    query?: string;
  };
  items: Array<{
    externalId: string;
    title?: string;
    text: string;
    url?: string;
    occurredAt?: string;
    metadata?: Record<string, SourceMetadataValue>;
  }>;
}

const WIKI_MODE_SET = new Set<string>(WIKI_MODES);
const SOURCE_KIND_SET = new Set<string>(SOURCE_KINDS);
const SOURCE_HOST_SET = new Set<string>(SOURCE_HOSTS);
const WIKI_COMMAND_SET = new Set<string>(WIKI_COMMANDS);

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

export function parseWikiState(input: unknown): WikiStateV1 {
  const state = requireRecord(input, "INVALID_STATE", "Wiki state must be an object.");
  requireKnownKeys(state, WIKI_STATE_KEYS, "INVALID_STATE", "Wiki state");

  if (state.schemaVersion !== 1) {
    throw new OpenWikiError(
      "INVALID_STATE",
      "Unsupported wiki state schema version. Expected 1.",
    );
  }

  if (!isWikiMode(state.mode)) {
    throw new OpenWikiError("INVALID_STATE", "Wiki state mode is invalid.");
  }

  const lastRun = requireRecord(
    state.lastRun,
    "INVALID_STATE",
    "Wiki state lastRun must be an object.",
  );
  requireKnownKeys(lastRun, LAST_RUN_KEYS, "INVALID_STATE", "Wiki state lastRun");

  if (!isWikiCommand(lastRun.command)) {
    throw new OpenWikiError("INVALID_STATE", "Wiki state lastRun command is invalid.");
  }

  if (typeof lastRun.changed !== "boolean") {
    throw new OpenWikiError("INVALID_STATE", "Wiki state lastRun changed must be boolean.");
  }

  const lastGitHead = readOptionalString(
    state,
    "lastGitHead",
    "INVALID_STATE",
    "Wiki state lastGitHead",
  );

  return {
    schemaVersion: 1,
    mode: state.mode,
    workspaceId: requireNonEmptyString(
      state.workspaceId,
      "INVALID_STATE",
      "Wiki state workspaceId",
    ),
    wikiRoot: requireNonEmptyString(
      state.wikiRoot,
      "INVALID_STATE",
      "Wiki state wikiRoot",
    ),
    createdAt: requireTimestamp(state.createdAt, "INVALID_STATE", "Wiki state createdAt"),
    updatedAt: requireTimestamp(state.updatedAt, "INVALID_STATE", "Wiki state updatedAt"),
    contentHash: requireNonEmptyString(
      state.contentHash,
      "INVALID_STATE",
      "Wiki state contentHash",
    ),
    ...(lastGitHead === undefined ? {} : { lastGitHead }),
    lastRun: {
      id: requireNonEmptyString(lastRun.id, "INVALID_STATE", "Wiki state lastRun id"),
      command: lastRun.command,
      startedAt: requireTimestamp(
        lastRun.startedAt,
        "INVALID_STATE",
        "Wiki state lastRun startedAt",
      ),
      completedAt: requireTimestamp(
        lastRun.completedAt,
        "INVALID_STATE",
        "Wiki state lastRun completedAt",
      ),
      changed: lastRun.changed,
      summary: requireString(lastRun.summary, "INVALID_STATE", "Wiki state lastRun summary"),
    },
  };
}

export function parseSourceEnvelope(input: unknown): SourceEnvelopeV1 {
  enforceEnvelopeByteLimit(input);

  const envelope = requireRecord(
    input,
    "INVALID_ARGUMENT",
    "Source envelope must be an object.",
  );
  requireKnownKeys(
    envelope,
    SOURCE_ENVELOPE_KEYS,
    "INVALID_ARGUMENT",
    "Source envelope",
  );

  if (envelope.schemaVersion !== 1) {
    throw new OpenWikiError(
      "INVALID_ARGUMENT",
      "Unsupported source envelope schema version. Expected 1.",
    );
  }

  if (!isSourceKind(envelope.kind)) {
    throw new OpenWikiError("UNSUPPORTED_SOURCE", "Source envelope kind is unsupported.");
  }

  const provenance = parseProvenance(envelope.provenance);
  if (!Array.isArray(envelope.items)) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Source envelope items must be an array.");
  }
  if (envelope.items.length > MAX_ENVELOPE_ITEMS) {
    throw new OpenWikiError(
      "SOURCE_TOO_LARGE",
      `Source envelope exceeds the ${MAX_ENVELOPE_ITEMS} item limit.`,
    );
  }

  const items = envelope.items.map((item, index) => parseSourceItem(item, index));
  const externalIds = new Set<string>();
  for (const item of items) {
    if (externalIds.has(item.externalId)) {
      throw new OpenWikiError(
        "INVALID_ARGUMENT",
        "Source envelope contains duplicate externalId values.",
      );
    }
    externalIds.add(item.externalId);
  }

  const cursor = readOptionalString(
    envelope,
    "cursor",
    "INVALID_ARGUMENT",
    "Source envelope cursor",
  );

  return {
    schemaVersion: 1,
    sourceId: requireNonEmptyString(
      envelope.sourceId,
      "INVALID_ARGUMENT",
      "Source envelope sourceId",
    ),
    kind: envelope.kind,
    fetchedAt: requireTimestamp(
      envelope.fetchedAt,
      "INVALID_ARGUMENT",
      "Source envelope fetchedAt",
    ),
    ...(cursor === undefined ? {} : { cursor }),
    provenance,
    items,
  };
}

function parseProvenance(input: unknown): SourceEnvelopeV1["provenance"] {
  const provenance = requireRecord(
    input,
    "INVALID_ARGUMENT",
    "Source envelope provenance must be an object.",
  );
  requireKnownKeys(
    provenance,
    PROVENANCE_KEYS,
    "INVALID_ARGUMENT",
    "Source envelope provenance",
  );

  if (!isSourceHost(provenance.host)) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Source envelope provenance host is invalid.");
  }

  const accountHint = readOptionalBoundedString(
    provenance,
    "accountHint",
    "Source envelope provenance accountHint",
  );
  const query = readOptionalBoundedString(
    provenance,
    "query",
    "Source envelope provenance query",
  );

  return {
    host: provenance.host,
    ...(accountHint === undefined ? {} : { accountHint }),
    ...(query === undefined ? {} : { query }),
  };
}

function parseSourceItem(
  input: unknown,
  index: number,
): SourceEnvelopeV1["items"][number] {
  const label = `Source envelope item ${index}`;
  const item = requireRecord(input, "INVALID_ARGUMENT", `${label} must be an object.`);
  requireKnownKeys(item, SOURCE_ITEM_KEYS, "INVALID_ARGUMENT", label);

  const externalId = requireNonEmptyString(
    item.externalId,
    "INVALID_ARGUMENT",
    `${label} externalId`,
  );
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

function parseOptionalMetadata(
  item: Record<string, unknown>,
  label: string,
): Record<string, SourceMetadataValue> | undefined {
  if (!Object.hasOwn(item, "metadata")) {
    return undefined;
  }

  const metadata = requireRecord(
    item.metadata,
    "INVALID_ARGUMENT",
    `${label} metadata must be an object.`,
  );
  const entries: Array<[string, SourceMetadataValue]> = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (!isMetadataValue(value)) {
      throw new OpenWikiError(
        "INVALID_ARGUMENT",
        `${label} metadata values must be JSON primitives.`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new OpenWikiError(
        "INVALID_ARGUMENT",
        `${label} metadata numbers must be finite.`,
      );
    }
    if (
      typeof value === "string" &&
      utf8ByteLength(value) > MAX_METADATA_VALUE_BYTES
    ) {
      throw new OpenWikiError(
        "SOURCE_TOO_LARGE",
        `${label} metadata value exceeds the ${MAX_METADATA_VALUE_BYTES} byte limit.`,
      );
    }
    entries.push([key, value]);
  }

  return Object.fromEntries(entries);
}

function enforceEnvelopeByteLimit(input: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new OpenWikiError(
      "INVALID_ARGUMENT",
      "Source envelope must be JSON serializable.",
    );
  }

  if (serialized === undefined) {
    throw new OpenWikiError(
      "INVALID_ARGUMENT",
      "Source envelope must be JSON serializable.",
    );
  }
  if (utf8ByteLength(serialized) > MAX_ENVELOPE_BYTES) {
    throw new OpenWikiError(
      "SOURCE_TOO_LARGE",
      `Source envelope exceeds the ${MAX_ENVELOPE_BYTES} byte limit.`,
    );
  }
}

function requireRecord(
  value: unknown,
  code: OpenWikiErrorCode,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new OpenWikiError(code, message);
  }
  return value;
}

function requireKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  code: OpenWikiErrorCode,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new OpenWikiError(code, `${label} contains unknown fields.`);
  }
}

function requireNonEmptyString(
  value: unknown,
  code: OpenWikiErrorCode,
  label: string,
): string {
  const parsed = requireString(value, code, label);
  if (parsed.length === 0) {
    throw new OpenWikiError(code, `${label} must not be empty.`);
  }
  return parsed;
}

function requireString(
  value: unknown,
  code: OpenWikiErrorCode,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new OpenWikiError(code, `${label} must be a string.`);
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  code: OpenWikiErrorCode,
  label: string,
): string | undefined {
  return Object.hasOwn(record, key)
    ? requireNonEmptyString(record[key], code, label)
    : undefined;
}

function requireBoundedString(value: unknown, label: string): string {
  const parsed = requireString(value, "INVALID_ARGUMENT", label);
  if (utf8ByteLength(parsed) > MAX_ITEM_TEXT_BYTES) {
    throw new OpenWikiError(
      "SOURCE_TOO_LARGE",
      `${label} exceeds the ${MAX_ITEM_TEXT_BYTES} byte limit.`,
    );
  }
  return parsed;
}

function readOptionalBoundedString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  return Object.hasOwn(record, key)
    ? requireBoundedString(record[key], label)
    : undefined;
}

function requireTimestamp(
  value: unknown,
  code: OpenWikiErrorCode,
  label: string,
): string {
  if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
    throw new OpenWikiError(code, `${label} must be a canonical ISO-8601 timestamp.`);
  }
  return value;
}

function readOptionalTimestamp(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  return Object.hasOwn(record, key)
    ? requireTimestamp(record[key], "INVALID_ARGUMENT", label)
    : undefined;
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWikiMode(value: unknown): value is WikiMode {
  return typeof value === "string" && WIKI_MODE_SET.has(value);
}

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && SOURCE_KIND_SET.has(value);
}

function isSourceHost(value: unknown): value is SourceHost {
  return typeof value === "string" && SOURCE_HOST_SET.has(value);
}

function isWikiCommand(value: unknown): value is WikiCommand {
  return typeof value === "string" && WIKI_COMMAND_SET.has(value);
}

function isMetadataValue(value: unknown): value is SourceMetadataValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function utf8ByteLength(value: string): number {
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
