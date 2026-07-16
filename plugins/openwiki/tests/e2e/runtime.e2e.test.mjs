import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "../..");
const FIXTURES_ROOT = join(PLUGIN_ROOT, "tests/fixtures");
const SAMPLE_REPOSITORY = join(FIXTURES_ROOT, "sample-repo");
const SOURCE_FIXTURES = join(FIXTURES_ROOT, "sources");
const MCP_FIXTURES = join(FIXTURES_ROOT, "mcp");
const CLI_PATH = join(PLUGIN_ROOT, "dist/cli.js");
const MCP_PATH = join(PLUGIN_ROOT, "dist/mcp.js");

const REQUIRED_WIKI_PAGES = [
  "quickstart.md",
  "architecture.md",
  "source-map.md",
  "workflows.md",
  "domain-concepts.md",
  "operations.md",
  "integrations.md",
  "testing.md",
];
const SOURCE_KINDS = [
  "git-repo",
  "gmail",
  "hackernews",
  "notion",
  "slack",
  "web-search",
  "x",
];
const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;
const GRAPH_OUTPUT_LIMIT_BYTES = 64 * 1024;

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const capture = (target, chunk) => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > (options.captureLimitBytes ?? PROCESS_CAPTURE_LIMIT_BYTES)) {
        child.kill("SIGKILL");
        finish(
          rejectProcess,
          new Error(`Process output exceeded ${options.captureLimitBytes ?? PROCESS_CAPTURE_LIMIT_BYTES} bytes.`),
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => finish(rejectProcess, error));
    child.once("close", (code, signal) => {
      finish(resolveProcess, {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        rejectProcess,
        new Error(`Process timed out after ${options.timeoutMs ?? PROCESS_TIMEOUT_MS} ms.`),
      );
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);

    child.stdin.end(options.input);
  });
}

async function runCommand(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.signal, null);
  return result;
}

function parseJsonDocument(stdout, context) {
  assert.notEqual(stdout.trim(), "", `${context} must emit one JSON document.`);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    assert.fail(`${context} emitted invalid JSON: ${error.message}\n${stdout}`);
  }
}

async function runCli(harness, args, options = {}) {
  assert.ok(
    existsSync(CLI_PATH),
    `Missing compiled CLI adapter: ${CLI_PATH}. Integrate Task 4 and rebuild before making this E2E green.`,
  );
  const processResult = await runProcess(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? harness.repositoryRoot,
    env: harness.env,
    input: options.input,
  });
  const json = parseJsonDocument(processResult.stdout, `openwiki ${args[0] ?? ""}`);
  return { ...processResult, json };
}

async function runCliSuccess(harness, args, options = {}) {
  const result = await runCli(harness, args, options);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", "Successful CLI commands must keep stderr quiet.");
  assert.equal(result.json.ok, true, result.stdout);
  assert.ok(Object.hasOwn(result.json, "data"), "Success envelope must contain data.");
  return result;
}

async function runCliError(harness, args, expectedCode, options = {}) {
  const result = await runCli(harness, args, options);
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", "Known CLI errors must be returned as JSON, not diagnostics.");
  assert.deepEqual(Object.keys(result.json).sort(), ["error", "ok"]);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, expectedCode);
  assert.equal(typeof result.json.error.message, "string");
  assert.ok(result.json.error.message.length > 0);
  assert.doesNotMatch(result.json.error.message, /\n\s*at\s|node:internal|\.worktrees/u);
  return result;
}

async function git(harness, args, options = {}) {
  return runCommand("git", args, {
    cwd: harness.repositoryRoot,
    env: { ...harness.env, ...options.env },
  });
}

async function createRepositoryHarness(t, options = {}) {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "openwiki real e2e "));
  const repositoryRoot = join(sandboxRoot, "Northstar Catalog Repository");
  const homeRoot = join(sandboxRoot, "Isolated User Home");
  const outsideRoot = join(sandboxRoot, "Outside Wiki Boundary");
  const instructionText = {
    agents: "# Existing agent policy\n\nPreserve this repository-specific instruction.\n",
    claude: "# Existing Claude policy\n\nPreserve this Claude-specific instruction.\n",
  };

  await Promise.all([
    cp(SAMPLE_REPOSITORY, repositoryRoot, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(repositoryRoot, "AGENTS.md"), instructionText.agents),
    writeFile(join(repositoryRoot, "CLAUDE.md"), instructionText.claude),
  ]);

  const env = {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    XDG_CONFIG_HOME: join(homeRoot, ".config"),
    XDG_DATA_HOME: join(homeRoot, ".local/share"),
  };
  const harness = {
    sandboxRoot,
    repositoryRoot,
    homeRoot,
    outsideRoot,
    instructionText,
    env,
  };

  if (options.gitNexusTripwire) {
    const tripwireBin = join(sandboxRoot, "Forbidden Provider Bin");
    const tripwireLog = join(sandboxRoot, "gitnexus-invocations.log");
    await mkdir(tripwireBin, { recursive: true });
    await writeFile(
      join(tripwireBin, "gitnexus"),
      "#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.OPENWIKI_GITNEXUS_TRIPWIRE, `${JSON.stringify(process.argv.slice(2))}\\n`);\nprocess.exit(97);\n",
    );
    await chmod(join(tripwireBin, "gitnexus"), 0o755);
    harness.tripwireLog = tripwireLog;
    harness.env = {
      ...env,
      OPENWIKI_GITNEXUS_TRIPWIRE: tripwireLog,
      PATH: `${tripwireBin}${delimiter}${env.PATH ?? ""}`,
    };
  }

  t.after(() => rm(sandboxRoot, { recursive: true, force: true }));

  await git(harness, ["init", "--initial-branch=main"]);
  await git(harness, ["config", "user.name", "OpenWiki E2E"]);
  await git(harness, ["config", "user.email", "openwiki-e2e@example.test"]);
  await git(harness, ["add", "package.json", "src", "test", "AGENTS.md", "CLAUDE.md"]);
  await git(harness, ["commit", "-m", "fixture: initial Northstar catalog"], {
    env: {
      GIT_AUTHOR_DATE: "2026-07-11T08:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-11T08:00:00Z",
    },
  });
  harness.initialHead = (await git(harness, ["rev-parse", "HEAD"])).stdout.trim();
  return harness;
}

async function initializeWiki(harness) {
  return runCliSuccess(harness, [
    "init",
    "--mode",
    "code",
    "--root",
    harness.repositoryRoot,
  ]);
}

async function listFiles(root) {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    if (entry.isFile()) files.push(absolute);
  }
  return files.sort();
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryText(root) {
  const chunks = [];
  for (const file of await listFiles(root)) {
    chunks.push(await readFile(file, "utf8"));
  }
  return chunks.join("\n");
}

async function wikiDigest(repositoryRoot) {
  const wikiRoot = join(repositoryRoot, "openwiki");
  const hash = createHash("sha256");
  for (const file of await listFiles(wikiRoot)) {
    hash.update(relative(wikiRoot, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function searchResults(data) {
  const results = Array.isArray(data.evidence) ? data.evidence : data;
  assert.ok(Array.isArray(results), "Search must return an evidence array.");
  return results;
}

function assertEvidenceItem(item, expectedPath) {
  assert.equal(item.ref.path, expectedPath);
  assert.ok(Number.isInteger(item.ref.startLine) && item.ref.startLine > 0);
  assert.ok(Number.isInteger(item.ref.endLine) && item.ref.endLine >= item.ref.startLine);
  assert.equal(typeof item.score, "number");
  assert.ok(item.score > 0);
  assert.equal(item.citation, `${expectedPath}#L${String(item.ref.startLine)}-${String(item.ref.endLine)}`);
}

function assertSemanticText(value, patterns) {
  const serialized = JSON.stringify(value);
  for (const pattern of patterns) assert.match(serialized, pattern);
}

function assertNoProviderSurface(value) {
  const visit = (current) => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== "object") {
      if (typeof current === "string") assert.doesNotMatch(current, /gitnexus/iu);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      assert.doesNotMatch(key, /provider|gitnexus/iu);
      visit(child);
    }
  };
  visit(value);
}

function assertGraphResult(result, action, repositoryRoot, limit) {
  const data = result.json.data;
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.action, action);
  assert.equal(data.root, repositoryRoot);
  assertNoProviderSurface(data);
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") <= GRAPH_OUTPUT_LIMIT_BYTES,
    `${action} output exceeded ${GRAPH_OUTPUT_LIMIT_BYTES} bytes.`,
  );

  if (limit !== undefined) {
    const boundedKeys = /result|match|node|edge|path|change|context|impact|reference|caller|callee/u;
    const visit = (current, key = "") => {
      if (Array.isArray(current)) {
        if (boundedKeys.test(key)) {
          assert.ok(current.length <= limit, `${action}.${key} exceeded --limit ${limit}.`);
        }
        for (const item of current) visit(item, key);
        return;
      }
      if (current === null || typeof current !== "object") return;
      for (const [childKey, child] of Object.entries(current)) visit(child, childKey);
    };
    visit(data);
  }
  return data;
}

function assertHasPositiveCount(value) {
  const counts = [];
  const visit = (current) => {
    if (current === null || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (typeof child === "number" && /count|total|files|symbols|nodes|edges/iu.test(key)) {
        counts.push(child);
      }
      visit(child);
    }
  };
  visit(value);
  assert.ok(counts.some((count) => count > 0), "Graph result must expose positive bounded counts.");
}

async function assertGitNexusWasNotInvoked(harness) {
  assert.equal(
    await pathExists(harness.tripwireLog),
    false,
    "The proprietary graph runtime must never invoke or fall back to GitNexus.",
  );
}

async function runMcpJourney(harness) {
  assert.ok(
    existsSync(MCP_PATH),
    `Missing compiled MCP adapter: ${MCP_PATH}. Integrate Task 4 and rebuild before making this E2E green.`,
  );
  const input = `${await readFile(join(MCP_FIXTURES, "handshake.jsonl"), "utf8")}${await readFile(
    join(MCP_FIXTURES, "search.jsonl"),
    "utf8",
  )}`;
  const result = await runProcess(process.execPath, [MCP_PATH], {
    cwd: harness.repositoryRoot,
    env: harness.env,
    input,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const responses = result.stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.deepEqual([...byId.keys()].sort((left, right) => left - right), [1, 2, 3, 4]);
  assert.equal(byId.get(1).result.protocolVersion, "2025-06-18");
  const toolNames = byId.get(2).result.tools.map(({ name }) => name);
  for (const required of ["graph", "read", "search"]) assert.ok(toolNames.includes(required));
  // The search tool's evidence shape (EvidenceItem: ref/score/ranks/citation/
  // confidence — Task 8's binding contract) never echoes raw chunk prose, only
  // structural refs, so a /catalog/iu prose-content check can no longer match
  // here; /architecture\.md/u alone still proves the right page was found
  // (it appears as ref.path/citation in the evidence). The "read" response
  // below is unaffected — it returns the real page content verbatim.
  assertSemanticText(byId.get(3), [/architecture\.md/u]);
  assertSemanticText(byId.get(4), [/architecture\.md/u, /Catalog Architecture/u]);
}

describe("OpenWiki real runtime journey", () => {
  test("builds, updates, queries, schedules, and purges a grounded repository wiki across processes", async (t) => {
    const harness = await createRepositoryHarness(t);
    await runCommand("npm", ["test"], {
      cwd: harness.repositoryRoot,
      env: harness.env,
    });

    const init = await initializeWiki(harness);
    const wikiRoot = join(harness.repositoryRoot, "openwiki");
    assert.equal(init.json.data.location.wikiRoot, wikiRoot);
    assert.equal(init.json.data.location.dataRoot.startsWith(harness.homeRoot), true);
    for (const page of REQUIRED_WIKI_PAGES) assert.equal(await pathExists(join(wikiRoot, page)), true);
    assert.match(await readFile(join(harness.repositoryRoot, "AGENTS.md"), "utf8"), /repository-specific instruction/u);
    assert.match(await readFile(join(harness.repositoryRoot, "CLAUDE.md"), "utf8"), /Claude-specific instruction/u);

    const architecture = `# Catalog Architecture

The catalog boundary lives in \`src/catalog.mjs\` at Git commit \`${harness.initialHead}\`.

\`listActiveProducts\` returns defensive copies, \`findProductBySku\` normalizes SKU input, and \`summarizeCatalog\` derives active inventory totals.
`;
    const architectureInput = join(harness.sandboxRoot, "Grounded Architecture Page.md");
    await writeFile(architectureInput, architecture);
    const architectureWrite = await runCliSuccess(harness, [
      "write",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--page",
      "architecture.md",
      "--content-file",
      architectureInput,
    ]);
    assert.deepEqual(architectureWrite.json.data, { page: "architecture.md", written: true });

    const sourceMap = `# Source Map

- [Catalog architecture](architecture.md) — \`src/catalog.mjs:1-40\` at \`${harness.initialHead}\`.
`;
    await runCliSuccess(
      harness,
      [
        "write",
        "--mode",
        "code",
        "--root",
        harness.repositoryRoot,
        "--page",
        "source-map.md",
        "--stdin",
      ],
      { input: sourceMap },
    );

    const firstFinalize = await runCliSuccess(harness, [
      "finalize",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--command",
      "init",
      "--run-id",
      "e2e-initial-catalog",
      "--started-at",
      "2026-07-11T08:01:00.000Z",
      "--completed-at",
      "2026-07-11T08:02:00.000Z",
      "--summary",
      "Grounded the Northstar catalog architecture.",
      "--last-git-head",
      harness.initialHead,
    ]);
    assert.equal(firstFinalize.json.data.changed, true);
    assert.match(firstFinalize.json.data.state.contentHash, /^[a-f0-9]{64}$/u);
    assert.equal(firstFinalize.json.data.state.lastGitHead, harness.initialHead);

    const firstSearch = await runCliSuccess(harness, [
      "search",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--query",
      "catalog architecture",
      "--limit",
      "5",
      // lexical only: this journey never runs "graph build" (that is a
      // separate test below), so requesting the graph signal here would
      // hard-fail with NOT_INITIALIZED per this task's own design (an
      // explicit --signals request must never silently narrow). lexical
      // alone still proves the CLI's comma-split --signals parsing and
      // keeps this test independent of both graph-build state and real
      // vendored embedder availability.
      "--signals",
      "lexical",
    ]);
    const catalogResult = searchResults(firstSearch.json.data).find(
      ({ ref }) => ref.path === "architecture.md",
    );
    assert.ok(catalogResult);
    assertEvidenceItem(catalogResult, "architecture.md");

    for (const kind of SOURCE_KINDS) {
      const ingest = await runCliSuccess(harness, [
        "ingest",
        "--mode",
        "code",
        "--root",
        harness.repositoryRoot,
        "--envelope-file",
        join(SOURCE_FIXTURES, `${kind}.json`),
      ]);
      assertSemanticText(ingest.json.data, [new RegExp(kind, "u")]);
    }

    const statePath = join(wikiRoot, ".last-update.json");
    const firstState = JSON.parse(await readFile(statePath, "utf8"));
    const dataRoot = join(harness.homeRoot, ".openwiki", "data", firstState.workspaceId);
    const privateData = await directoryText(dataRoot);
    for (const kind of SOURCE_KINDS) assert.match(privateData, new RegExp(`"kind"\\s*:\\s*"${kind}"`, "u"));
    const repositoryWikiText = await directoryText(wikiRoot);
    assert.doesNotMatch(repositoryWikiText, /gmail-catalog-decisions|slack-catalog-incident/u);
    assert.equal(relative(harness.repositoryRoot, dataRoot).startsWith(`..${sep}`), true);

    await appendFile(
      join(harness.repositoryRoot, "src/catalog.mjs"),
      `
export function groupActiveProductsByCategory() {
  return Object.groupBy(listActiveProducts(), ({ category }) => category);
}
`,
    );
    await runCommand("npm", ["test"], { cwd: harness.repositoryRoot, env: harness.env });
    await git(harness, ["add", "src/catalog.mjs"]);
    await git(harness, ["commit", "-m", "feat: expose catalog category grouping"], {
      env: {
        GIT_AUTHOR_DATE: "2026-07-11T09:00:00Z",
        GIT_COMMITTER_DATE: "2026-07-11T09:00:00Z",
      },
    });
    const updatedHead = (await git(harness, ["rev-parse", "HEAD"])).stdout.trim();
    assert.notEqual(updatedHead, harness.initialHead);

    const context = await runCliSuccess(harness, [
      "context",
      "--root",
      harness.repositoryRoot,
      "--previous-head",
      harness.initialHead,
    ]);
    assert.equal(context.json.data.head, updatedHead);
    assert.equal(context.json.data.previousHead, harness.initialHead);
    assert.ok(context.json.data.changedPaths.includes("src/catalog.mjs"));

    const updatedArchitecture = `${architecture.trim()}

\`groupActiveProductsByCategory\` was added at commit \`${updatedHead}\` so callers can consume a derived category map without mutating catalog storage.
`;
    await runCliSuccess(harness, [
      "write",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--page",
      "architecture.md",
      "--content",
      updatedArchitecture,
    ]);
    const updatedFinalize = await runCliSuccess(harness, [
      "finalize",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--command",
      "update",
      "--run-id",
      "e2e-catalog-update",
      "--started-at",
      "2026-07-11T09:01:00.000Z",
      "--completed-at",
      "2026-07-11T09:02:00.000Z",
      "--summary",
      "Documented category grouping from changed Git evidence.",
      "--last-git-head",
      updatedHead,
    ]);
    assert.equal(updatedFinalize.json.data.changed, true);
    assert.notEqual(updatedFinalize.json.data.state.contentHash, firstState.contentHash);
    assert.equal(updatedFinalize.json.data.state.updatedAt, "2026-07-11T09:02:00.000Z");

    const unchangedFinalize = await runCliSuccess(harness, [
      "finalize",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--command",
      "update",
      "--run-id",
      "e2e-catalog-noop",
      "--started-at",
      "2026-07-11T10:01:00.000Z",
      "--completed-at",
      "2026-07-11T10:02:00.000Z",
      "--summary",
      "No source or wiki changes.",
      "--last-git-head",
      updatedHead,
    ]);
    assert.equal(unchangedFinalize.json.data.changed, false);
    assert.equal(
      unchangedFinalize.json.data.state.contentHash,
      updatedFinalize.json.data.state.contentHash,
    );
    assert.equal(
      unchangedFinalize.json.data.state.updatedAt,
      updatedFinalize.json.data.state.updatedAt,
    );

    const check = await runCliSuccess(harness, [
      "check",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
    ]);
    assert.equal(check.json.data.ok, true);
    assert.deepEqual(check.json.data.issues, []);

    const doctor = await runCliSuccess(harness, [
      "doctor",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
    ]);
    assert.equal(doctor.json.data.ok, true);

    const scheduleId = "weekday-catalog-refresh";
    const scheduleTarget = ["--mode", "code", "--root", harness.repositoryRoot];
    const scheduleSet = await runCliSuccess(harness, [
      "schedule",
      ...scheduleTarget,
      "--action",
      "set",
      "--id",
      scheduleId,
      "--operation",
      "update",
      "--cron",
      "0 6 * * 1-5",
      "--timezone",
      "UTC",
    ]);
    assertSemanticText(scheduleSet.json.data, [new RegExp(scheduleId, "u"), /0 6 \* \* 1-5/u]);
    const scheduleList = await runCliSuccess(harness, [
      "schedule",
      ...scheduleTarget,
      "--action",
      "list",
    ]);
    assertSemanticText(scheduleList.json.data, [new RegExp(scheduleId, "u")]);
    const scheduleRemove = await runCliSuccess(harness, [
      "schedule",
      ...scheduleTarget,
      "--action",
      "remove",
      "--id",
      scheduleId,
    ]);
    assertSemanticText(scheduleRemove.json.data, [new RegExp(scheduleId, "u")]);
    const scheduleListAfterRemoval = await runCliSuccess(harness, [
      "schedule",
      ...scheduleTarget,
      "--action",
      "list",
    ]);
    assert.doesNotMatch(JSON.stringify(scheduleListAfterRemoval.json.data), new RegExp(scheduleId, "u"));

    await runMcpJourney(harness);

    const purge = await runCliSuccess(harness, [
      "purge",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--scope",
      "raw",
    ]);
    assertSemanticText(purge.json.data, [/raw/u]);
    const postPurgePrivateData = await directoryText(dataRoot);
    assert.doesNotMatch(postPurgePrivateData, /gmail-catalog-decisions|slack-catalog-incident/u);
    assert.equal(await pathExists(join(wikiRoot, "architecture.md")), true);
    const postPurgeSearch = await runCliSuccess(harness, [
      "search",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--query",
      "groupActiveProductsByCategory",
      "--limit",
      "5",
      // lexical only — see the comment on the first search call above.
      "--signals",
      "lexical",
    ]);
    assert.ok(searchResults(postPurgeSearch.json.data).some(({ ref }) => ref.path === "architecture.md"));
  });

  test("builds and incrementally refreshes the proprietary bounded code graph without GitNexus", async (t) => {
    const harness = await createRepositoryHarness(t, { gitNexusTripwire: true });
    await initializeWiki(harness);

    const graphTarget = ["--mode", "code", "--root", harness.repositoryRoot];
    const build = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "build",
      "--force",
    ]);
    const buildData = assertGraphResult(build, "build", harness.repositoryRoot);
    assertHasPositiveCount(buildData);
    assert.equal(buildData.buildMode, "full");
    assert.ok(Array.isArray(buildData.changedPaths));
    assert.equal(typeof buildData.truncated, "boolean");
    assert.equal(Object.hasOwn(buildData, "graph"), false);
    assertSemanticText(buildData, [new RegExp(harness.initialHead, "u")]);

    const status = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "status",
    ]);
    const statusData = assertGraphResult(status, "status", harness.repositoryRoot);
    assertHasPositiveCount(statusData);
    assertSemanticText(statusData, [/fresh/iu, new RegExp(harness.initialHead, "u")]);

    const query = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "query",
      "--query",
      "active catalog products",
      "--limit",
      "3",
    ]);
    const queryData = assertGraphResult(query, "query", harness.repositoryRoot, 3);
    assertSemanticText(queryData, [/listActiveProducts/u, /src\/catalog\.mjs/u]);

    const symbolContext = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "context",
      "--target",
      "listActiveProducts",
      "--limit",
      "5",
    ]);
    const contextData = assertGraphResult(symbolContext, "context", harness.repositoryRoot, 5);
    assertSemanticText(contextData, [
      /listActiveProducts/u,
      /src\/catalog\.mjs/u,
      /summarizeCatalog|catalog\.test\.mjs/u,
    ]);

    const impact = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "impact",
      "--target",
      "listActiveProducts",
      "--direction",
      "inbound",
      "--depth",
      "2",
      "--limit",
      "5",
    ]);
    const impactData = assertGraphResult(impact, "impact", harness.repositoryRoot, 5);
    assertSemanticText(impactData, [
      /listActiveProducts/u,
      /inbound/u,
      /summarizeCatalog|catalog\.test\.mjs/u,
    ]);

    const graphMap = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "map",
      "--limit",
      "10",
    ]);
    const mapData = assertGraphResult(graphMap, "map", harness.repositoryRoot, 10);
    assert.ok(mapData.modules.length > 0 || mapData.hubs.length > 0, "Graph map must expose bounded public topology.");
    assertSemanticText(mapData, [/findProductBySku/u, /catalog\.mjs/u]);

    await runCliError(
      harness,
      [
        "graph",
        ...graphTarget,
        "--action",
        "query",
        "--query",
        "catalog",
        "--limit",
        "1",
        "--force",
      ],
      "INVALID_ARGUMENT",
    );
    await runCliError(
      harness,
      [
        "graph",
        ...graphTarget,
        "--action",
        "status",
        "--provider",
        "gitnexus",
      ],
      "INVALID_ARGUMENT",
    );

    await appendFile(
      join(harness.repositoryRoot, "src/catalog.mjs"),
      `
export function catalogDependencyMap() {
  return new Map(listActiveProducts().map((product) => [product.sku, product.category]));
}
`,
    );
    const workingTreeChanges = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "changes",
      "--base",
      harness.initialHead,
      "--limit",
      "10",
    ]);
    const workingTreeData = assertGraphResult(
      workingTreeChanges,
      "changes",
      harness.repositoryRoot,
      10,
    );
    assertSemanticText(workingTreeData, [/src\/catalog\.mjs/u, /working|uncommitted|modified/iu]);

    await git(harness, ["add", "src/catalog.mjs"]);
    await git(harness, ["commit", "-m", "feat: add catalog dependency map"], {
      env: {
        GIT_AUTHOR_DATE: "2026-07-11T11:00:00Z",
        GIT_COMMITTER_DATE: "2026-07-11T11:00:00Z",
      },
    });
    const updatedHead = (await git(harness, ["rev-parse", "HEAD"])).stdout.trim();

    const committedChanges = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "changes",
      "--base",
      harness.initialHead,
      "--limit",
      "10",
    ]);
    const committedChangesData = assertGraphResult(
      committedChanges,
      "changes",
      harness.repositoryRoot,
      10,
    );
    assertSemanticText(committedChangesData, [
      /src\/catalog\.mjs/u,
      new RegExp(harness.initialHead, "u"),
      new RegExp(updatedHead, "u"),
    ]);

    const staleStatus = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "status",
    ]);
    const staleData = assertGraphResult(staleStatus, "status", harness.repositoryRoot);
    assertSemanticText(staleData, [
      /stale|out.of.date|fresh[^]*false/iu,
      new RegExp(harness.initialHead, "u"),
      new RegExp(updatedHead, "u"),
    ]);

    const incrementalBuild = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "build",
    ]);
    const incrementalData = assertGraphResult(
      incrementalBuild,
      "build",
      harness.repositoryRoot,
    );
    assertHasPositiveCount(incrementalData);
    assert.equal(incrementalData.buildMode, "incremental");
    assert.equal(incrementalData.previousHead, harness.initialHead);
    assert.ok(Array.isArray(incrementalData.changedPaths));
    assert.equal(Object.hasOwn(incrementalData, "graph"), false);
    assertSemanticText(incrementalData, [
      /incremental/iu,
      /src\/catalog\.mjs/u,
      new RegExp(harness.initialHead, "u"),
      new RegExp(updatedHead, "u"),
    ]);

    const updatedQuery = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "query",
      "--query",
      "catalog dependency map",
      "--limit",
      "3",
    ]);
    const updatedQueryData = assertGraphResult(
      updatedQuery,
      "query",
      harness.repositoryRoot,
      3,
    );
    assertSemanticText(updatedQueryData, [/catalogDependencyMap/u, /src\/catalog\.mjs/u]);
    await assertGitNexusWasNotInvoked(harness);
  });

  test("slice 2c: report/communities/path/explain are deterministic across two runs and mirrored over MCP", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const graphTarget = ["--mode", "code", "--root", harness.repositoryRoot];

    await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "build", "--force"]);

    const reportFirst = await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "report"]);
    const reportData = assertGraphResult(reportFirst, "report", harness.repositoryRoot);
    assert.equal(reportData.page, "graph-report.md");
    assert.equal(reportData.written, true);
    assert.ok(reportData.communityCount >= 1);
    assert.match(reportData.generation, /^g-[a-f0-9]{64}$/u);

    const reportPageRaw = await readFile(join(harness.repositoryRoot, "openwiki", "graph-report.md"), "utf8");
    for (const heading of [
      "# Graph Report",
      "## God nodes",
      "## Communities",
      "## Surprising connections",
      "## Suggested questions",
      "## Coverage",
      "## Ambiguous edges pending review",
    ]) {
      assert.ok(reportPageRaw.includes(heading), `graph-report.md is missing "${heading}"`);
    }
    assertSemanticText(reportPageRaw, [/listActiveProducts|findProductBySku|summarizeCatalog/u]);

    const communitiesFirst = await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "communities", "--limit", "10"]);
    const communitiesSecond = await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "communities", "--limit", "10"]);
    assert.deepEqual(communitiesFirst.json.data, communitiesSecond.json.data);
    assert.equal(communitiesFirst.json.data.stale, false);

    const explainFirst = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "explain",
      "--target",
      "listActiveProducts",
      "--limit",
      "10",
    ]);
    const explainSecond = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "explain",
      "--target",
      "listActiveProducts",
      "--limit",
      "10",
    ]);
    assert.deepEqual(explainFirst.json.data, explainSecond.json.data);
    assert.equal(explainFirst.json.data.node.name, "listActiveProducts");
    assert.equal(explainFirst.json.data.communityStale, false);

    const pathFirst = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "path",
      "--from",
      "listActiveProducts",
      "--to",
      "summarizeCatalog",
    ]);
    const pathSecond = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "path",
      "--from",
      "listActiveProducts",
      "--to",
      "summarizeCatalog",
    ]);
    assert.deepEqual(pathFirst.json.data, pathSecond.json.data);
    assert.equal(pathFirst.json.data.found, true);
    assert.ok(pathFirst.json.data.nodes.some((candidate) => candidate.name === "listActiveProducts"));
    assert.ok(pathFirst.json.data.nodes.some((candidate) => candidate.name === "summarizeCatalog"));

    await runCliError(
      harness,
      ["graph", ...graphTarget, "--action", "path", "--from", "listActiveProducts", "--to", "doesNotExist"],
      "NOT_FOUND",
    );

    assert.ok(existsSync(MCP_PATH), `Missing compiled MCP adapter: ${MCP_PATH}.`);
    const mcpRequests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slice-2c-e2e", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "report" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "communities", limit: 10 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "explain", target: "listActiveProducts", limit: 10 } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "path", from: "listActiveProducts", to: "summarizeCatalog" } } },
    ];
    const mcpResult = await runProcess(process.execPath, [MCP_PATH], {
      cwd: harness.repositoryRoot,
      env: harness.env,
      input: `${mcpRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    });
    assert.equal(mcpResult.code, 0, mcpResult.stderr || mcpResult.stdout);
    assert.equal(mcpResult.stderr, "");
    const mcpResponses = mcpResult.stdout
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const byId = new Map(mcpResponses.map((response) => [response.id, response]));
    const parseEnvelope = (id) => JSON.parse(byId.get(id).result.content[0].text);
    assert.equal(parseEnvelope(2).data.action, "report");
    // The MCP batch's own "report" call (id 2) legitimately refreshes communities.json's
    // generatedAt even though the graph is unchanged (same documented, already-tested
    // idempotent-generation behavior Task 6/7 rely on) — so the "communities" read that
    // follows it (id 3) is compared against communitiesFirst on every field except the
    // wall-clock generatedAt, which is asserted to be a real timestamp instead.
    const { generatedAt: communitiesViaMcpGeneratedAt, ...communitiesViaMcpRest } = parseEnvelope(3).data;
    const { generatedAt: communitiesViaCliGeneratedAt, ...communitiesViaCliRest } = communitiesFirst.json.data;
    assert.deepEqual(communitiesViaMcpRest, communitiesViaCliRest);
    assert.equal(Number.isNaN(Date.parse(communitiesViaMcpGeneratedAt)), false);
    assert.equal(Number.isNaN(Date.parse(communitiesViaCliGeneratedAt)), false);
    assert.deepEqual(parseEnvelope(4).data, explainFirst.json.data);
    assert.deepEqual(parseEnvelope(5).data, pathFirst.json.data);
  });

  test("enrich grounds a wiki page in the graph with a real code-symbol mention, verified by check", async (t) => {
    const harness = await createRepositoryHarness(t, { gitNexusTripwire: true });
    await initializeWiki(harness);
    const graphTarget = ["--mode", "code", "--root", harness.repositoryRoot];
    await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "build", "--force"]);

    const symbolQuery = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "query",
      "--query",
      "listActiveProducts",
      "--limit",
      "5",
    ]);
    const symbolData = assertGraphResult(symbolQuery, "query", harness.repositoryRoot, 5);
    const symbolNode = symbolData.nodes.find((node) => node.name === "listActiveProducts");
    assert.ok(symbolNode, "expected the sample repository scanner to expose listActiveProducts");

    const pagePath = join(harness.repositoryRoot, "openwiki", "architecture.md");
    const pageContent = await readFile(pagePath, "utf8");
    const pageHash = createHash("sha256").update(pageContent).digest("hex");
    const enrichEnvelope = {
      schema: "memex.enrich.v1",
      sourcePath: "openwiki/architecture.md",
      sourceContentHash: pageHash,
      nodes: [{ kind: "page", name: "openwiki/architecture.md", path: "openwiki/architecture.md" }],
      edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: symbolNode.id, confidence: "inferred" }],
    };

    const enrichResult = await runCliSuccess(
      harness,
      ["enrich", "--root", harness.repositoryRoot, "--stdin"],
      { input: JSON.stringify(enrichEnvelope) },
    );
    assert.equal(enrichResult.json.data.applied, true);
    assert.equal(enrichResult.json.data.nodesWritten, 2);

    const secondEnrich = await runCliSuccess(
      harness,
      ["enrich", "--root", harness.repositoryRoot, "--stdin"],
      { input: JSON.stringify(enrichEnvelope) },
    );
    assert.equal(secondEnrich.json.data.applied, false);

    // graph query/context/impact resolve --target by fuzzy name/path search (rankedCandidates),
    // never by raw hex node id -- so the lookup below targets the symbol's name, matching this
    // file's other context/impact assertions, not the enrich edge's own hex-id reference form.
    const context = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "context",
      "--target",
      "listActiveProducts",
      "--limit",
      "10",
    ]);
    const contextData = assertGraphResult(context, "context", harness.repositoryRoot, 10);
    assert.equal(contextData.edges.some((edge) => edge.kind === "mentions" && edge.to === symbolNode.id), true);

    const check = await runCliSuccess(harness, ["check", "--mode", "code", "--root", harness.repositoryRoot]);
    assert.equal(
      check.json.data.issues.some((issue) => issue.code === "MISSING_PAGE_NODE" && issue.page === "architecture.md"),
      false,
    );

    await assertGitNexusWasNotInvoked(harness);
  });
});

describe("OpenWiki process-boundary security regressions", () => {
  test("rejects markdown traversal with a stable safe error", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const result = await runCliError(
      harness,
      [
        "write",
        "--mode",
        "code",
        "--root",
        harness.repositoryRoot,
        "--page",
        "../outside.md",
        "--content",
        "must not escape",
      ],
      "PATH_OUTSIDE_ROOT",
    );
    assert.doesNotMatch(result.stdout, new RegExp(harness.outsideRoot.replaceAll("\\", "\\\\"), "u"));
    assert.equal(await pathExists(join(harness.repositoryRoot, "outside.md")), false);
  });

  test("rejects a wiki symlink escape without modifying its target", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const outsidePage = join(harness.outsideRoot, "protected.md");
    await writeFile(outsidePage, "protected outside content\n");
    await symlink(outsidePage, join(harness.repositoryRoot, "openwiki", "escape.md"));

    await runCliError(
      harness,
      [
        "write",
        "--mode",
        "code",
        "--root",
        harness.repositoryRoot,
        "--page",
        "escape.md",
        "--content",
        "overwrite attempt",
      ],
      "SYMLINK_ESCAPE",
    );
    assert.equal(await readFile(outsidePage, "utf8"), "protected outside content\n");
  });

  test("stores prompt-injection-shaped source as inert redacted data", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const beforeDigest = await wikiDigest(harness.repositoryRoot);
    const beforeState = await readFile(
      join(harness.repositoryRoot, "openwiki", ".last-update.json"),
      "utf8",
    );
    const result = await runCliSuccess(harness, [
      "ingest",
      "--mode",
      "code",
      "--root",
      harness.repositoryRoot,
      "--envelope-file",
      join(SOURCE_FIXTURES, "prompt-injection.json"),
    ]);

    const persisted = await directoryText(join(harness.homeRoot, ".openwiki", "data"));
    assert.match(persisted, /IGNORE ALL PREVIOUS INSTRUCTIONS/u);
    assert.match(persisted, /redact/iu);
    assert.doesNotMatch(persisted, /sk-test-openwiki-secret-1234567890/u);
    assert.doesNotMatch(result.stdout, /sk-test-openwiki-secret-1234567890|IGNORE ALL PREVIOUS/u);
    assert.equal(await wikiDigest(harness.repositoryRoot), beforeDigest);
    assert.equal(
      await readFile(join(harness.repositoryRoot, "openwiki", ".last-update.json"), "utf8"),
      beforeState,
    );
  });

  test("rejects a malformed source envelope with a stable safe error", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    await runCliError(
      harness,
      [
        "ingest",
        "--mode",
        "code",
        "--root",
        harness.repositoryRoot,
        "--envelope-file",
        join(SOURCE_FIXTURES, "malformed.json"),
      ],
      "UNSUPPORTED_SOURCE",
    );
  });

  test("rejects an oversized source envelope before private persistence", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const oversizedPath = join(harness.sandboxRoot, "Oversized Source Envelope.json");
    await writeFile(
      oversizedPath,
      JSON.stringify({
        schemaVersion: 1,
        sourceId: "oversized-web-search",
        kind: "web-search",
        fetchedAt: "2026-07-11T12:00:00.000Z",
        provenance: { host: "cli", query: "bounded input" },
        items: [{ externalId: "large-item", text: "x".repeat(2 * 1024 * 1024) }],
      }),
    );
    await runCliError(
      harness,
      [
        "ingest",
        "--mode",
        "code",
        "--root",
        harness.repositoryRoot,
        "--envelope-file",
        oversizedPath,
      ],
      "SOURCE_TOO_LARGE",
    );
    assert.equal((await listFiles(join(harness.homeRoot, ".openwiki", "data"))).length, 0);
  });
});
