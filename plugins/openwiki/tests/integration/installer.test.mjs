import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "../..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "../..");
const SCRIPT_DIR = join(PLUGIN_ROOT, "scripts");
const FIXTURE_BIN = join(PLUGIN_ROOT, "tests/fixtures/client-bin");
const MARKETPLACE = "openwiki-local";
const PLUGIN = "openwiki";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

const installCommands = {
  codex: [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--json"],
    ["plugin", "list", "--json"],
    ["plugin", "add", PLUGIN_ID, "--json"],
  ],
  claude: [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--scope", "user"],
    ["plugin", "list", "--json"],
    ["plugin", "install", PLUGIN_ID, "--scope", "user"],
  ],
};

const uninstallCommands = {
  codex: [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--json"],
    ["plugin", "remove", PLUGIN_ID, "--json"],
    ["plugin", "marketplace", "remove", MARKETPLACE, "--json"],
  ],
  claude: [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--json"],
    ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"],
    ["plugin", "marketplace", "remove", MARKETPLACE, "--scope", "user"],
  ],
};

function emptyState() {
  return {
    codex: { marketplaces: [], installed: [] },
    claude: { marketplaces: [], installed: [] },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function marketplaceEntry(client, source = REPOSITORY_ROOT) {
  if (client === "codex") {
    return {
      name: MARKETPLACE,
      root: source,
      marketplaceSource: { sourceType: "local", source },
    };
  }

  return {
    name: MARKETPLACE,
    source: "directory",
    path: source,
    installLocation: source,
  };
}

function installedEntry(client) {
  if (client === "codex") {
    return {
      pluginId: PLUGIN_ID,
      name: PLUGIN,
      marketplaceName: MARKETPLACE,
      installed: true,
    };
  }

  return {
    id: PLUGIN_ID,
    name: PLUGIN,
    marketplace: MARKETPLACE,
    enabled: true,
  };
}

function stateWithInstalled(target) {
  const state = emptyState();
  for (const client of target === "all" ? ["codex", "claude"] : [target]) {
    state[client].marketplaces.push(marketplaceEntry(client));
    state[client].installed.push(installedEntry(client));
  }
  return state;
}

function createHarness(t, initialState = emptyState()) {
  const directory = mkdtempSync(join(tmpdir(), "openwiki installer "));
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "argv.jsonl");
  writeFileSync(statePath, `${JSON.stringify(initialState, null, 2)}\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return {
    run(scriptName, args) {
      writeFileSync(logPath, "");
      const result = spawnSync(process.execPath, [join(SCRIPT_DIR, scriptName), ...args], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${FIXTURE_BIN}${delimiter}${process.env.PATH ?? ""}`,
          OPENWIKI_TEST_LOG: logPath,
          OPENWIKI_TEST_STATE: statePath,
        },
        shell: false,
      });

      return {
        ...result,
        json: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
      };
    },
    readLog() {
      if (!existsSync(logPath)) return [];
      const content = readFileSync(logPath, "utf8").trim();
      return content === "" ? [] : content.split("\n").map((line) => JSON.parse(line));
    },
    readState() {
      return JSON.parse(readFileSync(statePath, "utf8"));
    },
  };
}

function expectedLog(target, commandMap) {
  if (target !== "all") {
    return commandMap[target].map((argv) => ({ client: target, argv }));
  }

  return [
    { client: "codex", argv: commandMap.codex[0] },
    { client: "claude", argv: commandMap.claude[0] },
    ...commandMap.codex.slice(1).map((argv) => ({ client: "codex", argv })),
    ...commandMap.claude.slice(1).map((argv) => ({ client: "claude", argv })),
  ];
}

function plannedCommands(output) {
  return output.commands.map(({ client, argv }) => ({ client, argv }));
}

describe("repository-local plugin lifecycle", () => {
  test("install dry-run returns the complete ordered plan without executing clients", (t) => {
    const harness = createHarness(t);
    const result = harness.run("install.mjs", ["--all", "--dry-run", "--json"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.dryRun, true);
    assert.deepEqual(plannedCommands(result.json), expectedLog("all", installCommands));
    assert.deepEqual(harness.readLog(), []);
  });

  test("uninstall dry-run returns the complete ordered plan without executing clients", (t) => {
    const harness = createHarness(t);
    const result = harness.run("uninstall.mjs", ["--all", "--dry-run", "--json"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.dryRun, true);
    assert.deepEqual(plannedCommands(result.json), expectedLog("all", uninstallCommands));
    assert.deepEqual(harness.readLog(), []);
  });

  for (const target of ["codex", "claude", "all"]) {
    test(`install executes exact argv in deterministic ${target} order`, (t) => {
      const harness = createHarness(t);
      const result = harness.run("install.mjs", [`--${target}`, "--json"]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.ok, true);
      assert.deepEqual(harness.readLog(), expectedLog(target, installCommands));

      const clients = target === "all" ? ["codex", "claude"] : [target];
      for (const client of clients) {
        assert.equal(harness.readState()[client].marketplaces.length, 1);
        assert.equal(harness.readState()[client].installed.length, 1);
      }
    });

    test(`uninstall executes exact argv in deterministic ${target} order`, (t) => {
      const harness = createHarness(t, stateWithInstalled(target));
      const result = harness.run("uninstall.mjs", [`--${target}`, "--json"]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.ok, true);
      assert.deepEqual(harness.readLog(), expectedLog(target, uninstallCommands));

      const clients = target === "all" ? ["codex", "claude"] : [target];
      for (const client of clients) {
        assert.deepEqual(harness.readState()[client], { marketplaces: [], installed: [] });
      }
    });
  }

  test("repeated install is idempotent and executes no duplicate mutation", (t) => {
    const harness = createHarness(t);
    assert.equal(harness.run("install.mjs", ["--all", "--json"]).status, 0);

    const second = harness.run("install.mjs", ["--all", "--json"]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(harness.readLog(), [
      { client: "codex", argv: installCommands.codex[0] },
      { client: "claude", argv: installCommands.claude[0] },
      { client: "codex", argv: installCommands.codex[2] },
      { client: "claude", argv: installCommands.claude[2] },
    ]);
  });

  test("all-target collision preflight prevents partial mutation of the other client", (t) => {
    const state = emptyState();
    state.claude.marketplaces.push(
      marketplaceEntry("claude", "/tmp/unrelated-marketplace"),
    );
    const original = cloneJson(state);
    const harness = createHarness(t, state);

    const result = harness.run("install.mjs", ["--all", "--json"]);

    assert.equal(result.status, 1);
    assert.equal(result.json.error.code, "MARKETPLACE_COLLISION");
    assert.deepEqual(harness.readState(), original);
    assert.deepEqual(harness.readLog(), [
      { client: "codex", argv: installCommands.codex[0] },
      { client: "claude", argv: installCommands.claude[0] },
    ]);
  });

  for (const client of ["codex", "claude"]) {
    for (const scriptName of ["install.mjs", "uninstall.mjs"]) {
      test(`${scriptName} rejects an unrelated ${client} marketplace collision without mutation`, (t) => {
        const state = emptyState();
        state[client].marketplaces.push(marketplaceEntry(client, "/tmp/unrelated-marketplace"));
        state[client].installed.push({ unrelated: true });
        const original = cloneJson(state);
        const harness = createHarness(t, state);

        const result = harness.run(scriptName, [`--${client}`, "--json"]);

        assert.equal(result.status, 1);
        assert.equal(result.json.ok, false);
        assert.equal(result.json.error.code, "MARKETPLACE_COLLISION");
        assert.equal(result.json.error.client, client);
        assert.deepEqual(harness.readState(), original);
        assert.deepEqual(harness.readLog(), [
          {
            client,
            argv:
              scriptName === "install.mjs"
                ? installCommands[client][0]
                : uninstallCommands[client][0],
          },
        ]);
      });
    }
  }

  test("conflicting target flags fail before any client process starts", (t) => {
    const harness = createHarness(t);
    const result = harness.run("install.mjs", ["--codex", "--claude", "--json"]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "INVALID_ARGUMENT");
    assert.deepEqual(harness.readLog(), []);
  });
});

describe("repository validator", () => {
  test("reports missing integration artifacts as structured findings instead of crashing", (t) => {
    const harness = createHarness(t);
    const result = harness.run("validate.mjs", ["--json"]);

    assert.equal(result.status, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.action, "validate");
    assert.ok(Array.isArray(result.json.findings));
    assert.ok(result.json.findings.some((finding) => finding.code === "MISSING_FILE"));
    assert.deepEqual(harness.readLog(), []);
  });

  test("detects unsafe paths, placeholders, secrets, modes, attribution, and dist gaps", (t) => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "openwiki invalid repository "));
    t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

    const pluginRoot = join(temporaryRoot, "plugins/openwiki");
    mkdirSync(join(temporaryRoot, ".agents/plugins"), { recursive: true });
    mkdirSync(join(temporaryRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, "bin"), { recursive: true });
    mkdirSync(join(pluginRoot, "src"), { recursive: true });

    writeFileSync(
      join(temporaryRoot, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: MARKETPLACE,
        plugins: [
          {
            name: PLUGIN,
            source: { source: "local", path: "../outside" },
          },
        ],
      }),
    );
    writeFileSync(
      join(temporaryRoot, ".claude-plugin/marketplace.json"),
      JSON.stringify({
        name: MARKETPLACE,
        owner: { name: "TODO publisher" },
        plugins: [{ name: PLUGIN, source: "./plugins/openwiki" }],
      }),
    );
    writeFileSync(
      join(pluginRoot, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: PLUGIN, skills: "/tmp/external-skills" }),
    );
    writeFileSync(
      join(pluginRoot, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: PLUGIN, version: "0.1.0" }),
    );
    writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(pluginRoot, "src/cli.ts"), "export const cli = true;\n");
    writeFileSync(join(pluginRoot, "bin/openwiki"), "#!/usr/bin/env node\n");
    chmodSync(join(pluginRoot, "bin/openwiki"), 0o644);
    writeFileSync(
      join(pluginRoot, "README.md"),
      "Credential: sk-1234567890abcdefghijklmnopqrstuv\n",
    );

    const harness = createHarness(t);
    const result = harness.run("validate.mjs", ["--root", temporaryRoot, "--json"]);

    assert.equal(result.status, 1);
    const codes = new Set(result.json.findings.map(({ code }) => code));
    for (const expected of [
      "SOURCE_PATH_MISMATCH",
      "PATH_OUTSIDE_ROOT",
      "PLACEHOLDER",
      "LIKELY_SECRET",
      "NOT_EXECUTABLE",
      "MISSING_ATTRIBUTION",
      "MISSING_DIST",
    ]) {
      assert.ok(codes.has(expected), `Expected validator finding ${expected}`);
    }
    assert.deepEqual(harness.readLog(), []);
  });
});
