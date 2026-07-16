import { stdin, stdout } from "node:process";
import { TextDecoder } from "node:util";

import { OPENWIKI_OPERATIONS, dispatch, type OpenWikiOperation } from "./adapter.js";
import { MAX_ENVELOPE_BYTES } from "./contracts.js";

const CURRENT_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = new Set([CURRENT_PROTOCOL, "2025-06-18"]);
// JSON-RPC adds method, id, and tool-wrapper fields around a source envelope.
const MCP_ENVELOPE_WRAPPER_BYTES = 64 * 1024;
export const MAX_MCP_FRAME_BYTES = MAX_ENVELOPE_BYTES + MCP_ENVELOPE_WRAPPER_BYTES;
type JsonRecord = Record<string, unknown>;

interface ToolDefinition {
  name: OpenWikiOperation;
  description: string;
  inputSchema: JsonRecord;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const root = { type: "string", minLength: 1 };
const mode = { type: "string", enum: ["code", "personal"] };
const limit = { type: "integer", minimum: 1, maximum: 100 };
const signals = { type: "array", items: { type: "string", enum: ["lexical", "vector", "graph"] }, minItems: 1 };
const commonMode = (properties: JsonRecord, required: string[]): JsonRecord => ({ type: "object", additionalProperties: false, properties: { mode, ...properties }, required: ["mode", ...required] });
const tools: readonly ToolDefinition[] = [
  tool("init", "Initialize an OpenWiki workspace.", commonMode({ root }, []), [false, false, true, false]),
  tool("status", "Read OpenWiki state and source summaries.", commonMode({ root }, []), [true, false, false, false]),
  tool("context", "Collect bounded Git repository context.", object({ root, previousHead: { type: "string", minLength: 1 } }, ["root"]), [true, false, false, false]),
  tool("search", "Search grounded wiki pages and code with hybrid lexical, vector, and graph retrieval.", commonMode({ root, query: { type: "string", minLength: 1 }, limit, signals }, ["query"]), [true, false, false, false]),
  tool("ask", "Ask a question and receive a cited, bounded evidence bundle over hybrid retrieval and graph expansion.", commonMode({ root, query: { type: "string", minLength: 1 }, limit, signals }, ["query"]), [true, false, false, false]),
  tool("read", "Read one grounded wiki page.", commonMode({ root, page: { type: "string", minLength: 1 } }, ["page"]), [true, false, false, false]),
  tool("write", "Write one confined wiki page.", commonMode({ root, page: { type: "string", minLength: 1 }, content: { type: "string" } }, ["page", "content"]), [false, true, true, false]),
  tool("ingest", "Store one validated source envelope.", commonMode({ root, envelope: { type: "object", additionalProperties: true } }, ["envelope"]), [false, true, true, false]),
  tool("enrich", "Store one validated concept/page enrichment envelope, grounded in graph evidence.", object({ root, envelope: { type: "object", additionalProperties: true } }, ["root", "envelope"]), [false, true, true, false]),
  tool("finalize", "Finalize a wiki update run.", commonMode({ root, command: { type: "string", enum: ["init", "update", "ingest"] }, runId: { type: "string", minLength: 1 }, startedAt: { type: "string", minLength: 1 }, completedAt: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, lastGitHead: { type: "string", minLength: 1 } }, ["command", "runId", "startedAt", "summary"]), [false, true, true, false]),
  tool("check", "Check wiki integrity.", commonMode({ root }, []), [true, false, false, false]),
  tool("doctor", "Run local runtime diagnostics.", commonMode({ root }, []), [true, false, false, false]),
  tool("schedule", "Set, list, or remove local schedule intent.", scheduleSchema(), [false, true, true, false]),
  tool("purge", "Purge selected local OpenWiki data.", commonMode({ root, scope: { type: "string", enum: ["raw", "schedules", "personal-wiki", "all"] } }, ["scope"]), [false, true, true, false]),
  tool("graph", "Build or query the native bounded code graph.", graphSchema(), [false, true, true, false]),
];

function tool(name: OpenWikiOperation, description: string, inputSchema: JsonRecord, annotationValues: readonly boolean[]): ToolDefinition {
  if (annotationValues.length !== 4) throw new Error("OpenWiki MCP tool annotations must be complete.");
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: annotationValues[0] ?? false,
      destructiveHint: annotationValues[1] ?? false,
      idempotentHint: annotationValues[2] ?? false,
      openWorldHint: annotationValues[3] ?? false,
    },
  };
}

function object(properties: JsonRecord, required: string[]): JsonRecord {
  return { type: "object", additionalProperties: false, properties, required };
}

function graphSchema(): JsonRecord {
  return {
    oneOf: [
      object({ action: { const: "build" }, root, force: { type: "boolean" } }, ["action", "root"]),
      object({ action: { const: "status" }, root }, ["action", "root"]),
      object({ action: { const: "query" }, root, query: { type: "string", minLength: 1 }, limit }, ["action", "root", "query"]),
      object({ action: { const: "context" }, root, target: { type: "string", minLength: 1 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "impact" }, root, target: { type: "string", minLength: 1 }, direction: { type: "string", enum: ["inbound", "outbound", "both"] }, depth: { type: "integer", minimum: 1, maximum: 5 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "changes" }, root, base: { type: "string", minLength: 1 }, limit }, ["action", "root"]),
      object({ action: { const: "map" }, root, limit }, ["action", "root"]),
      object({ action: { const: "path" }, root, from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 }, limit }, ["action", "root", "from", "to"]),
      object({ action: { const: "explain" }, root, target: { type: "string", minLength: 1 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "communities" }, root, limit }, ["action", "root"]),
      object({ action: { const: "report" }, root }, ["action", "root"]),
    ],
  };
}

function scheduleSchema(): JsonRecord {
  return {
    oneOf: [
      commonMode({ root, action: { const: "list" } }, ["action"]),
      commonMode({ root, action: { const: "remove" }, id: { type: "string", minLength: 1 } }, ["action", "id"]),
      commonMode({ root, action: { const: "set" }, id: { type: "string", minLength: 1 }, operation: { type: "string", enum: ["update", "ingest"] }, cron: { type: "string", minLength: 1 }, timezone: { type: "string", minLength: 1 }, sourceId: { type: "string", minLength: 1 }, enabled: { type: "boolean" } }, ["action", "id", "operation", "cron"]),
    ],
  };
}

let initialized = false;
let ready = false;

function emit(message: JsonRecord): void {
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function error(id: unknown, code: number, message: string): void {
  emit({ id: isIdentifier(id) ? id : null, error: { code, message } });
}

async function handle(line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    error(null, -32700, "Parse error.");
    return;
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    if (isRecord(parsed) && !Object.hasOwn(parsed, "id")) return;
    error(isRecord(parsed) ? parsed.id : null, -32600, "Invalid Request.");
    return;
  }
  const notification = !Object.hasOwn(parsed, "id");
  const id = parsed.id;
  const params = parsed.params;
  if (parsed.method === "notifications/initialized") {
    if (initialized && (params === undefined || isRecord(params))) ready = true;
    return;
  }
  if (notification) return;
  if (!isIdentifier(id)) {
    error(null, -32600, "Invalid Request.");
    return;
  }
  if (parsed.method === "ping") {
    if (params !== undefined && !isEmptyObject(params)) {
      error(id, -32602, "Invalid params.");
      return;
    }
    emit({ id, result: {} });
    return;
  }
  if (parsed.method === "initialize") {
    if (!isRecord(params) || typeof params.protocolVersion !== "string") {
      error(id, -32602, "Invalid params.");
      return;
    }
    initialized = true;
    ready = false;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(params.protocolVersion) ? params.protocolVersion : CURRENT_PROTOCOL;
    emit({ id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "openwiki", version: "0.1.0" } } });
    return;
  }
  if (!ready) {
    error(id, -32002, "Server is not initialized.");
    return;
  }
  if (parsed.method === "tools/list") {
    if (params !== undefined && !isEmptyObject(params)) {
      error(id, -32602, "Invalid params.");
      return;
    }
    emit({ id, result: { tools } });
    return;
  }
  if (parsed.method === "tools/call") {
    if (!isRecord(params) || !isOperation(params.name) || !isRecord(params.arguments)) {
      error(id, -32602, "Invalid params.");
      return;
    }
    const result = await dispatch({ operation: params.name, input: params.arguments });
    emit({ id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok } });
    return;
  }
  error(id, -32601, "Method not found.");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isIdentifier(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isOperation(value: unknown): value is OpenWikiOperation {
  return typeof value === "string" && OPENWIKI_OPERATIONS.some((operation) => operation === value);
}

let queue: Promise<void> = Promise.resolve();
let frameChunks: Buffer[] = [];
let frameBytes = 0;
let discardingOversizedFrame = false;

stdin.on("data", (chunk: Buffer | string) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline;
    if (discardingOversizedFrame) {
      if (newline === -1) return;
      discardingOversizedFrame = false;
      start = newline + 1;
      continue;
    }

    const fragment = bytes.subarray(start, end);
    if (frameBytes + fragment.length > MAX_MCP_FRAME_BYTES) {
      frameChunks = [];
      frameBytes = 0;
      discardingOversizedFrame = newline === -1;
      queue = queue.then(() => {
        error(null, -32600, "Request exceeds the maximum frame size.");
      });
      if (newline === -1) return;
      start = newline + 1;
      continue;
    }

    frameChunks.push(fragment);
    frameBytes += fragment.length;
    if (newline === -1) return;
    const line = decodeFrame();
    frameChunks = [];
    frameBytes = 0;
    if (line !== undefined) queue = queue.then(() => handle(line));
    start = newline + 1;
  }
});
stdin.on("end", () => {
  if (!discardingOversizedFrame && frameBytes > 0) {
    const line = decodeFrame();
    if (line !== undefined) queue = queue.then(() => handle(line));
  }
});

function decodeFrame(): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(frameChunks, frameBytes))
      .replace(/\r$/u, "");
  } catch {
    queue = queue.then(() => {
      error(null, -32700, "Parse error.");
    });
    return undefined;
  }
}
