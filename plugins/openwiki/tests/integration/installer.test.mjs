import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  clientCommandTimeoutMs,
  inspectInstalledRuntime,
  pollInstalledRuntime,
  resolveHostConfigRoot,
} from "../../scripts/install.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "../..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "../..");
const SCRIPT_DIR = join(PLUGIN_ROOT, "scripts");
const FIXTURE_BIN = join(PLUGIN_ROOT, "tests/fixtures/client-bin");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const MARKETPLACE = "openwiki-local";
const PLUGIN = "openwiki";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

const installCommands = {
  codex: [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--json"],
    ["plugin", "list", "--json"],
    ["plugin", "add", PLUGIN_ID, "--json"],
    ["plugin", "list", "--json"],
  ],
  claude: [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--scope", "user"],
    ["plugin", "list", "--json"],
    ["plugin", "install", PLUGIN_ID, "--scope", "user"],
    ["plugin", "list", "--json"],
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

const dryRunInstallCommands = {
  codex: installCommands.codex.slice(0, -1),
  claude: installCommands.claude.slice(0, -1),
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

function createHarness(t, initialState = emptyState(), extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openwiki installer "));
  const home = join(directory, "home");
  const codexHome = join(home, ".codex");
  const claudeConfig = join(home, ".claude");
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "argv.jsonl");
  const childPidPath = join(directory, "child.pid");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  for (const entry of initialState.codex.installed) {
    if (entry.pluginId === PLUGIN_ID) entry.version ??= "0.1.0";
  }
  for (const entry of initialState.claude.installed) {
    if (entry.id === PLUGIN_ID) {
      entry.version ??= "0.1.0";
      entry.installPath ??= join(claudeConfig, "plugins/cache/openwiki-local/openwiki/0.1.0");
    }
  }
  writeFileSync(statePath, `${JSON.stringify(initialState, null, 2)}\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return {
    run(scriptName, args, options = {}) {
      writeFileSync(logPath, "");
      const result = spawnSync(process.execPath, [join(SCRIPT_DIR, scriptName), ...args], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${FIXTURE_BIN}${delimiter}${process.env.PATH ?? ""}`,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          CLAUDE_CONFIG_DIR: claudeConfig,
          OPENWIKI_TEST_LOG: logPath,
          OPENWIKI_TEST_STATE: statePath,
          OPENWIKI_TEST_CHILD_PID: childPidPath,
          ...extraEnv,
        },
        shell: false,
        timeout: options.timeout ?? 10_000,
      });

      return {
        ...result,
        json: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
      };
    },
    childPidPath,
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

function createInstalledRuntime(t, client, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openwiki installed runtime "));
  const codexHome = join(directory, ".codex");
  const claudeConfigDir = join(directory, ".claude");
  const version = options.version ?? "0.1.0";
  const configRoot = client === "codex" ? codexHome : claudeConfigDir;
  const expectedRoot = join(
    configRoot,
    "plugins/cache/openwiki-local/openwiki",
    version,
  );
  const root = options.rootSymlink
    ? join(directory, "outside installed runtime")
    : expectedRoot;
  const artifacts = [
    "bin/openwiki",
    "dist/cli.js",
    "dist/mcp.js",
    client === "codex"
      ? ".codex-plugin/plugin.json"
      : ".claude-plugin/plugin.json",
    client === "codex" ? ".codex-plugin/mcp.json" : ".claude-plugin/mcp.json",
    "skills/openwiki/SKILL.md",
    ...(client === "claude" ? ["hooks/hooks.json", "dist/hook.js"] : []),
  ];
  for (const artifact of artifacts) {
    if (options.missing === artifact) continue;
    const path = join(root, artifact);
    mkdirSync(dirname(path), { recursive: true });
    if (options.symlink === artifact) {
      const outside = join(directory, "outside-runtime.js");
      writeFileSync(outside, "export {};\n");
      symlinkSync(outside, path);
    } else {
      writeFileSync(path, artifact === "bin/openwiki" ? "#!/bin/sh\n" : "{}\n");
      if (artifact === "bin/openwiki") chmodSync(path, 0o755);
    }
  }
  if (options.rootSymlink) {
    mkdirSync(dirname(expectedRoot), { recursive: true });
    symlinkSync(root, expectedRoot);
  }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    entry:
      client === "codex"
        ? { pluginId: PLUGIN_ID, version }
        : { id: PLUGIN_ID, version, installPath: expectedRoot },
    roots: { codexHome, claudeConfigDir },
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(25);
  }
  return !processIsAlive(pid);
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
    assert.deepEqual(
      plannedCommands(result.json),
      expectedLog("all", dryRunInstallCommands),
    );
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
      { client: "codex", argv: installCommands.codex[4] },
      { client: "claude", argv: installCommands.claude[2] },
      { client: "claude", argv: installCommands.claude[4] },
    ]);
  });

  test("tears down orphaned descendants when a client command fails", async (t) => {
    const harness = createHarness(t, emptyState(), {
      OPENWIKI_TEST_ORPHAN_ON: "plugin install",
    });
    try {
      const result = harness.run("install.mjs", ["--claude", "--json"]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.json.error.code, "CLIENT_COMMAND_FAILED");
      const childPid = Number.parseInt(readFileSync(harness.childPidPath, "utf8"), 10);
      assert.ok(Number.isInteger(childPid));
      assert.equal(
        await waitForProcessExit(childPid),
        true,
        `orphaned client descendant ${childPid} remained alive`,
      );
    } finally {
      if (existsSync(harness.childPidPath)) {
        const childPid = Number.parseInt(readFileSync(harness.childPidPath, "utf8"), 10);
        if (processIsAlive(childPid)) process.kill(childPid, "SIGKILL");
      }
    }
  });

  test("caps client output and removes descendants without exposing raw content", async (t) => {
    const harness = createHarness(t, emptyState(), {
      OPENWIKI_TEST_OVERSIZED_OUTPUT_ON: "plugin install",
    });
    try {
      const result = harness.run("install.mjs", ["--claude", "--json"]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.json.error.code, "CLIENT_OUTPUT_TOO_LARGE");
      assert.equal(Object.hasOwn(result.json.error, "stderr"), false);
      assert.equal(JSON.stringify(result.json.error).includes("x".repeat(128)), false);
      const childPid = Number.parseInt(readFileSync(harness.childPidPath, "utf8"), 10);
      assert.ok(Number.isInteger(childPid));
      assert.equal(
        await waitForProcessExit(childPid),
        true,
        `oversized-output descendant ${childPid} remained alive`,
      );
    } finally {
      if (existsSync(harness.childPidPath)) {
        const childPid = Number.parseInt(readFileSync(harness.childPidPath, "utf8"), 10);
        if (processIsAlive(childPid)) process.kill(childPid, "SIGKILL");
      }
    }
  });

  test("times out client commands and removes descendants without exposing raw content", async (t) => {
    const harness = createHarness(t, emptyState(), {
      OPENWIKI_TEST_TIMEOUT_ON: "plugin marketplace list",
    });
    try {
      const result = harness.run(
        "install.mjs",
        ["--claude", "--json"],
        { timeout: 45_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.json.error.code, "CLIENT_TIMEOUT");
      assert.equal(Object.hasOwn(result.json.error, "stderr"), false);
      const childPid = Number.parseInt(readFileSync(harness.childPidPath, "utf8"), 10);
      assert.ok(Number.isInteger(childPid));
      assert.equal(
        await waitForProcessExit(childPid),
        true,
        `timed-out client descendant ${childPid} remained alive`,
      );
    } finally {
      if (existsSync(harness.childPidPath)) {
        const childPid = Number.parseInt(readFileSync(harness.childPidPath, "utf8"), 10);
        if (processIsAlive(childPid)) process.kill(childPid, "SIGKILL");
      }
    }
  });

  test("selects longer timeouts only for host mutations and copies", () => {
    for (const argv of [
      ["plugin", "add", PLUGIN_ID, "--json"],
      ["plugin", "install", PLUGIN_ID, "--scope", "user"],
      ["plugin", "remove", PLUGIN_ID, "--json"],
      ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"],
      ["plugin", "marketplace", "add", REPOSITORY_ROOT, "--json"],
      ["plugin", "marketplace", "remove", MARKETPLACE, "--json"],
    ]) {
      assert.equal(clientCommandTimeoutMs(argv), 90_000, argv.join(" "));
    }
    assert.equal(clientCommandTimeoutMs(["plugin", "list", "--json"]), 30_000);
    assert.equal(
      clientCommandTimeoutMs(["plugin", "marketplace", "list", "--json"]),
      30_000,
    );
  });

  test("polls delayed readiness with an explicit clock and policy", async () => {
    let now = 0;
    let reads = 0;
    const result = await pollInstalledRuntime(
      async () => ({ ready: ++reads === 3, missing: ["dist/mcp.js"] }),
      { timeoutMs: 50, pollMs: 5 },
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );
    assert.equal(result.ready, true);
    assert.equal(reads, 3);
    assert.equal(now, 10);
  });

  test("rejects malformed versions and install roots without polling", async (t) => {
    const runtime = createInstalledRuntime(t, "claude");
    for (const entry of [
      { ...runtime.entry, version: "../0.1.0" },
      { ...runtime.entry, installPath: "relative/cache" },
    ]) {
      const inspected = inspectInstalledRuntime("claude", [entry], runtime.roots);
      assert.equal(inspected.invalid, true);
      let sleeps = 0;
      await assert.rejects(
        pollInstalledRuntime(
          async () => inspected,
          { timeoutMs: 50, pollMs: 5 },
          { now: () => 0, sleep: async () => { sleeps += 1; } },
        ),
        (error) => error.code === "INSTALL_NOT_READY",
      );
      assert.equal(sleeps, 0);
    }
  });

  test("requires every runtime artifact referenced by each host manifest", (t) => {
    const required = {
      codex: [
        "bin/openwiki",
        "dist/cli.js",
        "dist/mcp.js",
        ".codex-plugin/plugin.json",
        ".codex-plugin/mcp.json",
        "skills/openwiki/SKILL.md",
      ],
      claude: [
        "bin/openwiki",
        "dist/cli.js",
        "dist/mcp.js",
        "dist/hook.js",
        ".claude-plugin/plugin.json",
        ".claude-plugin/mcp.json",
        "skills/openwiki/SKILL.md",
        "hooks/hooks.json",
      ],
    };
    for (const [client, artifacts] of Object.entries(required)) {
      const complete = createInstalledRuntime(t, client);
      assert.equal(
        inspectInstalledRuntime(client, [complete.entry], complete.roots).ready,
        true,
      );
      for (const artifact of artifacts) {
        const runtime = createInstalledRuntime(t, client, { missing: artifact });
        const inspected = inspectInstalledRuntime(client, [runtime.entry], runtime.roots);
        assert.equal(inspected.ready, false, `${client}:${artifact}`);
        assert.equal(inspected.invalid, false, `${client}:${artifact}`);
        assert.ok(inspected.missing.includes(artifact), `${client}:${artifact}`);
      }
    }
  });

  test("resolves standard host config directories when overrides are absent", (t) => {
    const home = mkdtempSync(join(tmpdir(), "openwiki default home "));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(resolveHostConfigRoot("codex", {}, home), join(home, ".codex"));
    assert.equal(resolveHostConfigRoot("claude", {}, home), join(home, ".claude"));
  });

  test("rejects runtime artifacts symlinked outside the installed cache", (t) => {
    const runtime = createInstalledRuntime(t, "claude", { symlink: "dist/mcp.js" });
    const inspected = inspectInstalledRuntime("claude", [runtime.entry], runtime.roots);
    assert.equal(inspected.ready, false);
    assert.equal(inspected.invalid, true);
    assert.ok(inspected.missing.includes("dist/mcp.js"));
  });

  test("rejects an installed version directory symlinked outside the host cache", (t) => {
    const runtime = createInstalledRuntime(t, "claude", { rootSymlink: true });
    const inspected = inspectInstalledRuntime("claude", [runtime.entry], runtime.roots);
    assert.equal(inspected.ready, false);
    assert.equal(inspected.invalid, true);
    assert.deepEqual(inspected.missing, ["install-root"]);
  });

  test("returns typed INSTALL_NOT_READY after the production readiness timeout", (t) => {
    const harness = createHarness(t, emptyState(), {
      OPENWIKI_TEST_NEVER_READY: "1",
    });
    const result = harness.run("install.mjs", ["--claude", "--json"], {
      timeout: 20_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.json.error.code, "INSTALL_NOT_READY");
    assert.equal(result.json.error.timeoutMs, 15_000);
    assert.equal(Object.hasOwn(result.json.error, "installPath"), false);
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
  test("accepts the built repository without self-reported findings", () => {
    const build = spawnSync(NPM_COMMAND, ["run", "build"], {
      cwd: PLUGIN_ROOT,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const result = spawnSync(
      process.execPath,
      [join(SCRIPT_DIR, "validate.mjs"), "--root", REPOSITORY_ROOT, "--json"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false, timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.summary, { errors: 0, warnings: 0 });
    assert.deepEqual(report.findings, []);
  });

  test("reports missing integration artifacts as structured findings instead of crashing", (t) => {
    const harness = createHarness(t);
    const missingRoot = mkdtempSync(join(tmpdir(), "openwiki missing integration "));
    t.after(() => rmSync(missingRoot, { recursive: true, force: true }));
    rmSync(missingRoot, { recursive: true, force: true });
    const result = harness.run("validate.mjs", ["--json", "--root", missingRoot]);

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
      "TODO\nCredential: sk-1234567890abcdefghijklmnopqrstuv\n",
    );
    writeFileSync(join(pluginRoot, "src/placeholder-tbd.md"), "TBD\n");
    writeFileSync(join(pluginRoot, "src/placeholder-fixme.md"), "FIXME\n");
    writeFileSync(join(pluginRoot, "src/placeholder-angle.md"), "<owner>\n");
    writeFileSync(join(pluginRoot, "src/placeholder-your.md"), "YOUR_TOKEN\n");
    writeFileSync(join(pluginRoot, "src/placeholder-local.md"), "Local developer\n");

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
    const placeholderPaths = new Set(
      result.json.findings
        .filter(({ code }) => code === "PLACEHOLDER")
        .map(({ path }) => path),
    );
    for (const expectedPath of [
      "plugins/openwiki/README.md",
      "plugins/openwiki/src/placeholder-tbd.md",
      "plugins/openwiki/src/placeholder-fixme.md",
      "plugins/openwiki/src/placeholder-angle.md",
      "plugins/openwiki/src/placeholder-your.md",
      "plugins/openwiki/src/placeholder-local.md",
    ]) {
      assert.ok(placeholderPaths.has(expectedPath), `Expected placeholder finding ${expectedPath}`);
    }
    assert.deepEqual(harness.readLog(), []);
  });
});
