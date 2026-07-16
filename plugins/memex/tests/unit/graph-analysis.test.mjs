import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { scanSourceFile } from "../../dist/graph-scan.js";
import { MemexError } from "../../dist/errors.js";
import {
  analyzeGraphChanges,
  buildGraph,
  getArchitectureMap,
  getGraphStatus,
} from "../../dist/graph.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-graph-analysis-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await temporaryRoot("repository");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "memex@example.test"]);
  await git(root, ["config", "user.name", "Memex Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "import { b } from './b'; export const a = () => b();\n");
  await writeFile(path.join(root, "src", "b.ts"), "import { c } from './c'; export const b = () => c();\n");
  await writeFile(path.join(root, "src", "c.ts"), "import { a } from './a'; export const c = () => a();\n");
  await writeFile(path.join(root, "src", "main.ts"), "import { a } from './a'; export const main = () => a();\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "initial graph"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph semantic analysis", () => {
  test("graph: scanner keeps relation sites scoped to their enclosing declaration", () => {
    const scan = scanSourceFile({
      path: "src/services.ts",
      language: "typescript",
      content: "class First { run() { helperOne(); } }\nclass Second { run() { helperTwo(); } }\n",
    });
    assert.deepEqual(scan.symbols.map((symbol) => symbol.qualifiedName), ["First", "First.run", "Second", "Second.run"]);
    assert.deepEqual(scan.relations.filter((relation) => relation.kind === "calls").map((relation) => [relation.fromQualifiedName, relation.target]), [["First.run", "helperOne"], ["Second.run", "helperTwo"]]);
  });

  test("graph: scanner assigns calls on later lines to lexical and nested scopes", () => {
    const scan = scanSourceFile({
      path: "src/scopes.ts",
      language: "typescript",
      content: "class Outer {\n  run() {\n    helperOne();\n    function nested() {\n      helperNested();\n    }\n  }\n}\nclass Other {\n  run() {\n    helperOther();\n  }\n}\n",
    });
    assert.deepEqual(scan.relations.filter((relation) => relation.kind === "calls").map((relation) => [relation.fromQualifiedName, relation.target]), [["Outer.run", "helperOne"], ["Outer.run.nested", "helperNested"], ["Other.run", "helperOther"]]);
  });

  test("graph: language tiers only emit lexical evidence they can prove", () => {
    const fixtures = [
      ["src/app.ts", "typescript", "export function run() { helper(); }"],
      ["src/app.js", "javascript", "function run() { helper(); }"],
      ["src/app.py", "python", "def run():\n  helper()"],
      ["src/app.go", "go", "func run() { helper() }"],
      ["src/app.rs", "rust", "fn run() { helper(); }"],
      ["src/App.java", "java", "class App { void run() { helper(); } }"],
      ["src/App.kt", "kotlin", "class App { fun run() { helper() } }"],
      ["src/App.cs", "csharp", "class App { void Run() { Helper(); } }"],
      ["src/app.c", "c", "void run() { helper(); }"],
      ["src/app.cpp", "cpp", "void run() { helper(); }"],
      ["src/app.rb", "ruby", "def run\n helper()\nend"],
      ["src/app.php", "php", "function run() { helper(); }"],
      ["scripts/app.sh", "shell", "run() { helper; }"],
    ];
    for (const [filePath, language, content] of fixtures) {
      const scan = scanSourceFile({ path: filePath, language, content });
      assert.equal(JSON.stringify(scan).includes(content), false);
      assert.equal(scan.symbols.length > 0, true, filePath);
    }
    for (const [filePath, language, content] of [["README.md", "markdown", "# Setup"], ["config.json", "json", "{\"name\": \"example\"}"], ["config.yaml", "yaml", "name: example"], ["config.toml", "toml", "name = \"example\""], ["notes.data", "text", "not source"]]) {
      const scan = scanSourceFile({ path: filePath, language, content });
      assert.deepEqual(scan.relations, []);
      assert.equal(scan.diagnostics.some((diagnostic) => diagnostic.code === "LEXICAL_FILE_ONLY"), true);
    }
  });

  test("graph: build and status keep private graph and storage details out of public DTOs", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    const build = await buildGraph({ root, homeDir });
    const status = await getGraphStatus({ root, homeDir });
    assert.equal("graph" in build, false);
    assert.equal("manifestPath" in build, false);
    assert.equal("reusedShardCount" in build, false);
    assert.equal("reusedFileCount" in build, false);
    assert.equal("graph" in status, false);
    assert.equal(JSON.stringify({ build, status }).includes(homeDir), false);
  });

  test("graph: maps dependency cycles and computes transitive inbound dependents deterministically", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await buildGraph({ root, homeDir });
    await writeFile(path.join(root, "src", "c.ts"), "import { a } from './a'; export const c = () => a(); export const changed = true;\n");
    const first = await analyzeGraphChanges({ root, homeDir, limit: 100 });
    const second = await analyzeGraphChanges({ root, homeDir, limit: 100 });
    assert.deepEqual(first.nodes, second.nodes);
    assert.equal(first.nodes.some((node) => node.path === "src/a.ts"), true);
    assert.equal(first.nodes.some((node) => node.path === "src/b.ts"), true);
    const map = await getArchitectureMap({ root, homeDir, limit: 100 });
    assert.deepEqual(map.cycles, [["src/a.ts", "src/b.ts", "src/c.ts"]]);
    assert.deepEqual(map.flows, [
      { from: "src/a.ts", to: "src/b.ts", weight: 1 },
      { from: "src/b.ts", to: "src/c.ts", weight: 1 },
      { from: "src/c.ts", to: "src/a.ts", weight: 1 },
      { from: "src/main.ts", to: "src/a.ts", weight: 1 },
    ]);
    assert.deepEqual(map.entrypoints.map((node) => node.path), ["src/main.ts"]);
    const bounded = await getArchitectureMap({ root, homeDir, limit: 100, responseByteLimit: 512 });
    assert.equal(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 512, true);
    await assert.rejects(getArchitectureMap({ root, homeDir, limit: 100, responseByteLimit: 256 }), (error) => error instanceof MemexError && error.code === "SOURCE_TOO_LARGE");
  });

  test("graph: scanner shard contract contains all semantic fields storage must round-trip", () => {
    const scan = scanSourceFile({ path: "src/contract.ts", language: "typescript", content: "class Service {\n  run() {\n    helper();\n  }\n}\n" });
    assert.deepEqual(Object.keys(scan).sort(), ["calls", "diagnostics", "exports", "implements", "imports", "inherits", "references", "relations", "symbols"]);
    assert.deepEqual(Object.keys(scan.symbols[0]).sort(), ["endLine", "exported", "kind", "name", "qualifiedName", "scope", "startLine"]);
    assert.deepEqual(Object.keys(scan.relations[0]).sort(), ["confidence", "fromQualifiedName", "kind", "line", "target"]);
  });
});
