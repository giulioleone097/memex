import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
const SCRIPT_ROOT = join(PLUGIN_ROOT, "scripts");
const FIXTURE_BIN = join(PLUGIN_ROOT, "tests/fixtures/client-bin");
const PLUGIN_ID = "openwiki@openwiki-local";
const LIVE_SMOKE_ENABLED = process.env.OPENWIKI_RUN_CLIENT_SMOKE === "1";

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
    timeout: 30_000,
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
  const statePath = join(root, "client-state.json");
  const logPath = join(root, "client-argv.jsonl");
  writeFileSync(statePath, `${JSON.stringify(emptyClientState(), null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env = {
    ...process.env,
    PATH: `${FIXTURE_BIN}${delimiter}${process.env.PATH ?? ""}`,
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
  delete env.OPENWIKI_TEST_LOG;
  delete env.OPENWIKI_TEST_STATE;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env };
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

describe("OpenWiki plugin clients", () => {
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
        { cwd: live.root, env: live.env },
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
        { cwd: live.root, env: live.env },
      );
      assert.equal(install.status, 0, install.stderr || install.stdout);
      assert.equal(parseJson(install.stdout, "live Claude install").ok, true);

      const list = run("claude", ["plugin", "list", "--json"], {
        cwd: live.root,
        env: live.env,
      });
      assert.equal(list.status, 0, list.stderr || list.stdout);
      assert.match(list.stdout, /openwiki/u);

      const uninstall = run(
        process.execPath,
        [join(SCRIPT_ROOT, "uninstall.mjs"), "--claude", "--json"],
        { cwd: live.root, env: live.env },
      );
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
      assert.equal(parseJson(uninstall.stdout, "live Claude uninstall").ok, true);
    },
  );
});
