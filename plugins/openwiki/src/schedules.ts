import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, withWikiLock } from "./atomic.js";
import { OpenWikiError, type OpenWikiErrorCode } from "./errors.js";
import type { WikiLocation } from "./paths.js";
import { containsSensitive } from "./redact.js";

export const SCHEDULE_COMMANDS = ["update", "ingest"] as const;
export type ScheduleCommand = (typeof SCHEDULE_COMMANDS)[number];

export interface ScheduleIntentV1 {
  schemaVersion: 1;
  id: string;
  command: ScheduleCommand;
  cron: string;
  timezone?: string;
  enabled: boolean;
  sourceId?: string;
}

export interface SetScheduleOptions {
  location: WikiLocation;
  schedule: unknown;
}

export interface SetScheduleResult {
  changed: boolean;
  schedule: ScheduleIntentV1;
}

export interface RemoveScheduleOptions {
  location: WikiLocation;
  id: string;
}

export interface RemoveScheduleResult {
  id: string;
  removed: boolean;
}

interface ScheduleStoreV1 {
  schemaVersion: 1;
  schedules: ScheduleIntentV1[];
}

const SCHEDULES_FILE_NAME = "schedules.json";
const MAX_SCHEDULE_STATE_BYTES = 1024 * 1024;
const SCHEDULE_KEYS = new Set([
  "schemaVersion",
  "id",
  "command",
  "cron",
  "timezone",
  "enabled",
  "sourceId",
]);
const SCHEDULE_STORE_KEYS = new Set(["schemaVersion", "schedules"]);
const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CRON_FIELD_PATTERN = /^[A-Za-z0-9*/,-]+$/u;
const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

interface CronFieldSpec {
  minimum: number;
  maximum: number;
  names?: readonly string[];
}

const CRON_FIELD_SPECS: readonly CronFieldSpec[] = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12, names: MONTH_NAMES },
  { minimum: 0, maximum: 7, names: WEEKDAY_NAMES },
];

export async function setSchedule(
  options: SetScheduleOptions,
): Promise<SetScheduleResult> {
  const schedule = parseSchedule(options.schedule, "INVALID_ARGUMENT");
  await ensureDataRoot(options.location.dataRoot);

  return withWikiLock(options.location.dataRoot, async () => {
    const current = await readScheduleStore(options.location);
    const existingIndex = current.schedules.findIndex(
      (candidate) => candidate.id === schedule.id,
    );
    const existing = current.schedules[existingIndex];
    if (existing !== undefined && schedulesEqual(existing, schedule)) {
      return { changed: false, schedule };
    }

    const schedules = [...current.schedules];
    if (existingIndex === -1) {
      schedules.push(schedule);
    } else {
      schedules[existingIndex] = schedule;
    }
    schedules.sort((left, right) => compareStrings(left.id, right.id));
    await writeScheduleStore(options.location, { schemaVersion: 1, schedules });
    return { changed: true, schedule };
  });
}

export async function listSchedules(
  location: WikiLocation,
): Promise<ScheduleIntentV1[]> {
  if (!(await dataRootExists(location.dataRoot))) {
    return [];
  }
  return (await readScheduleStore(location)).schedules;
}

export async function removeSchedule(
  options: RemoveScheduleOptions,
): Promise<RemoveScheduleResult> {
  const id = parseScheduleId(options.id, "INVALID_ARGUMENT");
  if (!(await dataRootExists(options.location.dataRoot))) {
    return { id, removed: false };
  }

  return withWikiLock(options.location.dataRoot, async () => {
    const current = await readScheduleStore(options.location);
    const schedules = current.schedules.filter((schedule) => schedule.id !== id);
    if (schedules.length === current.schedules.length) {
      return { id, removed: false };
    }
    await writeScheduleStore(options.location, { schemaVersion: 1, schedules });
    return { id, removed: true };
  });
}

function parseSchedule(
  input: unknown,
  code: OpenWikiErrorCode,
): ScheduleIntentV1 {
  const schedule = requireRecord(input, code, "Schedule intent must be an object.");
  requireKnownKeys(schedule, SCHEDULE_KEYS, code, "Schedule intent");
  if (schedule.schemaVersion !== 1) {
    throw new OpenWikiError(code, "Schedule intent schema version must be 1.");
  }
  if (!isScheduleCommand(schedule.command)) {
    throw new OpenWikiError(code, "Schedule command must be update or ingest.");
  }

  const id = parseScheduleId(schedule.id, code);
  const cron = parseCron(schedule.cron, code);
  const timezone = Object.hasOwn(schedule, "timezone")
    ? parseTimezone(schedule.timezone, code)
    : undefined;
  if (typeof schedule.enabled !== "boolean") {
    throw new OpenWikiError(code, "Schedule enabled must be a boolean.");
  }
  const sourceId = Object.hasOwn(schedule, "sourceId")
    ? parseSourceId(schedule.sourceId, code)
    : undefined;

  if (schedule.command === "ingest" && sourceId === undefined) {
    throw new OpenWikiError(code, "Ingest schedules require a sourceId.");
  }
  if (schedule.command === "update" && sourceId !== undefined) {
    throw new OpenWikiError(code, "Update schedules must not include a sourceId.");
  }

  const parsed: ScheduleIntentV1 = {
    schemaVersion: 1,
    id,
    command: schedule.command,
    cron,
    ...(timezone === undefined ? {} : { timezone }),
    enabled: schedule.enabled,
    ...(sourceId === undefined ? {} : { sourceId }),
  };
  if (containsSensitive(parsed)) {
    throw new OpenWikiError(
      code,
      "Schedule intent must not contain credential-shaped values.",
    );
  }
  return parsed;
}

function parseScheduleStore(input: unknown): ScheduleStoreV1 {
  const store = requireRecord(
    input,
    "INVALID_STATE",
    "Schedule state must be an object.",
  );
  requireKnownKeys(store, SCHEDULE_STORE_KEYS, "INVALID_STATE", "Schedule state");
  if (store.schemaVersion !== 1 || !Array.isArray(store.schedules)) {
    throw new OpenWikiError("INVALID_STATE", "Schedule state is invalid.");
  }

  const schedules = store.schedules.map((schedule) =>
    parseSchedule(schedule, "INVALID_STATE"),
  );
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) {
      throw new OpenWikiError(
        "INVALID_STATE",
        "Schedule state contains duplicate ids.",
      );
    }
    ids.add(schedule.id);
  }
  schedules.sort((left, right) => compareStrings(left.id, right.id));
  return { schemaVersion: 1, schedules };
}

async function readScheduleStore(location: WikiLocation): Promise<ScheduleStoreV1> {
  const filePath = path.join(location.dataRoot, SCHEDULES_FILE_NAME);
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_SCHEDULE_STATE_BYTES) {
      throw new OpenWikiError("INVALID_STATE", "Schedule state is invalid.");
    }
    const content = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new OpenWikiError("INVALID_STATE", "Schedule state is not valid JSON.");
    }
    return parseScheduleStore(parsed);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { schemaVersion: 1, schedules: [] };
    }
    if (isSymlinkError(error)) {
      throw new OpenWikiError(
        "SYMLINK_ESCAPE",
        "Schedule state must not be a symbolic link.",
      );
    }
    if (error instanceof OpenWikiError) {
      throw error;
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to read schedule state.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeScheduleStore(
  location: WikiLocation,
  store: ScheduleStoreV1,
): Promise<void> {
  const validated = parseScheduleStore(store);
  await atomicWriteFile(
    path.join(location.dataRoot, SCHEDULES_FILE_NAME),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

async function ensureDataRoot(dataRoot: string): Promise<void> {
  const existing = await inspectPath(dataRoot);
  if (existing?.isSymbolicLink()) {
    throw new OpenWikiError(
      "SYMLINK_ESCAPE",
      "Schedule storage must not be a symbolic link.",
    );
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new OpenWikiError("IO_FAILURE", "Schedule storage is invalid.");
  }
  if (existing !== null) {
    return;
  }

  try {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const created = await lstat(dataRoot);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new OpenWikiError(
        "SYMLINK_ESCAPE",
        "Schedule storage must not be a symbolic link.",
      );
    }
  } catch (error) {
    if (error instanceof OpenWikiError) {
      throw error;
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to create schedule storage.");
  }
}

async function dataRootExists(dataRoot: string): Promise<boolean> {
  const status = await inspectPath(dataRoot);
  if (status === null) {
    return false;
  }
  if (status.isSymbolicLink()) {
    throw new OpenWikiError(
      "SYMLINK_ESCAPE",
      "Schedule storage must not be a symbolic link.",
    );
  }
  if (!status.isDirectory()) {
    throw new OpenWikiError("IO_FAILURE", "Schedule storage is invalid.");
  }
  return true;
}

async function inspectPath(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw new OpenWikiError("IO_FAILURE", "Unable to inspect schedule storage.");
  }
}

function schedulesEqual(left: ScheduleIntentV1, right: ScheduleIntentV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseScheduleId(value: unknown, code: OpenWikiErrorCode): string {
  if (typeof value !== "string" || !SCHEDULE_ID_PATTERN.test(value)) {
    throw new OpenWikiError(code, "Schedule id is invalid.");
  }
  return value;
}

function parseCron(value: unknown, code: OpenWikiErrorCode): string {
  if (typeof value !== "string" || value.length > 256 || value.includes("\0")) {
    throw new OpenWikiError(code, "Schedule cron expression is invalid.");
  }
  const fields = value.trim().split(/\s+/u);
  if (
    fields.length !== CRON_FIELD_SPECS.length ||
    fields.some((field, index) => {
      const spec = CRON_FIELD_SPECS[index];
      return spec === undefined || !isCronField(field, spec);
    })
  ) {
    throw new OpenWikiError(code, "Schedule cron expression is invalid.");
  }
  return fields.join(" ");
}

function isCronField(field: string, spec: CronFieldSpec): boolean {
  if (!CRON_FIELD_PATTERN.test(field)) {
    return false;
  }
  return field.split(",").every((segment) => isCronSegment(segment, spec));
}

function isCronSegment(segment: string, spec: CronFieldSpec): boolean {
  const stepParts = segment.split("/");
  if (stepParts.length > 2) {
    return false;
  }
  const base = stepParts[0];
  const step = stepParts[1];
  if (base === undefined || base.length === 0) {
    return false;
  }
  if (step !== undefined) {
    const parsedStep = parseCronNumber(step);
    if (
      parsedStep === null ||
      parsedStep < 1 ||
      parsedStep > spec.maximum - spec.minimum + 1
    ) {
      return false;
    }
  }
  if (base === "*") {
    return true;
  }

  const range = base.split("-");
  if (range.length === 1) {
    return parseCronValue(base, spec) !== null;
  }
  if (range.length !== 2) {
    return false;
  }
  const start = range[0] === undefined ? null : parseCronValue(range[0], spec);
  const end = range[1] === undefined ? null : parseCronValue(range[1], spec);
  return start !== null && end !== null && start <= end;
}

function parseCronValue(value: string, spec: CronFieldSpec): number | null {
  const normalized = value.toUpperCase();
  const namedIndex = spec.names?.indexOf(normalized);
  const parsed =
    namedIndex === undefined || namedIndex === -1
      ? parseCronNumber(value)
      : spec.minimum + namedIndex;
  if (parsed === null || parsed < spec.minimum || parsed > spec.maximum) {
    return null;
  }
  return parsed;
}

function parseCronNumber(value: string): number | null {
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseTimezone(value: unknown, code: OpenWikiErrorCode): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new OpenWikiError(code, "Schedule timezone is invalid.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new OpenWikiError(code, "Schedule timezone is invalid.");
  }
  return value;
}

function parseSourceId(value: unknown, code: OpenWikiErrorCode): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new OpenWikiError(code, "Schedule sourceId is invalid.");
  }
  return value;
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
  knownKeys: ReadonlySet<string>,
  code: OpenWikiErrorCode,
  label: string,
): void {
  if (Object.keys(value).some((key) => !knownKeys.has(key))) {
    throw new OpenWikiError(code, `${label} contains unsupported fields.`);
  }
}

function isScheduleCommand(value: unknown): value is ScheduleCommand {
  return value === "update" || value === "ingest";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isSymlinkError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOOP";
}
