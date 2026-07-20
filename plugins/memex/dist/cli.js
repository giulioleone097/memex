import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { TextDecoder } from "node:util";
import { GRAPH_ACTIONS, MEMEX_OPERATIONS, dispatch, readCliTransport, } from "./adapter.js";
import { MAX_ENVELOPE_BYTES } from "./contracts.js";
import { MemexError } from "./errors.js";
import { shutdownLadybugWasm } from "./ladybug-wasm.js";
const VALUE_FLAGS = new Set([
    "mode",
    "root",
    "page",
    "content",
    "content-file",
    "envelope-file",
    "query",
    "limit",
    "signals",
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
    "from",
    "to",
    "preference",
    "params",
    "phase",
]);
const BOOLEAN_FLAGS = new Set(["stdin", "force", "json", "pretty", "enabled", "disabled"]);
export async function main(argv, stdinText) {
    const pretty = argv.includes("--pretty");
    try {
        const help = helpText(argv);
        if (help !== undefined) {
            output.write(help);
            return 0;
        }
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
        throw invalid("Memex operation is required and must be recognized.");
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
    if (typeof inputValue.signals === "string") {
        inputValue.signals = inputValue.signals
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
    if (typeof inputValue.params === "string") {
        try {
            inputValue.params = JSON.parse(inputValue.params);
        }
        catch {
            throw invalid("Graph params must be valid JSON.");
        }
    }
    if (operation === "write") {
        const content = await readOneTransport(flags, "content", "content-file", stdinText);
        delete inputValue["content-file"];
        delete inputValue.stdin;
        inputValue.content = content;
    }
    else if (operation === "ingest" || operation === "enrich") {
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
    return value !== undefined && MEMEX_OPERATIONS.some((operation) => operation === value);
}
const OPERATION_USAGE = {
    init: "--mode <code|personal> [--root <path>]",
    status: "--mode <code|personal> [--root <path>]",
    context: "--root <path> [--previous-head <sha>]",
    search: "--mode <code|personal> [--root <path>] --query <text> [--limit <n>] [--signals <list>]",
    retrieval_health: "--mode <code|personal> [--root <path>]",
    ask: "--mode code --root <path> --query <text> [--limit <n>] [--signals <list>]",
    read: "--mode <code|personal> [--root <path>] --page <path>",
    write: "--mode <code|personal> [--root <path>] --page <path> (--content <text>|--content-file <path>|--stdin)",
    ingest: "--mode <code|personal> [--root <path>] (--envelope-file <path>|--stdin)",
    enrich: "--root <path> (--envelope-file <path>|--stdin)",
    finalize: "--mode <code|personal> [--root <path>] --command <init|update|ingest> --run-id <id> --started-at <iso> --summary <text>",
    check: "--mode <code|personal> [--root <path>] [--phase <preflight|strict>]",
    doctor: "--mode <code|personal> [--root <path>]",
    schedule: "--mode <code|personal> [--root <path>] --action <set|list|remove> [options]",
    purge: "--mode <code|personal> [--root <path>] --scope <raw|schedules|personal-wiki|all>",
    graph: "[--mode code] --root <path> --action <action> [action options]",
    migrate: "",
};
const GRAPH_ACTION_USAGE = {
    build: "--root <path> --action build [--mode code] [--force]",
    status: "--root <path> --action status [--mode code]",
    query: "--root <path> --action query --query <text> [--mode code] [--limit <1-100>]",
    context: "--root <path> --action context --target <symbol> [--mode code] [--limit <1-100>]",
    impact: "--root <path> --action impact --target <symbol> [--mode code] [--direction <inbound|outbound|both>] [--depth <1-5>] [--limit <1-100>]",
    changes: "--root <path> --action changes [--mode code] [--base <git-ref>] [--limit <1-100>]",
    map: "--root <path> --action map [--mode code] [--limit <1-100>]",
    path: "--root <path> --action path --from <symbol> --to <symbol> [--mode code] [--limit <1-100>]",
    explain: "--root <path> --action explain --target <symbol> [--mode code] [--limit <1-100>]",
    communities: "--root <path> --action communities [--mode code] [--limit <1-100>]",
    report: "--root <path> --action report [--mode code]",
    cypher: "--root <path> --action cypher --query <statement> [--mode code] [--params <json>] [--preference <auto|native|wasm|pure>] [--limit <1-100>]",
};
function helpText(argv) {
    if (argv.length === 1 && argv[0] === "--help") {
        return [
            "Usage: memex <operation> [options]",
            "",
            "Operations:",
            ...MEMEX_OPERATIONS.map((operation) => `  ${operation}`),
            "",
            "Run 'memex <operation> --help' for operation usage.",
            "Output is JSON unless help is requested.",
            "",
        ].join("\n");
    }
    if (argv.length === 4 && argv[0] === "graph" && argv[1] === "--action" && argv[3] === "--help") {
        const action = GRAPH_ACTIONS.find((candidate) => candidate === argv[2]);
        if (action === undefined) {
            throw invalid("Graph help action must be recognized.");
        }
        return `Usage: memex graph ${GRAPH_ACTION_USAGE[action]}\n`;
    }
    if (argv.length === 2 && argv[1] === "--help" && isOperation(argv[0])) {
        if (argv[0] === "graph") {
            return [
                `Usage: memex graph ${OPERATION_USAGE.graph}`,
                "",
                "Actions (required flags are unbracketed; allowed optional flags are bracketed):",
                ...GRAPH_ACTIONS.map((action) => `  ${action}: ${GRAPH_ACTION_USAGE[action]}`),
                "",
                "Run 'memex graph --action <action> --help' for one action.",
                "",
            ].join("\n");
        }
        const suffix = OPERATION_USAGE[argv[0]];
        return `Usage: memex ${argv[0]}${suffix === "" ? "" : ` ${suffix}`}\n`;
    }
    return undefined;
}
function invalid(message) {
    return new MemexError("INVALID_ARGUMENT", message);
}
async function readInputStream(maxBytes, strictUtf8 = false) {
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
    const value = Buffer.concat(chunks);
    return strictUtf8 ? decodeEnvelopeUtf8(value) : value.toString("utf8");
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
                throw new MemexError("NOT_FOUND", "Input file could not be read.");
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
            return decodeEnvelopeUtf8(Buffer.concat(chunks));
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error instanceof MemexError)
            throw error;
        throw new MemexError("NOT_FOUND", "Input file could not be read.");
    }
}
function sourceEnvelopeTooLarge() {
    return new MemexError("SOURCE_TOO_LARGE", `Source envelope exceeds the ${String(MAX_ENVELOPE_BYTES)} byte limit.`);
}
function decodeEnvelopeUtf8(value) {
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    }
    catch {
        throw invalid("Source envelope input must be valid UTF-8.");
    }
}
function emitFailure(error, pretty) {
    const result = error instanceof MemexError
        ? { ok: false, error: error.toJSON() }
        : { ok: false, error: { code: "IO_FAILURE", message: "Memex operation failed unexpectedly." } };
    output.write(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
    return error instanceof MemexError ? 2 : 1;
}
async function runProcessCli(argv) {
    try {
        const shouldReadStdin = argv.includes("--stdin");
        const stdinText = shouldReadStdin
            ? await readInputStream(argv[0] === "write" ? undefined : MAX_ENVELOPE_BYTES, argv[0] === "ingest" || argv[0] === "enrich")
            : "";
        return await main(argv, stdinText);
    }
    catch (error) {
        return emitFailure(error, argv.includes("--pretty"));
    }
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
    const exitCode = await runProcessCli(process.argv.slice(2));
    // Terminate the LadybugDB wasm worker thread (if a Cypher command started it)
    // so this one-shot process exits cleanly. No-op when the wasm tier was unused.
    await shutdownLadybugWasm();
    process.exitCode = exitCode;
}
