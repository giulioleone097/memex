import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { OPENWIKI_OPERATIONS, dispatch, readCliTransport, } from "./adapter.js";
import { MAX_ENVELOPE_BYTES } from "./contracts.js";
import { OpenWikiError } from "./errors.js";
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
export async function main(argv, stdinText) {
    const pretty = argv.includes("--pretty");
    try {
        const { operation, flags } = parseCli(argv);
        if (flags.json === true && flags.pretty === true)
            throw invalid("JSON and pretty output cannot be combined.");
        const request = await toRequest(operation, flags, stdinText ?? "");
        const result = await dispatch(request);
        output.write(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
        return result.ok ? 0 : 2;
    }
    catch (error) {
        return emitFailure(error, pretty);
    }
}
function parseCli(argv) {
    const operation = argv[0];
    if (!isOperation(operation))
        throw invalid("OpenWiki operation is required and must be recognized.");
    const flags = {};
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === undefined || !token.startsWith("--"))
            throw invalid("Arguments must use explicit long flags.");
        const key = token.slice(2);
        if (!VALUE_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key))
            throw invalid(`Unknown flag: ${token}.`);
        if (Object.hasOwn(flags, key))
            throw invalid(`Repeated flag: ${token}.`);
        if (BOOLEAN_FLAGS.has(key)) {
            flags[key] = true;
            continue;
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--"))
            throw invalid(`Flag ${token} requires a value.`);
        flags[key] = value;
        index += 1;
    }
    return { operation, flags };
}
async function toRequest(operation, flags, stdinText) {
    const inputValue = flagRecord(flags);
    delete inputValue.json;
    delete inputValue.pretty;
    for (const key of ["limit", "depth"]) {
        const value = inputValue[key];
        if (typeof value === "string")
            inputValue[key] = Number(value);
    }
    if (operation === "write") {
        const content = await readOneTransport(flags, "content", "content-file", stdinText);
        delete inputValue["content-file"];
        delete inputValue.stdin;
        inputValue.content = content;
    }
    else if (operation === "ingest") {
        const raw = await readIngestTransport(flags, stdinText);
        delete inputValue["envelope-file"];
        delete inputValue.stdin;
        try {
            inputValue.envelope = JSON.parse(raw);
        }
        catch {
            throw invalid("Source envelope input must be valid JSON.");
        }
    }
    else if (flags.stdin === true || flags["content-file"] !== undefined || flags["envelope-file"] !== undefined) {
        throw invalid("Input transport is incompatible with this operation.");
    }
    if (flags.disabled === true) {
        if (flags.enabled === true || operation !== "schedule")
            throw invalid("Disabled is only valid for schedule set.");
        delete inputValue.disabled;
        inputValue.enabled = false;
    }
    else {
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
async function readOneTransport(flags, inlineKey, fileKey, stdinText) {
    const inline = flags[inlineKey];
    const file = flags[fileKey];
    const stdin = flags.stdin;
    const selected = [inline !== undefined, file !== undefined && fileKey !== inlineKey, stdin === true].filter(Boolean).length;
    if (selected !== 1)
        throw invalid("Exactly one content transport is required.");
    if (inline !== undefined) {
        if (inline === true)
            throw invalid("Inline content requires text.");
        return inline;
    }
    if (file !== undefined) {
        if (file === true)
            throw invalid("Input file requires a path.");
        return readCliTransport(file);
    }
    return stdinText;
}
async function readIngestTransport(flags, stdinText) {
    const file = flags["envelope-file"];
    const stdin = flags.stdin;
    if ((file === undefined && stdin !== true) || (file !== undefined && stdin === true)) {
        throw invalid("Exactly one content transport is required.");
    }
    if (file === undefined)
        return enforceEnvelopeByteLimit(stdinText);
    if (file === true)
        throw invalid("Input file requires a path.");
    return readBoundedEnvelopeFile(file);
}
function flagRecord(flags) {
    return Object.fromEntries(Object.entries(flags));
}
function rename(input, from, to) {
    if (!Object.hasOwn(input, from))
        return;
    input[to] = input[from];
    Reflect.deleteProperty(input, from);
}
function isOperation(value) {
    return value !== undefined && OPENWIKI_OPERATIONS.some((operation) => operation === value);
}
function invalid(message) {
    return new OpenWikiError("INVALID_ARGUMENT", message);
}
async function readInputStream(maxBytes) {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (maxBytes !== undefined && totalBytes > maxBytes) {
            input.destroy();
            throw sourceEnvelopeTooLarge();
        }
        chunks.push(Buffer.from(bytes));
    }
    return Buffer.concat(chunks).toString("utf8");
}
function enforceEnvelopeByteLimit(value) {
    if (Buffer.byteLength(value, "utf8") > MAX_ENVELOPE_BYTES)
        throw sourceEnvelopeTooLarge();
    return value;
}
async function readBoundedEnvelopeFile(filePath) {
    try {
        const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile())
                throw new OpenWikiError("NOT_FOUND", "Input file could not be read.");
            if (stat.size > MAX_ENVELOPE_BYTES)
                throw sourceEnvelopeTooLarge();
            const chunks = [];
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let totalBytes = 0;
            for (;;) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0)
                    break;
                totalBytes += bytesRead;
                if (totalBytes > MAX_ENVELOPE_BYTES)
                    throw sourceEnvelopeTooLarge();
                chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            }
            return Buffer.concat(chunks).toString("utf8");
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error instanceof OpenWikiError)
            throw error;
        throw new OpenWikiError("NOT_FOUND", "Input file could not be read.");
    }
}
function sourceEnvelopeTooLarge() {
    return new OpenWikiError("SOURCE_TOO_LARGE", `Source envelope exceeds the ${String(MAX_ENVELOPE_BYTES)} byte limit.`);
}
function emitFailure(error, pretty) {
    const result = error instanceof OpenWikiError
        ? { ok: false, error: error.toJSON() }
        : { ok: false, error: { code: "IO_FAILURE", message: "OpenWiki operation failed unexpectedly." } };
    output.write(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
    return error instanceof OpenWikiError ? 2 : 1;
}
async function runProcessCli(argv) {
    try {
        const shouldReadStdin = argv.includes("--stdin");
        const stdinText = shouldReadStdin
            ? await readInputStream(argv[0] === "write" ? undefined : MAX_ENVELOPE_BYTES)
            : "";
        return await main(argv, stdinText);
    }
    catch (error) {
        return emitFailure(error, argv.includes("--pretty"));
    }
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
    const exitCode = await runProcessCli(process.argv.slice(2));
    process.exitCode = exitCode;
}
