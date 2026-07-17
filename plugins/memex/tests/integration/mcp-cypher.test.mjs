import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import {
  MCP_PATH,
  assertAdapterExists,
  createMcpSession,
  initializeGitRepository,
  makeIsolatedEnvironment,
  makeTemporaryRoot,
} from "../fixtures/adapter/process-harness.mjs";

const CURRENT_PROTOCOL = "2025-11-25";

before(() => assertAdapterExists(MCP_PATH, "MCP"));

async function makeReady(session, id = 1) {
  session.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: CURRENT_PROTOCOL, capabilities: {}, clientInfo: { name: "memex-cypher-test", version: "1.0.0" } },
  });
  const response = await session.nextMessage();
  assert.equal(response.error, undefined);
  session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

// Generous timeout: graph build scans the repo and the first Cypher call cold-
// starts the wasm worker (load + SHA-verify the 13 MB module, sync the graph),
// which legitimately exceeds the harness's 3 s default under full-suite load.
const CALL_TIMEOUT_MS = 30_000;

async function call(session, id, name, args) {
  session.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const response = await session.nextMessage(CALL_TIMEOUT_MS);
  assert.equal(response.id, id);
  assert.equal(response.error, undefined);
  assert.ok(Array.isArray(response.result.content));
  return { isError: response.result.isError, envelope: JSON.parse(response.result.content[0].text) };
}

test("MCP graph cypher returns rows and the server exits cleanly", async (t) => {
  const sandbox = makeTemporaryRoot(t, "mcp cypher");
  const home = join(sandbox, "home");
  mkdirSync(home);
  const root = join(sandbox, "repo");
  initializeGitRepository(root, {
    "src/a.ts": "export function foo() { return bar(); }\nfunction bar() { return 1; }\n",
  });
  const session = createMcpSession(t, { env: makeIsolatedEnvironment(home, { MEMEX_GRAPH_BACKEND: "wasm" }) });
  await makeReady(session);

  const built = await call(session, 2, "graph", { mode: "code", root, action: "build", force: true });
  assert.equal(built.envelope.ok, true);

  const cypher = await call(session, 3, "graph", { mode: "code", root, action: "cypher", query: "MATCH (n:Node) RETURN count(n) AS c" });
  assert.equal(cypher.isError, false);
  assert.equal(cypher.envelope.ok, true);
  assert.equal(cypher.envelope.data.tier, "wasm");
  assert.ok(Number(cypher.envelope.data.rows[0].c) > 0);

  // Clean exit proves the wasm worker is torn down on stdin close.
  assert.equal((await session.finish()).code, 0);
});

test("MCP graph cypher on the pure tier returns a typed unavailable error", async (t) => {
  const sandbox = makeTemporaryRoot(t, "mcp cypher pure");
  const home = join(sandbox, "home");
  mkdirSync(home);
  const root = join(sandbox, "repo");
  initializeGitRepository(root, { "src/a.ts": "export const x = 1;\n" });
  const session = createMcpSession(t, { env: makeIsolatedEnvironment(home, { MEMEX_GRAPH_BACKEND: "pure" }) });
  await makeReady(session);

  await call(session, 2, "graph", { mode: "code", root, action: "build", force: true });
  const cypher = await call(session, 3, "graph", { mode: "code", root, action: "cypher", query: "MATCH (n) RETURN n" });
  assert.equal(cypher.isError, true);
  assert.equal(cypher.envelope.ok, false);
  assert.equal(cypher.envelope.error.code, "GRAPH_CYPHER_UNAVAILABLE");
  assert.equal((await session.finish()).code, 0);
});
