import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import {
  MCP_PATH,
  assertAdapterExists,
  createMcpSession,
  initializeGitRepository,
  makeIsolatedEnvironment,
  makeTemporaryRoot,
} from "../fixtures/adapter/process-harness.mjs";

const CURRENT_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = [CURRENT_PROTOCOL, "2025-06-18"];
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_MCP_FRAME_BYTES = MAX_ENVELOPE_BYTES + 64 * 1024;
const TOOL_NAMES = [
  "init",
  "status",
  "context",
  "search",
  "ask",
  "read",
  "write",
  "ingest",
  "enrich",
  "finalize",
  "check",
  "doctor",
  "schedule",
  "purge",
  "graph",
];

const STABLE_ANNOTATIONS = {
  init: [false, false, true, false],
  status: [true, false, false, false],
  context: [true, false, false, false],
  search: [true, false, false, false],
  ask: [true, false, false, false],
  read: [true, false, false, false],
  write: [false, true, true, false],
  enrich: [false, true, true, false],
  finalize: [false, true, true, false],
  check: [true, false, false, false],
  graph: [false, true, true, false],
};

before(() => assertAdapterExists(MCP_PATH, "MCP"));

async function initialize(session, id, protocolVersion = CURRENT_PROTOCOL) {
  session.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "openwiki-adapter-test", version: "1.0.0" },
    },
  });
  const response = await session.nextMessage();
  assert.equal(response.id, id);
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(typeof response.result.serverInfo.name, "string");
  assert.equal(typeof response.result.serverInfo.version, "string");
  return response;
}

async function makeReady(session, id = 1) {
  const initialized = await initialize(session, id);
  assert.equal(initialized.result.protocolVersion, CURRENT_PROTOCOL);
  session.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
}

async function request(session, id, method, params) {
  const message = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  session.send(message);
  const response = await session.nextMessage();
  assert.equal(response.id, id);
  return response;
}

function parseToolEnvelope(response, isError) {
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, isError);
  assert.ok(Array.isArray(response.result.content));
  assert.deepEqual(
    response.result.content.map(({ type }) => type),
    ["text"],
  );
  return JSON.parse(response.result.content[0].text);
}

function assertClosedStructuralObjects(schema, location = "inputSchema") {
  if (schema === null || typeof schema !== "object") return;
  if (schema.type === "object" && schema.properties !== undefined) {
    assert.equal(
      schema.additionalProperties,
      false,
      `${location} structural object must set additionalProperties:false`,
    );
  }
  for (const keyword of ["properties", "$defs", "definitions"]) {
    if (schema[keyword] !== undefined) {
      for (const [name, child] of Object.entries(schema[keyword])) {
        assertClosedStructuralObjects(child, `${location}.${keyword}.${name}`);
      }
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const [index, child] of (schema[keyword] ?? []).entries()) {
      assertClosedStructuralObjects(child, `${location}.${keyword}[${String(index)}]`);
    }
  }
  if (schema.items !== undefined) assertClosedStructuralObjects(schema.items, `${location}.items`);
  if (schema.if !== undefined) assertClosedStructuralObjects(schema.if, `${location}.if`);
  if (schema.then !== undefined) assertClosedStructuralObjects(schema.then, `${location}.then`);
  if (schema.else !== undefined) assertClosedStructuralObjects(schema.else, `${location}.else`);
}

function assertAnnotations(tool, expected) {
  const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = expected;
  assert.equal(tool.annotations.readOnlyHint, readOnlyHint, tool.name);
  assert.equal(tool.annotations.destructiveHint, destructiveHint, tool.name);
  assert.equal(tool.annotations.idempotentHint, idempotentHint, tool.name);
  assert.equal(tool.annotations.openWorldHint, openWorldHint, tool.name);
}

function graphBranches(tool) {
  assert.equal(JSON.stringify(tool).toLowerCase().includes("gitnexus"), false);
  assert.equal(JSON.stringify(tool).includes("provider"), false);
  assert.ok(Array.isArray(tool.inputSchema.oneOf));
  assert.equal(tool.inputSchema.oneOf.length, 7);
  return new Map(
    tool.inputSchema.oneOf.map((branch) => [branch.properties.action.const, branch]),
  );
}

function assertGraphSchema(tool) {
  const branches = graphBranches(tool);
  const expected = {
    build: { properties: ["action", "force", "root"], required: ["action", "root"] },
    status: { properties: ["action", "root"], required: ["action", "root"] },
    query: { properties: ["action", "limit", "query", "root"], required: ["action", "query", "root"] },
    context: { properties: ["action", "limit", "root", "target"], required: ["action", "root", "target"] },
    impact: {
      properties: ["action", "depth", "direction", "limit", "root", "target"],
      required: ["action", "root", "target"],
    },
    changes: { properties: ["action", "base", "limit", "root"], required: ["action", "root"] },
    map: { properties: ["action", "limit", "root"], required: ["action", "root"] },
  };

  assert.deepEqual([...branches.keys()].sort(), Object.keys(expected).sort());
  for (const [action, contract] of Object.entries(expected)) {
    const branch = branches.get(action);
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(Object.keys(branch.properties).sort(), contract.properties);
    assert.deepEqual([...branch.required].sort(), [...contract.required].sort());
  }

  for (const action of ["query", "context", "impact", "changes", "map"]) {
    const limit = branches.get(action).properties.limit;
    assert.equal(limit.type, "integer");
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, 100);
  }
  const impact = branches.get("impact").properties;
  assert.deepEqual(impact.direction.enum, ["inbound", "outbound", "both"]);
  assert.equal(impact.depth.type, "integer");
  assert.equal(impact.depth.minimum, 1);
  assert.equal(impact.depth.maximum, 5);
  assert.equal(branches.get("build").properties.force.type, "boolean");
}

function assertGraphCommon(data, action, root) {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.action, action);
  assert.equal(data.root, root);
  const serialized = JSON.stringify(data).toLowerCase();
  assert.equal(serialized.includes("gitnexus"), false);
  assert.equal(Object.hasOwn(data, "provider"), false);
}

describe("MCP stdio adapter", () => {
  test("MCP negotiates both supported protocol versions and falls back to the current version", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp versions");
    const home = join(sandbox, "home");
    mkdirSync(home);

    for (const [index, protocolVersion] of [...SUPPORTED_PROTOCOLS, "1900-01-01"].entries()) {
      const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
      const response = await initialize(session, index + 1, protocolVersion);
      assert.equal(
        response.result.protocolVersion,
        SUPPORTED_PROTOCOLS.includes(protocolVersion) ? protocolVersion : CURRENT_PROTOCOL,
      );
      const exit = await session.finish();
      assert.equal(exit.code, 0);
    }
  });

  test("MCP permits ping pre-init and gates tools until initialized notification", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp lifecycle");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });

    assert.deepEqual((await request(session, 1, "ping")).result, {});
    const preInit = await request(session, 2, "tools/list", {});
    assert.equal(typeof preInit.error.code, "number");
    assert.match(preInit.error.message, /initializ/iu);

    await initialize(session, 3);
    const awaitingNotification = await request(session, 4, "tools/list", {});
    assert.equal(typeof awaitingNotification.error.code, "number");
    assert.match(awaitingNotification.error.message, /initializ/iu);

    session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const ready = await request(session, 5, "tools/list", {});
    assert.equal(ready.error, undefined);
    assert.ok(Array.isArray(ready.result.tools));
    assert.equal((await session.finish()).code, 0);
  });

  test("MCP reports JSON-RPC framing errors, survives split lines and blanks, and ignores invalid notifications", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp framing");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });

    session.sendRaw("{not json}\n");
    const parseError = await session.nextMessage();
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    session.send({ jsonrpc: "2.0", id: 2 });
    const invalidRequest = await session.nextMessage();
    assert.equal(invalidRequest.id, 2);
    assert.equal(invalidRequest.error.code, -32600);

    session.sendRaw("\n");
    const blankLineError = await session.nextMessage();
    assert.equal(blankLineError.id, null);
    assert.equal(blankLineError.error.code, -32700);

    session.send({ jsonrpc: "2.0", method: 42 });
    const splitPing = `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`;
    await session.splitWrite(splitPing, 17);
    const ping = await session.nextMessage();
    assert.equal(ping.id, 3);
    assert.deepEqual(ping.result, {});

    await makeReady(session, 4);
    const unknown = await request(session, 5, "openwiki/unknown", {});
    assert.equal(unknown.error.code, -32601);
    const invalidParams = await request(session, 6, "tools/list", { cursor: 42 });
    assert.equal(invalidParams.error.code, -32602);

    const exit = await session.finish();
    assert.equal(exit.code, 0);
    for (const line of session.stdoutLines) {
      assert.notEqual(line, "");
      assert.equal(JSON.parse(line).jsonrpc, "2.0", line);
    }
  });

  test("MCP tools/list exposes exactly fifteen closed schemas and native graph action branches", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp inventory");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    const response = await request(session, 2, "tools/list", {});
    assert.equal(response.error, undefined);
    assert.equal(Object.hasOwn(response.result, "nextCursor"), false);
    const tools = response.result.tools;
    assert.deepEqual(tools.map(({ name }) => name), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string");
      assert.notEqual(tool.description, "");
      assertClosedStructuralObjects(tool.inputSchema, tool.name);
      for (const annotation of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        assert.equal(typeof tool.annotations[annotation], "boolean", `${tool.name}.${annotation}`);
      }
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
      if (STABLE_ANNOTATIONS[tool.name] !== undefined) {
        assertAnnotations(tool, STABLE_ANNOTATIONS[tool.name]);
      }
    }
    assertGraphSchema(tools.find(({ name }) => name === "graph"));
    assert.equal((await session.finish()).code, 0);
  });

  test("MCP tools/call returns shared envelopes for real success and typed failure", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp calls");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository with spaces");
    mkdirSync(home);
    initializeGitRepository(repository);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    const initialized = await request(session, 2, "tools/call", {
      name: "init",
      arguments: { mode: "code", root: repository },
    });
    assert.equal(parseToolEnvelope(initialized, false).ok, true);

    const missing = await request(session, 3, "tools/call", {
      name: "read",
      arguments: { mode: "code", root: repository, page: "missing.md" },
    });
    const failure = parseToolEnvelope(missing, true);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "NOT_FOUND");
    assert.equal((await session.finish()).code, 0);
  });

  test("MCP enrich tool grounds a page node and is idempotent on an unchanged hash", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp enrich");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const root = join(sandbox, "repo");
    initializeGitRepository(root, {
      "src/worker.ts": "export function run() { return 1; }\n",
      "openwiki/architecture.md": "# Architecture\n\nThe worker performs background runs.\n",
    });
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    await request(session, 1, "tools/call", { name: "graph", arguments: { mode: "code", root, action: "build", force: true } });
    const queryResponse = await request(session, 2, "tools/call", { name: "graph", arguments: { mode: "code", root, action: "query", query: "run", limit: 5 } });
    const queryData = parseToolEnvelope(queryResponse, false);
    const symbolNode = queryData.data.nodes.find((node) => node.name === "run");
    assert.ok(symbolNode);

    const pageHash = createHash("sha256").update("# Architecture\n\nThe worker performs background runs.\n").digest("hex");
    const envelopeArguments = {
      root,
      envelope: {
        schema: "memex.enrich.v1",
        sourcePath: "openwiki/architecture.md",
        sourceContentHash: pageHash,
        nodes: [{ kind: "page", name: "openwiki/architecture.md", path: "openwiki/architecture.md" }],
        edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: symbolNode.id, confidence: "inferred" }],
      },
    };
    const firstEnrich = parseToolEnvelope(await request(session, 3, "tools/call", { name: "enrich", arguments: envelopeArguments }), false);
    assert.equal(firstEnrich.data.applied, true);

    const secondEnrich = parseToolEnvelope(await request(session, 4, "tools/call", { name: "enrich", arguments: envelopeArguments }), false);
    assert.equal(secondEnrich.data.applied, false);

    assert.equal((await session.finish()).code, 0);
  });

  test("MCP graph passes native inputs to bounded DTOs and rejects foreign or incompatible fields", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp graph");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    mkdirSync(home);
    initializeGitRepository(repository, {
      "src/math.ts": "export function add(left: number, right: number) { return left + right; }\n",
    });
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    const builtResponse = await request(session, 2, "tools/call", {
      name: "graph",
      arguments: { root: repository, action: "build", force: true },
    });
    const built = parseToolEnvelope(builtResponse, false).data;
    assertGraphCommon(built, "build", repository);
    assert.equal(built.fullRebuild, true);
    assert.ok(Number.isInteger(built.nodeCount));
    assert.ok(Number.isInteger(built.edgeCount));

    const impactResponse = await request(session, 3, "tools/call", {
      name: "graph",
      arguments: {
        root: repository,
        action: "impact",
        target: "add",
        direction: "outbound",
        depth: 2,
        limit: 5,
      },
    });
    const impact = parseToolEnvelope(impactResponse, false).data;
    assertGraphCommon(impact, "impact", repository);
    assert.equal(impact.target, "add");
    assert.equal(impact.direction, "outbound");
    assert.equal(impact.depth, 2);
    assert.equal(impact.limit, 5);
    assert.ok(Array.isArray(impact.nodes));
    assert.ok(Array.isArray(impact.edges));
    assert.ok(Array.isArray(impact.diagnostics));

    for (const [id, argumentsValue] of [
      [4, { root: repository, action: "query", limit: 101, query: "add" }],
      [5, { root: repository, action: "status", query: "add" }],
      [6, { root: repository, action: "status", provider: "gitnexus" }],
    ]) {
      const invalid = await request(session, id, "tools/call", {
        name: "graph",
        arguments: argumentsValue,
      });
      const failure = parseToolEnvelope(invalid, true);
      assert.equal(failure.ok, false);
      assert.equal(failure.error.code, "INVALID_ARGUMENT");
    }
    assert.equal((await session.finish()).code, 0);
  });

  test("MCP exits cleanly on stdin EOF without proprietary shutdown messages", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp eof");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    const exit = await session.finish();
    assert.equal(exit.code, 0);
    assert.deepEqual(session.stdoutLines, []);
  });

  test("MCP rejects an oversized unterminated UTF-8 frame before parsing and resumes after its delimiter", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp bounded frame");
    const home = join(sandbox, "home");
    const marker = "hostile-mcp-frame-marker";
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    const repeats = Math.ceil((MAX_MCP_FRAME_BYTES + 1) / Buffer.byteLength(marker, "utf8"));
    session.sendRaw(marker.repeat(repeats));

    const rejected = await session.nextMessage(10_000);
    assert.deepEqual(rejected, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Request exceeds the maximum frame size." },
    });
    assert.equal(JSON.stringify(rejected).includes(marker), false);

    session.sendRaw("\r\n");
    await initialize(session, 1);
    assert.equal((await session.finish()).code, 0);
  });

  test("MCP rejects a split malformed UTF-8 frame and preserves the following valid frame", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp malformed utf8");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    const malformed = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":"', "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('","method":"ping"}\n', "utf8"),
    ]);
    const splitAt = malformed.indexOf(0xc3) + 1;
    session.sendRaw(malformed.subarray(0, splitAt));
    await waitForImmediate();
    session.sendRaw(Buffer.concat([
      malformed.subarray(splitAt),
      Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n', "utf8"),
    ]));

    assert.deepEqual(await session.nextMessage(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error." },
    });
    assert.deepEqual(await session.nextMessage(), { jsonrpc: "2.0", id: 2, result: {} });
    assert.equal((await session.finish()).code, 0);
  });

  test("MCP rejects malformed UTF-8 at EOF without processing the corrupt frame", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp malformed utf8 eof");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    session.sendRaw(Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":"', "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('","method":"ping"}', "utf8"),
    ]));

    const finished = session.finish();
    assert.deepEqual(await session.nextMessage(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error." },
    });
    assert.deepEqual(await finished, { code: 0, signal: null });
  });

  test("MCP permits a near-limit source envelope inside a JSON-RPC tools/call frame", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp envelope wrapper");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    mkdirSync(home);
    initializeGitRepository(repository);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);
    const envelope = { x: "x".repeat(MAX_ENVELOPE_BYTES - 1024) };
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ingest", arguments: { mode: "code", root: repository, envelope } },
    });
    assert.ok(Buffer.byteLength(frame, "utf8") <= MAX_MCP_FRAME_BYTES);

    session.sendRaw(`${frame}\n`);
    const response = await session.nextMessage();
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.equal((await session.finish()).code, 0);
  });
});
