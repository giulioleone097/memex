import { stdin as input, stdout as output } from "node:process";

import {
  OPENWIKI_OPERATIONS,
  dispatch,
  readCliTransport,
  type OpenWikiOperation,
} from "./adapter.js";
import { OpenWikiError } from "./errors.js";

type FlagValue = string | true;
type ParsedFlags = Record<string, FlagValue>;

const VALUE_FLAGS = new Set([
  "mode",
  "root",
  "page",
  "content",
  "content-file",
  "envelope-file",
  "query",
  "limit",
  "command",
  "run-id",
  "started-at",
  "completed-at",
  "summary",
  "last-git-head",
  "previous-head",
  "action",
  "id",
  "operation",
  "cron",
  "timezone",
  "source-id",
  "scope",
  "target",
  "base",
  "direction",
  "depth",
]);
const BOOLEAN_FLAGS = new Set(["stdin", "force", "json", "pretty", "enabled", "disabled"]);

export async function main(argv: readonly string[], stdinText?: string): Promise<number> {
  const pretty = argv.includes("--pretty");
  try {
    const { operation, flags } = parseCli(argv);
    if (flags.json === true && flags.pretty === true) throw invalid("JSON and pretty output cannot be combined.");
    const request = await toRequest(operation, flags, stdinText ?? "");
    const result = await dispatch(request);
    output.write(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
    return result.ok ? 0 : 2;
  } catch (error) {
    const result = error instanceof OpenWikiError
      ? { ok: false as const, error: error.toJSON() }
      : { ok: false as const, error: { code: "IO_FAILURE", message: "OpenWiki operation failed unexpectedly." } };
    output.write(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
    return error instanceof OpenWikiError ? 2 : 1;
  }
}

function parseCli(argv: readonly string[]): { operation: OpenWikiOperation; flags: ParsedFlags } {
  const operation = argv[0];
  if (!isOperation(operation)) throw invalid("OpenWiki operation is required and must be recognized.");
  const flags: ParsedFlags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) throw invalid("Arguments must use explicit long flags.");
    const key = token.slice(2);
    if (!VALUE_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key)) throw invalid(`Unknown flag: ${token}.`);
    if (Object.hasOwn(flags, key)) throw invalid(`Repeated flag: ${token}.`);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw invalid(`Flag ${token} requires a value.`);
    flags[key] = value;
    index += 1;
  }
  return { operation, flags };
}

async function toRequest(operation: OpenWikiOperation, flags: ParsedFlags, stdinText: string): Promise<{ operation: OpenWikiOperation; input: Record<string, unknown> }> {
  const inputValue: Record<string, unknown> = flagRecord(flags);
  delete inputValue.json;
  delete inputValue.pretty;
  for (const key of ["limit", "depth"]) {
    const value = inputValue[key];
    if (typeof value === "string") inputValue[key] = Number(value);
  }
  if (operation === "write") {
    const content = await readOneTransport(flags, "content", "content-file", stdinText);
    delete inputValue["content-file"];
    delete inputValue.stdin;
    inputValue.content = content;
  } else if (operation === "ingest") {
    const raw = await readIngestTransport(flags, stdinText);
    delete inputValue["envelope-file"];
    delete inputValue.stdin;
    try {
      inputValue.envelope = JSON.parse(raw);
    } catch {
      throw invalid("Source envelope input must be valid JSON.");
    }
  } else if (flags.stdin === true || flags["content-file"] !== undefined || flags["envelope-file"] !== undefined) {
    throw invalid("Input transport is incompatible with this operation.");
  }
  if (flags.disabled === true) {
    if (flags.enabled === true || operation !== "schedule") throw invalid("Disabled is only valid for schedule set.");
    delete inputValue.disabled;
    inputValue.enabled = false;
  } else {
    delete inputValue.disabled;
  }
  rename(inputValue, "run-id", "runId");
  rename(inputValue, "started-at", "startedAt");
  rename(inputValue, "completed-at", "completedAt");
  rename(inputValue, "last-git-head", "lastGitHead");
  rename(inputValue, "previous-head", "previousHead");
  rename(inputValue, "source-id", "sourceId");
  return { operation, input: inputValue };
}

async function readOneTransport(flags: ParsedFlags, inlineKey: string, fileKey: string, stdinText: string): Promise<string> {
  const inline = flags[inlineKey];
  const file = flags[fileKey];
  const stdin = flags.stdin;
  const selected = [inline !== undefined, file !== undefined && fileKey !== inlineKey, stdin === true].filter(Boolean).length;
  if (selected !== 1) throw invalid("Exactly one content transport is required.");
  if (inline !== undefined) {
    if (inline === true) throw invalid("Inline content requires text.");
    return inline;
  }
  if (file !== undefined) {
    if (file === true) throw invalid("Input file requires a path.");
    return readCliTransport(file);
  }
  return stdinText;
}

async function readIngestTransport(flags: ParsedFlags, stdinText: string): Promise<string> {
  const file = flags["envelope-file"];
  const stdin = flags.stdin;
  if ((file === undefined && stdin !== true) || (file !== undefined && stdin === true)) {
    throw invalid("Exactly one content transport is required.");
  }
  if (file === undefined) return stdinText;
  if (file === true) throw invalid("Input file requires a path.");
  return readCliTransport(file);
}

function flagRecord(flags: ParsedFlags): Record<string, unknown> {
  return Object.fromEntries(Object.entries(flags));
}

function rename(input: Record<string, unknown>, from: string, to: string): void {
  if (!Object.hasOwn(input, from)) return;
  input[to] = input[from];
  Reflect.deleteProperty(input, from);
}

function isOperation(value: string | undefined): value is OpenWikiOperation {
  return value !== undefined && OPENWIKI_OPERATIONS.some((operation) => operation === value);
}

function invalid(message: string): OpenWikiError {
  return new OpenWikiError("INVALID_ARGUMENT", message);
}

async function readStdin(): Promise<string> {
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) {
    if (typeof chunk !== "string") continue;
    value += chunk;
  }
  return value;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const exitCode = await main(process.argv.slice(2), await readStdin());
  process.exitCode = exitCode;
}
