import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "../..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "../..");
const SCRIPT_ROOT = join(PLUGIN_ROOT, "scripts");
const FIXTURE_BIN = join(PLUGIN_ROOT, "tests/fixtures/client-bin");
const PLUGIN_ID = "openwiki@openwiki-local";
const LIVE_SMOKE_ENABLED = process.env.OPENWIKI_RUN_CLIENT_SMOKE === "1";
const LIVE_LIFECYCLE_TIMEOUT_MS = 90_000;
const TOOL_NAMES = [
  "init", "status", "context", "search", "read", "write", "ingest",
  "finalize", "check", "doctor", "schedule", "purge", "graph",
];
const GRAPH_ACTIONS = ["build", "status", "query", "context", "impact", "changes", "map"];

function emptyClientState() {
  return {
    codex: { marketplaces: [], installed: [] },
    claude: { marketplaces: [], installed: [] },
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    shell: false,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
  });
}

function parseJson(stdout, context) {
  assert.notEqual(stdout.trim(), "", `${context} must emit JSON.`);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    assert.fail(`${context} emitted invalid JSON: ${error.message}\n${stdout}`);
  }
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8").trim();
  return content === "" ? [] : content.split(/\r?\n/u).map((line) => JSON.parse(line));
}

function createLifecycleHarness(t) {
  const root = mkdtempSync(join(tmpdir(), "openwiki client lifecycle "));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const claudeConfig = join(home, ".claude");
  const statePath = join(root, "client-state.json");
  const logPath = join(root, "client-argv.jsonl");
  writeFileSync(statePath, `${JSON.stringify(emptyClientState(), null, 2)}\n`);
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env = {
    ...process.env,
    PATH: `${FIXTURE_BIN}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    OPENWIKI_TEST_LOG: logPath,
    OPENWIKI_TEST_STATE: statePath,
  };

  return {
    root,
    runScript(script, args) {
      writeFileSync(logPath, "");
      const result = run(process.execPath, [join(SCRIPT_ROOT, script), ...args], {
        cwd: root,
        env,
      });
      return { ...result, json: parseJson(result.stdout, script) };
    },
    readLog: () => readJsonLines(logPath),
    readState: () => JSON.parse(readFileSync(statePath, "utf8")),
  };
}

function createIsolatedLiveEnvironment(t, client) {
  const root = mkdtempSync(join(tmpdir(), `openwiki live ${client} `));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };
  for (const directory of [
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  delete env.OPENWIKI_TEST_LOG;
  delete env.OPENWIKI_TEST_STATE;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env };
}

function copyDisposableMarketplace(destination) {
  cpSync(REPOSITORY_ROOT, destination, {
    recursive: true,
    filter(source) {
      const path = relative(REPOSITORY_ROOT, source);
      return !path.split(sep).some((segment) => segment === ".git" || segment === "node_modules");
    },
  });
}

function installedRoots(live, codexList, claudeList) {
  const codexEntry = codexList.installed.find(({ pluginId }) => pluginId === PLUGIN_ID);
  const claudeEntry = claudeList.find(({ id }) => id === PLUGIN_ID);
  assert.match(codexEntry?.version ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  assert.match(claudeEntry?.version ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  const codex = join(
    live.env.CODEX_HOME,
    "plugins/cache/openwiki-local/openwiki",
    codexEntry.version,
  );
  const claude = join(
    live.env.CLAUDE_CONFIG_DIR,
    "plugins/cache/openwiki-local/openwiki",
    claudeEntry.version,
  );
  assert.equal(resolve(claudeEntry.installPath), resolve(claude));
  return { codex, claude };
}

function assertInstalledArtifacts(client, root) {
  assert.equal(lstatSync(root).isSymbolicLink(), false, root);
  const artifacts = [
    "bin/openwiki",
    "dist/cli.js",
    "dist/mcp.js",
    client === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json",
    client === "codex" ? ".codex-plugin/mcp.json" : ".claude-plugin/mcp.json",
    "skills/openwiki/SKILL.md",
    ...(client === "claude" ? ["hooks/hooks.json", "dist/hook.js"] : []),
  ];
  for (const artifact of artifacts) {
    const path = join(root, artifact);
    const entry = lstatSync(path);
    assert.equal(entry.isFile(), true, path);
    assert.equal(entry.isSymbolicLink(), false, path);
  }
  if (process.platform !== "win32") {
    assert.notEqual(statSync(join(root, "bin/openwiki")).mode & 0o111, 0);
  }
}

function parseMcpInventory(stdout) {
  const responses = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const initialize = responses.find(({ id }) => id === 1);
  const tools = responses.find(({ id }) => id === 2).result.tools;
  const graph = tools.find(({ name }) => name === "graph");
  assert.equal(initialize.result.protocolVersion, "2025-06-18");
  assert.deepEqual(tools.map(({ name }) => name), TOOL_NAMES);
  assert.deepEqual(
    graph.inputSchema.oneOf.map((branch) => branch.properties.action.const),
    GRAPH_ACTIONS,
  );
  return tools.map(({ name }) => name);
}

function snapshotFiles(roots) {
  const snapshot = [];
  const visit = (root, path = root) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(root, child);
      else if (entry.isFile()) {
        const stat = statSync(child);
        snapshot.push([relative(root, child), stat.size, stat.mtimeMs]);
      }
    }
  };
  for (const root of roots) visit(root);
  return snapshot.sort(([left], [right]) => left.localeCompare(right));
}

function assertNoFirstUseDependencies(root) {
  const forbidden = /\b(?:npx|npm|tsc|gitnexus|ladybug)\b/iu;
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) assert.doesNotMatch(readFileSync(child, "utf8"), forbidden, child);
    }
  };
  visit(join(root, "bin"));
  visit(join(root, "dist"));
}

const expectedInstallArgv = [
  { client: "codex", argv: ["plugin", "marketplace", "list", "--json"] },
  { client: "claude", argv: ["plugin", "marketplace", "list", "--json"] },
  {
    client: "codex",
    argv: ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--json"],
  },
  { client: "codex", argv: ["plugin", "list", "--json"] },
  { client: "codex", argv: ["plugin", "add", PLUGIN_ID, "--json"] },
  { client: "codex", argv: ["plugin", "list", "--json"] },
  {
    client: "claude",
    argv: [
      "plugin",
      "marketplace",
      "add",
      REPOSITORY_ROOT,
      "--scope",
      "user",
    ],
  },
  { client: "claude", argv: ["plugin", "list", "--json"] },
  {
    client: "claude",
    argv: ["plugin", "install", PLUGIN_ID, "--scope", "user"],
  },
  { client: "claude", argv: ["plugin", "list", "--json"] },
];

const expectedUninstallArgv = [
  { client: "codex", argv: ["plugin", "marketplace", "list", "--json"] },
  { client: "claude", argv: ["plugin", "marketplace", "list", "--json"] },
  { client: "codex", argv: ["plugin", "list", "--json"] },
  { client: "codex", argv: ["plugin", "remove", PLUGIN_ID, "--json"] },
  {
    client: "codex",
    argv: ["plugin", "marketplace", "remove", "openwiki-local", "--json"],
  },
  { client: "claude", argv: ["plugin", "list", "--json"] },
  {
    client: "claude",
    argv: ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"],
  },
  {
    client: "claude",
    argv: ["plugin", "marketplace", "remove", "openwiki-local", "--scope", "user"],
  },
];

describe("OpenWiki plugin clients", { concurrency: 1 }, () => {
  test("honors a caller-provided process timeout", () => {
    const result = run(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
      timeout: 10,
    });
    assert.equal(result.status, null);
    assert.equal(result.error?.code, "ETIMEDOUT");
  });

  test("executes exact Codex and Claude lifecycle commands through real fixture processes", (t) => {
    const harness = createLifecycleHarness(t);
    const install = harness.runScript("install.mjs", ["--all", "--json"]);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(install.json.ok, true);
    assert.deepEqual(harness.readLog(), expectedInstallArgv);
    assert.equal(harness.readState().codex.marketplaces.length, 1);
    assert.equal(harness.readState().codex.installed.length, 1);
    assert.equal(harness.readState().claude.marketplaces.length, 1);
    assert.equal(harness.readState().claude.installed.length, 1);

    const secondInstall = harness.runScript("install.mjs", ["--all", "--json"]);
    assert.equal(secondInstall.status, 0, secondInstall.stderr);
    assert.equal(secondInstall.json.ok, true);
    assert.equal(
      harness
        .readLog()
        .some(({ argv }) => argv.includes("add") || argv.includes("install")),
      false,
      "An idempotent reinstall must perform discovery only.",
    );

    const uninstall = harness.runScript("uninstall.mjs", ["--all", "--json"]);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(uninstall.json.ok, true);
    assert.deepEqual(harness.readLog(), expectedUninstallArgv);
    assert.deepEqual(harness.readState(), emptyClientState());
  });

  test(
    "installs, lists, and removes the plugin with the real Codex client in an isolated home",
    {
      skip: LIVE_SMOKE_ENABLED
        ? false
        : "OPENWIKI_RUN_CLIENT_SMOKE is not 1; live Codex smoke intentionally not executed.",
    },
    (t) => {
      const live = createIsolatedLiveEnvironment(t, "codex");
      const install = run(process.execPath, [join(SCRIPT_ROOT, "install.mjs"), "--codex", "--json"], {
        cwd: live.root,
        env: live.env,
        timeout: LIVE_LIFECYCLE_TIMEOUT_MS,
      });
      assert.equal(install.status, 0, install.stderr || install.stdout);
      assert.equal(parseJson(install.stdout, "live Codex install").ok, true);

      const list = run("codex", ["plugin", "list", "--json"], {
        cwd: live.root,
        env: live.env,
      });
      assert.equal(list.status, 0, list.stderr || list.stdout);
      assert.match(list.stdout, /openwiki/u);

      const uninstall = run(
        process.execPath,
        [join(SCRIPT_ROOT, "uninstall.mjs"), "--codex", "--json"],
        { cwd: live.root, env: live.env, timeout: LIVE_LIFECYCLE_TIMEOUT_MS },
      );
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
      assert.equal(parseJson(uninstall.stdout, "live Codex uninstall").ok, true);
    },
  );

  test(
    "validates, installs, lists, and removes the plugin with the real Claude client in an isolated home",
    {
      skip: LIVE_SMOKE_ENABLED
        ? false
        : "OPENWIKI_RUN_CLIENT_SMOKE is not 1; live Claude smoke intentionally not executed.",
    },
    (t) => {
      const live = createIsolatedLiveEnvironment(t, "claude");
      const validate = run("claude", ["plugin", "validate", "--strict", PLUGIN_ROOT], {
        cwd: live.root,
        env: live.env,
      });
      assert.equal(validate.status, 0, validate.stderr || validate.stdout);

      const install = run(
        process.execPath,
        [join(SCRIPT_ROOT, "install.mjs"), "--claude", "--json"],
        { cwd: live.root, env: live.env, timeout: LIVE_LIFECYCLE_TIMEOUT_MS },
      );
      assert.equal(install.status, 0, install.stderr || install.stdout);
      assert.equal(parseJson(install.stdout, "live Claude install").ok, true);

      const list = run("claude", ["plugin", "list", "--json"], {
        cwd: live.root,
        env: live.env,
      });
      assert.equal(list.status, 0, list.stderr || list.stdout);
      assert.match(list.stdout, /openwiki/u);

      const details = run("claude", ["plugin", "details", PLUGIN_ID], {
        cwd: live.root,
        env: live.env,
      });
      assert.equal(details.status, 0, details.stderr || details.stdout);
      assert.match(details.stdout, /openwiki/u);

      const uninstall = run(
        process.execPath,
        [join(SCRIPT_ROOT, "uninstall.mjs"), "--claude", "--json"],
        { cwd: live.root, env: live.env, timeout: LIVE_LIFECYCLE_TIMEOUT_MS },
      );
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
      assert.equal(parseJson(uninstall.stdout, "live Claude uninstall").ok, true);
    },
  );

  test(
    "runs both installed caches after their disposable marketplace source is removed",
    {
      skip: LIVE_SMOKE_ENABLED
        ? false
        : "OPENWIKI_RUN_CLIENT_SMOKE is not 1; live installed-cache smoke intentionally not executed.",
    },
    (t) => {
      const live = createIsolatedLiveEnvironment(t, "offline cache");
      const source = join(live.root, "marketplace checkout with spaces");
      const npmCache = join(live.root, "empty npm cache");
      const handshake = readFileSync(
        join(PLUGIN_ROOT, "tests/fixtures/mcp/handshake.jsonl"),
        "utf8",
      );
      mkdirSync(npmCache);
      copyDisposableMarketplace(source);
      const env = {
        ...live.env,
        npm_config_cache: npmCache,
        npm_config_offline: "true",
      };

      for (const validationRoot of [source, join(source, "plugins/openwiki")]) {
        const validation = run("claude", ["plugin", "validate", "--strict", validationRoot], {
          cwd: live.root,
          env,
        });
        assert.equal(validation.status, 0, validation.stderr || validation.stdout);
      }

      const install = run(
        process.execPath,
        [join(source, "plugins/openwiki/scripts/install.mjs"), "--all", "--json"],
        { cwd: live.root, env, timeout: LIVE_LIFECYCLE_TIMEOUT_MS },
      );
      assert.equal(install.status, 0, install.stderr || install.stdout);
      assert.equal(parseJson(install.stdout, "offline cache install").ok, true);

      const codexListResult = run("codex", ["plugin", "list", "--json"], {
        cwd: live.root,
        env,
      });
      const claudeListResult = run("claude", ["plugin", "list", "--json"], {
        cwd: live.root,
        env,
      });
      assert.equal(codexListResult.status, 0, codexListResult.stderr || codexListResult.stdout);
      assert.equal(claudeListResult.status, 0, claudeListResult.stderr || claudeListResult.stdout);
      const roots = installedRoots(
        live,
        parseJson(codexListResult.stdout, "offline Codex plugin list"),
        parseJson(claudeListResult.stdout, "offline Claude plugin list"),
      );
      for (const [client, root] of Object.entries(roots)) {
        assertInstalledArtifacts(client, root);
        assertNoFirstUseDependencies(root);
      }

      rmSync(source, { recursive: true });
      assert.equal(existsSync(source), false);
      rmSync(npmCache, { recursive: true });
      mkdirSync(npmCache);

      const inventories = {};
      const repositories = {};
      for (const [client, root] of Object.entries(roots)) {
        const mcp = run(process.execPath, [join(root, "dist/mcp.js")], {
          cwd: live.root,
          env,
          input: handshake,
        });
        assert.equal(mcp.status, 0, mcp.stderr || mcp.stdout);
        assert.equal(mcp.stderr, "");
        inventories[client] = parseMcpInventory(mcp.stdout);

        const repository = join(live.root, `${client} repository with spaces`);
        mkdirSync(repository);
        const git = run("git", ["init", "--quiet"], { cwd: repository, env });
        assert.equal(git.status, 0, git.stderr || git.stdout);
        const cli = run(
          join(root, "bin/openwiki"),
          ["init", "--mode", "code", "--root", repository],
          { cwd: repository, env },
        );
        assert.equal(cli.status, 0, cli.stderr || cli.stdout);
        assert.equal(parseJson(cli.stdout, `offline ${client} CLI`).ok, true);
        repositories[client] = repository;
      }
      assert.deepEqual(inventories.codex, inventories.claude);

      const beforeHook = snapshotFiles([live.env.HOME, repositories.claude]);
      const hook = run(process.execPath, [join(roots.claude, "dist/hook.js")], {
        cwd: repositories.claude,
        env,
        input: `${JSON.stringify({
          session_id: "offline-installed-cache",
          transcript_path: join(live.root, "transcript.jsonl"),
          cwd: repositories.claude,
          hook_event_name: "SessionStart",
          source: "startup",
          model: "validation",
          permission_mode: "default",
          agent_type: "validation",
        })}\n`,
      });
      assert.equal(hook.status, 0, hook.stderr || hook.stdout);
      assert.equal(hook.stderr, "");
      const hookOutput = parseJson(hook.stdout, "installed Claude SessionStart hook");
      assert.equal(hookOutput.hookSpecificOutput.hookEventName, "SessionStart");
      assert.ok(
        Buffer.byteLength(hookOutput.hookSpecificOutput.additionalContext, "utf8") <= 300,
      );
      assert.deepEqual(snapshotFiles([live.env.HOME, repositories.claude]), beforeHook);
      assert.deepEqual(readdirSync(npmCache), []);
    },
  );
});
