import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  MCP_PATH,
  PLUGIN_ROOT,
  assertAdapterExists,
  createMcpSession,
  makeIsolatedEnvironment,
  makeTemporaryRoot,
} from "../fixtures/adapter/process-harness.mjs";

const CURRENT_PROTOCOL = "2025-11-25";
const RESOURCE_URI = "ui://memex/dashboard.html";
const MIME_TYPE = "text/html;profile=mcp-app";
const RENDER_TOOL = "render_memex_dashboard";
const DATA_TOOLS = [
  "init",
  "status",
  "context",
  "search",
  "retrieval_health",
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
  "migrate",
];

async function request(session, id, method, params) {
  const message = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  session.send(message);
  const response = await session.nextMessage();
  assert.equal(response.id, id);
  return response;
}

async function makeReady(session) {
  const initialized = await request(session, 1, "initialize", {
    protocolVersion: CURRENT_PROTOCOL,
    capabilities: {},
    clientInfo: { name: "memex-app-test", version: "1.0.0" },
  });
  assert.deepEqual(initialized.result.capabilities.resources, {
    subscribe: false,
    listChanged: false,
  });
  session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

function assertClosedStructuralObjects(schema, location) {
  if (schema === null || typeof schema !== "object") return;
  if (schema.type === "object" && schema.properties !== undefined) {
    assert.equal(schema.additionalProperties, false, location);
  }
  for (const keyword of ["properties", "$defs", "definitions"]) {
    for (const [name, child] of Object.entries(schema[keyword] ?? {})) {
      assertClosedStructuralObjects(child, `${location}.${keyword}.${name}`);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const [index, child] of (schema[keyword] ?? []).entries()) {
      assertClosedStructuralObjects(child, `${location}.${keyword}[${String(index)}]`);
    }
  }
  if (schema.items !== undefined) assertClosedStructuralObjects(schema.items, `${location}.items`);
}

function exampleViewModel() {
  return {
    mode: "code",
    workspace: "Memex fixture",
    health: "degraded",
    state: "stale",
    freshness: { status: "stale", updatedAt: "2026-07-18T12:00:00.000Z" },
    graph: { available: true, files: 12, nodes: 34, edges: 56, unresolvedEdges: 2 },
    evidence: [{ label: "Architecture", reference: "memex/architecture.md:7" }],
    diagnostics: [{ severity: "warning", code: "GRAPH_STALE", message: "Graph refresh is required." }],
  };
}

describe("Memex MCP App", () => {
  test("resources/list and resources/read expose one exact bundled MCP App resource", async (t) => {
    assertAdapterExists(MCP_PATH, "MCP");
    const sandbox = makeTemporaryRoot(t, "app resource");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    const listed = await request(session, 2, "resources/list", {});
    assert.equal(listed.error, undefined);
    assert.equal(Object.hasOwn(listed.result, "nextCursor"), false);
    assert.equal(listed.result.resources.length, 1);
    const resource = listed.result.resources[0];
    assert.deepEqual(
      {
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      {
        uri: RESOURCE_URI,
        name: "Memex dashboard",
        description: "Bundled read-only dashboard for prepared Memex status and evidence.",
        mimeType: MIME_TYPE,
      },
    );
    assert.deepEqual(resource._meta.ui.csp, {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    assert.equal(resource._meta.ui.prefersBorder, true);
    assert.deepEqual(resource._meta["openai/widgetCSP"], {
      connect_domains: [],
      resource_domains: [],
    });

    const read = await request(session, 3, "resources/read", { uri: RESOURCE_URI });
    assert.equal(read.error, undefined);
    assert.equal(read.result.contents.length, 1);
    const content = read.result.contents[0];
    assert.equal(content.uri, RESOURCE_URI);
    assert.equal(content.name, resource.name);
    assert.equal(content.description, resource.description);
    assert.equal(content.mimeType, MIME_TYPE);
    assert.equal(content.text, readFileSync(join(PLUGIN_ROOT, "dist/ui/memex-dashboard.html"), "utf8"));

    session.sendRaw('{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"ui://memex/dashboard.html","_meta":{"progressToken":"resource-read","example.com/trace":{"id":1}}}}\n');
    const readWithMeta = await session.nextMessage();
    assert.equal(readWithMeta.id, 4);
    assert.equal(readWithMeta.error, undefined);
    assert.equal(readWithMeta.result.contents[0].uri, RESOURCE_URI);

    session.sendRaw('{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"ui://memex/dashboard.html","extra":true}}\n');
    const foreignTopLevel = await session.nextMessage();
    assert.equal(foreignTopLevel.id, 5);
    assert.equal(foreignTopLevel.error.code, -32602);

    session.sendRaw('{"jsonrpc":"2.0","id":6,"method":"resources/read","params":{"uri":"ui://memex/dashboard.html","_meta":{"progressToken":false}}}\n');
    const malformedMeta = await session.nextMessage();
    assert.equal(malformedMeta.id, 6);
    assert.equal(malformedMeta.error.code, -32602);

    const unknown = await request(session, 7, "resources/read", { uri: "ui://memex/missing.html" });
    assert.equal(unknown.error.code, -32002);
    assert.equal(unknown.error.message, "Resource not found.");
    assert.equal((await session.finish()).code, 0);
  });

  test("only the render tool links the UI and returns outputSchema-shaped structured content", async (t) => {
    assertAdapterExists(MCP_PATH, "MCP");
    const sandbox = makeTemporaryRoot(t, "app render");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    const listed = await request(session, 2, "tools/list", {});
    const tools = listed.result.tools;
    assert.equal(tools.length, 18);
    assert.deepEqual(
      tools.filter(({ name }) => name !== RENDER_TOOL).map(({ name }) => name),
      DATA_TOOLS,
    );
    const render = tools.find(({ name }) => name === RENDER_TOOL);
    assert.ok(render);
    assert.deepEqual(render.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(render._meta.ui.resourceUri, RESOURCE_URI);
    assert.deepEqual(render._meta.ui.visibility, ["model"]);
    assert.equal(render._meta["openai/outputTemplate"], RESOURCE_URI);
    assert.equal(typeof render._meta["openai/toolInvocation/invoking"], "string");
    assert.equal(typeof render._meta["openai/toolInvocation/invoked"], "string");
    assertClosedStructuralObjects(render.inputSchema, "render.inputSchema");
    assertClosedStructuralObjects(render.outputSchema, "render.outputSchema");
    assert.deepEqual(render.outputSchema.properties.viewModel, render.inputSchema);
    for (const dataTool of tools.filter(({ name }) => name !== RENDER_TOOL)) {
      assert.equal(Object.hasOwn(dataTool, "_meta"), false, dataTool.name);
      assert.equal(Object.hasOwn(dataTool, "outputSchema"), false, dataTool.name);
    }

    const viewModel = exampleViewModel();
    const called = await request(session, 3, "tools/call", {
      name: RENDER_TOOL,
      arguments: {
        ...viewModel,
        retrievalHealth: { schema: "memex.retrieval-health.v1", ready: false },
      },
    });
    assert.equal(called.error, undefined);
    assert.equal(called.result.isError, false);
    assert.deepEqual(called.result.structuredContent, { viewModel: { ...viewModel, retrievalHealth: { schema: "memex.retrieval-health.v1", ready: false } } });
    assert.deepEqual(called.result._meta, {
      ui: { resourceUri: RESOURCE_URI },
      "openai/outputTemplate": RESOURCE_URI,
    });
    assert.equal(called.result.content.length, 1);
    assert.equal(called.result.content[0].type, "text");
    assert.match(called.result.content[0].text, /Memex dashboard/u);

    const health = await request(session, 6, "tools/call", {
      name: "retrieval_health",
      arguments: { mode: "personal" },
    });
    assert.equal(health.error, undefined);
    assert.equal(health.result.isError, false);
    const healthEnvelope = JSON.parse(health.result.content[0].text);
    assert.equal(healthEnvelope.ok, true);
    assert.equal(healthEnvelope.data.schema, "memex.retrieval-health.v1");
    assert.equal(healthEnvelope.data.ready, false);
    assert.equal(healthEnvelope.data.identity.repositoryIdentity, "memex:personal");
    assert.equal(healthEnvelope.data.identity.hostLocalStorageKey, "personal");

    const invalid = await request(session, 4, "tools/call", {
      name: RENDER_TOOL,
      arguments: { ...viewModel, root: "/private/workspace" },
    });
    assert.equal(invalid.error.code, -32602);
    assert.equal(invalid.error.message, "Invalid Memex dashboard view model.");
    const invalidTimestamp = await request(session, 5, "tools/call", {
      name: RENDER_TOOL,
      arguments: {
        ...viewModel,
        freshness: { status: "current", updatedAt: "2026-02-30T12:00:00.000Z" },
      },
    });
    assert.equal(invalidTimestamp.error.code, -32602);
    assert.equal((await session.finish()).code, 0);
  });

  test("bundled UI has safe static rendering, lifecycle, accessibility, state, and responsive markers", () => {
    const source = readFileSync(join(PLUGIN_ROOT, "src/ui/memex-dashboard.html"), "utf8");
    const dist = readFileSync(join(PLUGIN_ROOT, "dist/ui/memex-dashboard.html"), "utf8");
    const packageVersion = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version;
    assert.equal(dist, source);
    for (const state of ["loading", "empty", "error", "success"]) {
      assert.match(source, new RegExp(`data-state="${state}"`, "u"));
    }
    for (const bridgeMethod of [
      "ui/initialize",
      "ui/notifications/initialized",
      "ui/notifications/tool-result",
      "ui/notifications/host-context-changed",
      "ui/resource-teardown",
    ]) {
      assert.match(source, new RegExp(bridgeMethod, "u"));
    }
    assert.match(source, /window\.openai/u);
    assert.match(source, /protocolVersion: "2026-01-26"/u);
    assert.match(source, /appCapabilities: \{\}/u);
    assert.match(source, new RegExp(`appInfo: \\{ name: "memex-dashboard", version: "${packageVersion.replaceAll(".", "\\.")}" \\}`, "u"));
    assert.doesNotMatch(source, /\b(?:clientInfo|resourceUri)\s*:/u);
    assert.match(source, /\.textContent/u);
    assert.match(source, /prefers-reduced-motion/u);
    assert.match(source, /@media \(max-width: 390px\)/u);
    assert.match(source, /<meta name="viewport"/u);
    assert.match(source, /class="skip-link"/u);
    assert.match(source, /aria-live="polite"/u);
    assert.match(source, /role="alert"/u);
    assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval)\b|\bnew\s+Function\b/u);
    assert.doesNotMatch(source, /<script\s+[^>]*src=/iu);
    assert.doesNotMatch(source, /https?:\/\//iu);
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket)\b/u);
  });
});
