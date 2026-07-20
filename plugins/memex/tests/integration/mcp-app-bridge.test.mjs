import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import { describe, test } from "node:test";

import { PLUGIN_ROOT } from "../fixtures/adapter/process-harness.mjs";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: {
    protocolVersion: "2026-01-26",
    appCapabilities: {},
    appInfo: { name: "memex-dashboard", version: "0.3.3" },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeElement() {
  const children = [];
  return {
    children,
    className: "",
    dataset: {},
    hidden: false,
    textContent: "",
    get firstChild() {
      return children[0] ?? null;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
  };
}

function createBridgeHarness() {
  const elements = new Map();
  const messages = [];
  const timers = new Map();
  let listener;
  let nextTimerId = 1;

  const host = {
    postMessage(message) {
      messages.push(clone(message));
    },
  };
  const window = {
    parent: host,
    addEventListener(type, handler) {
      if (type === "message") listener = handler;
    },
    removeEventListener(type, handler) {
      if (type === "message" && listener === handler) listener = undefined;
    },
    setTimeout(handler) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, handler);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const document = {
    documentElement: makeElement(),
    createElement() {
      return makeElement();
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
  };
  const html = readFileSync(join(PLUGIN_ROOT, "src/ui/memex-dashboard.html"), "utf8");
  const scriptSource = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(scriptSource, "dashboard must contain one executable inline client bridge");
  const context = createContext({ document, window });
  new Script(scriptSource, { filename: "memex-dashboard.html" }).runInContext(context);

  return {
    document,
    elements,
    messages,
    timers,
    dispatch(data) {
      if (listener === undefined) return false;
      listener({ data: clone(data), source: host });
      return true;
    },
  };
}

function exampleViewModel(workspace = "Bridge fixture", retrievalHealth = false) {
  return {
    mode: "code",
    workspace,
    health: "degraded",
    state: "stale",
    freshness: { status: "stale", updatedAt: "2026-07-18T12:00:00.000Z" },
    graph: { available: true, files: 12, nodes: 34, edges: 56, unresolvedEdges: 2 },
    evidence: [{ label: "Architecture", reference: "memex/architecture.md:7" }],
    diagnostics: [{ severity: "warning", code: "GRAPH_STALE", message: "Graph refresh is required." }],
    ...(retrievalHealth ? { retrievalHealth: { schema: "memex.retrieval-health.v1", ready: false } } : {}),
  };
}

describe("bundled MCP Apps bridge lifecycle", () => {
  test("initializes with the stable request, renders a tool result, and acknowledges teardown", () => {
    const bridge = createBridgeHarness();
    assert.deepEqual(bridge.messages, [INITIALIZE_REQUEST]);
    assert.deepEqual(Object.keys(bridge.messages[0].params).sort(), ["appCapabilities", "appInfo", "protocolVersion"]);

    bridge.dispatch({
      jsonrpc: "2.0",
      id: 1,
      result: { hostContext: { theme: "dark" } },
    });
    assert.deepEqual(bridge.messages[1], {
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
    });
    assert.equal(bridge.document.documentElement.dataset.theme, "dark");

    bridge.dispatch({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { viewModel: exampleViewModel() } },
    });
    assert.equal(bridge.elements.get("workspace-name").textContent, "Bridge fixture");
    assert.equal(bridge.elements.get("app").dataset.state, "success");

    bridge.dispatch({
      jsonrpc: "2.0",
      id: "teardown-1",
      method: "ui/resource-teardown",
      params: { reason: "Host released the resource." },
    });
    assert.deepEqual(bridge.messages.at(-1), {
      jsonrpc: "2.0",
      id: "teardown-1",
      result: {},
    });
    assert.equal(bridge.timers.size, 0);

    const messageCount = bridge.messages.length;
    assert.equal(bridge.dispatch({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { viewModel: exampleViewModel("Late result") } },
    }), false);
    assert.equal(bridge.dispatch({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    }), false);
    assert.equal(bridge.messages.length, messageCount);
    assert.equal(bridge.elements.get("workspace-name").textContent, "Bridge fixture");
    assert.equal(bridge.document.documentElement.dataset.theme, "dark");
  });

  test("surfaces initialization errors without becoming ready", () => {
    const bridge = createBridgeHarness();
    bridge.dispatch({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Initialization denied." },
    });

    assert.deepEqual(bridge.messages, [INITIALIZE_REQUEST]);
    assert.equal(bridge.elements.get("app").dataset.state, "error");
    assert.equal(bridge.elements.get("error-copy").textContent, "MCP Apps bridge initialization failed.");

    bridge.dispatch({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { viewModel: exampleViewModel("Must not render") } },
    });
    assert.equal(bridge.elements.get("app").dataset.state, "error");
    assert.notEqual(bridge.document.getElementById("workspace-name").textContent, "Must not render");
    assert.equal(bridge.messages.length, 1);
  });

  test("renders an additive retrieval-health payload without changing legacy bridge lifecycle", () => {
    const bridge = createBridgeHarness();
    bridge.dispatch({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "light" } } });
    bridge.dispatch({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { viewModel: exampleViewModel("Health fixture", true) } },
    });
    assert.equal(bridge.elements.get("workspace-name").textContent, "Health fixture");
    assert.equal(bridge.elements.get("app").dataset.state, "success");
  });
});
