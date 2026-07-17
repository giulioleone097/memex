import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../../dist/graph.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "..", "dist", "cli.js");

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function setup(label) {
  const home = await mkdtemp(path.join(os.tmpdir(), `memex-cy-home-${label}-`));
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-cy-repo-${label}-`));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "memex@example.test"]);
  await git(root, ["config", "user.name", "Memex Test"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export function foo() { return bar(); }\nfunction bar() { return 1; }\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "initial"]);
  await buildGraph({ root, homeDir: home });
  return { home, root };
}

async function runCypher(root, home, backend, query) {
  const env = { ...process.env, HOME: home, MEMEX_GRAPH_BACKEND: backend };
  try {
    const { stdout } = await execFileAsync("node", [cli, "graph", "--action", "cypher", "--query", query, "--root", root, "--json"], { env });
    return { code: 0, parsed: JSON.parse(stdout) };
  } catch (error) {
    const out = String(error.stdout ?? "");
    return { code: error.code ?? 1, parsed: out ? JSON.parse(out) : undefined, stderr: String(error.stderr ?? "") };
  }
}

test("graph cypher returns rows over a real indexed repo on the wasm tier", async () => {
  const { home, root } = await setup("wasm");
  const { parsed } = await runCypher(root, home, "wasm", "MATCH (n:Node) RETURN count(n) AS c");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.action, "cypher");
  assert.equal(parsed.data.tier, "wasm");
  assert.ok(Number(parsed.data.rows[0].c) > 0, "graph has nodes");
});

test("graph cypher answers a structural query (symbols in the repo)", async () => {
  const { home, root } = await setup("sym");
  const { parsed } = await runCypher(root, home, "wasm", "MATCH (n:Node) WHERE n.kind = 'symbol' RETURN n.name AS name");
  assert.equal(parsed.ok, true);
  const names = parsed.data.rows.map((r) => String(r.name));
  assert.ok(names.includes("foo") && names.includes("bar"), `expected foo and bar, got ${names.join(",")}`);
});

test("graph cypher auto tier resolves a Cypher backend and returns rows", async () => {
  const { home, root } = await setup("auto");
  const { parsed } = await runCypher(root, home, "auto", "MATCH (n:Node) RETURN count(n) AS c");
  assert.equal(parsed.ok, true);
  assert.ok(["native", "wasm"].includes(parsed.data.tier), `auto picked a Cypher tier, got ${parsed.data.tier}`);
});

test("pure tier degrades honestly: cypher is rejected with an actionable error", async () => {
  const { home, root } = await setup("pure");
  const { code, parsed } = await runCypher(root, home, "pure", "MATCH (n:Node) RETURN n");
  assert.equal(code, 2, "non-zero exit on unavailable Cypher");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "GRAPH_CYPHER_UNAVAILABLE");
  assert.match(parsed.error.message, /Cypher requires the LadybugDB backend|doctor/i);
});

test("read-only guard rejects mutation Cypher via the CLI", async () => {
  const { home, root } = await setup("guard");
  const { code, parsed } = await runCypher(root, home, "wasm", "MATCH (n:Node) DETACH DELETE n");
  assert.equal(code, 2);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "GRAPH_CYPHER_READONLY");
});
