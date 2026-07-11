#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "../..");
const MARKETPLACE = "openwiki-local";
const PLUGIN = "openwiki";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
const CLIENT_TIMEOUT_MS = 30_000;
const CLIENT_MUTATION_TIMEOUT_MS = 90_000;
const CLIENT_MAX_BUFFER_BYTES = 1024 * 1024;
const CLIENT_KILL_GRACE_MS = 250;
export const DEFAULT_READINESS_POLICY = Object.freeze({
  timeoutMs: 15_000,
  pollMs: 100,
});
const SYSTEM_READINESS_CLOCK = Object.freeze({
  now: () => Date.now(),
  sleep: (milliseconds) => delay(milliseconds),
});

const COMMANDS = {
  install: {
    codex: {
      marketplaceList: ["plugin", "marketplace", "list", "--json"],
      marketplaceMutation: [
        "plugin",
        "marketplace",
        "add",
        REPOSITORY_ROOT,
        "--json",
      ],
      pluginList: ["plugin", "list", "--json"],
      pluginMutation: ["plugin", "add", PLUGIN_ID, "--json"],
    },
    claude: {
      marketplaceList: ["plugin", "marketplace", "list", "--json"],
      marketplaceMutation: [
        "plugin",
        "marketplace",
        "add",
        REPOSITORY_ROOT,
        "--scope",
        "user",
      ],
      pluginList: ["plugin", "list", "--json"],
      pluginMutation: ["plugin", "install", PLUGIN_ID, "--scope", "user"],
    },
  },
  uninstall: {
    codex: {
      marketplaceList: ["plugin", "marketplace", "list", "--json"],
      pluginList: ["plugin", "list", "--json"],
      pluginMutation: ["plugin", "remove", PLUGIN_ID, "--json"],
      marketplaceMutation: [
        "plugin",
        "marketplace",
        "remove",
        MARKETPLACE,
        "--json",
      ],
    },
    claude: {
      marketplaceList: ["plugin", "marketplace", "list", "--json"],
      pluginList: ["plugin", "list", "--json"],
      pluginMutation: ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"],
      marketplaceMutation: [
        "plugin",
        "marketplace",
        "remove",
        MARKETPLACE,
        "--scope",
        "user",
      ],
    },
  },
};

export function clientCommandTimeoutMs(argv) {
  const mutation =
    argv[0] === "plugin" &&
    (["add", "install", "remove", "uninstall"].includes(argv[1]) ||
      (argv[1] === "marketplace" && ["add", "remove"].includes(argv[2])));
  return mutation ? CLIENT_MUTATION_TIMEOUT_MS : CLIENT_TIMEOUT_MS;
}

class LifecycleError extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const targets = [];
  let dryRun = false;
  let json = false;
  const seen = new Set();

  for (const argument of argv) {
    if (seen.has(argument)) {
      throw new LifecycleError(
        "INVALID_ARGUMENT",
        `Argument ${argument} may only be provided once.`,
        {},
        2,
      );
    }
    seen.add(argument);

    if (argument === "--codex") targets.push("codex");
    else if (argument === "--claude") targets.push("claude");
    else if (argument === "--all") targets.push("all");
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--json") json = true;
    else {
      throw new LifecycleError(
        "INVALID_ARGUMENT",
        `Unknown argument: ${argument}`,
        {},
        2,
      );
    }
  }

  if (targets.length !== 1) {
    throw new LifecycleError(
      "INVALID_ARGUMENT",
      "Select exactly one target: --codex, --claude, or --all.",
      {},
      2,
    );
  }

  return {
    clients: targets[0] === "all" ? ["codex", "claude"] : targets,
    dryRun,
    json,
  };
}

function createPlan(action, clients) {
  const commands = [];

  for (const client of clients) {
    commands.push({ client, argv: COMMANDS[action][client].marketplaceList });
  }
  for (const client of clients) {
    const command = COMMANDS[action][client];
    if (action === "install") {
      commands.push({ client, argv: command.marketplaceMutation });
      commands.push({ client, argv: command.pluginList });
      commands.push({ client, argv: command.pluginMutation });
    } else {
      commands.push({ client, argv: command.pluginList });
      commands.push({ client, argv: command.pluginMutation });
      commands.push({ client, argv: command.marketplaceMutation });
    }
  }

  return commands;
}

function signalProcessGroup(pid, signal) {
  if (process.platform === "win32") return;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signalChildFallback(child) {
  try {
    return {
      action: child.kill("SIGTERM") ? "child-signal" : "none",
      cause: null,
    };
  } catch (error) {
    return { action: "none", cause: error.code ?? null };
  }
}

function terminationFailure(client, argv, cause, fallback) {
  return {
    ok: false,
    error: new LifecycleError(
      "CLIENT_TEARDOWN_FAILED",
      `Could not terminate the ${client} process tree.`,
      { client, argv, cause, ...fallback },
    ),
  };
}

async function terminateProcessTree(child, client, argv) {
  if (typeof child?.pid !== "number") return { ok: true };

  if (process.platform === "win32") {
    return new Promise((resolveTermination) => {
      try {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.once("error", (error) => {
          const fallback = signalChildFallback(child);
          resolveTermination(
            terminationFailure(client, argv, error.code ?? null, fallback),
          );
        });
        killer.once("close", (status) => {
          if (status === 0) {
            resolveTermination({ ok: true });
            return;
          }
          const fallback = signalChildFallback(child);
          resolveTermination(
            terminationFailure(
              client,
              argv,
              `taskkill exited with status ${String(status)}`,
              fallback,
            ),
          );
        });
      } catch (error) {
        const fallback = signalChildFallback(child);
        resolveTermination(
          terminationFailure(client, argv, error.code ?? null, fallback),
        );
      }
    });
  }

  try {
    if (!signalProcessGroup(child.pid, "SIGTERM")) return { ok: true };
  } catch (error) {
    const fallback = signalChildFallback(child);
    return terminationFailure(
      client,
      argv,
      error.code ?? null,
      fallback,
    );
  }

  return new Promise((resolveTermination) => {
    setTimeout(() => {
      try {
        signalProcessGroup(child.pid, "SIGKILL");
        resolveTermination({ ok: true });
      } catch (error) {
        resolveTermination(
          terminationFailure(client, argv, error.code ?? null, { action: "none", cause: null }),
        );
      }
    }, CLIENT_KILL_GRACE_MS);
  });
}

function readCapturedOutput(path, client, argv, stream) {
  const bytes = statSync(path).size;
  if (bytes > CLIENT_MAX_BUFFER_BYTES) {
    throw new LifecycleError(
      "CLIENT_OUTPUT_TOO_LARGE",
      `${client} wrote more than the allowed ${String(CLIENT_MAX_BUFFER_BYTES)} bytes to ${stream}.`,
      { client, argv, stream, bytes, maxBuffer: CLIENT_MAX_BUFFER_BYTES },
    );
  }
  return readFileSync(path, "utf8");
}

function cleanupCapture(outputRoot, client, argv) {
  try {
    rmSync(outputRoot, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return new LifecycleError(
      "CLIENT_CAPTURE_CLEANUP_FAILED",
      "Could not remove isolated client output files.",
      { client, argv, cause: error.code ?? null },
    );
  }
}

async function runClient(client, argv, commands) {
  const timeoutMs = clientCommandTimeoutMs(argv);
  const outputRoot = mkdtempSync(join(tmpdir(), "openwiki client output "));
  const stdoutPath = join(outputRoot, "stdout");
  const stderrPath = join(outputRoot, "stderr");
  let stdoutFd;
  let stderrFd;

  try {
    stdoutFd = openSync(stdoutPath, "w", 0o600);
    stderrFd = openSync(stderrPath, "w", 0o600);
    chmodSync(stdoutPath, 0o600);
    chmodSync(stderrPath, 0o600);
  } catch (error) {
    if (typeof stdoutFd === "number") closeSync(stdoutFd);
    if (typeof stderrFd === "number") closeSync(stderrFd);
    const cleanupError = cleanupCapture(outputRoot, client, argv);
    if (cleanupError) throw cleanupError;
    throw new LifecycleError(
      "CLIENT_CAPTURE_FAILED",
      "Could not create isolated client output files.",
      { client, argv, cause: error.code ?? null },
    );
  }

  let result;
  try {
    result = spawnSync(client, argv, {
      detached: process.platform !== "win32",
      killSignal: "SIGKILL",
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    const cleanupError = cleanupCapture(outputRoot, client, argv);
    if (cleanupError) throw cleanupError;
    throw new LifecycleError(
      error.code === "ENOENT" ? "CLIENT_UNAVAILABLE" : "CLIENT_FAILURE",
      `${client} could not be executed.`,
      { client, argv, cause: error.code ?? null },
    );
  }
  closeSync(stdoutFd);
  closeSync(stderrFd);

  const pid = Number.isInteger(result.pid) && result.pid > 0 ? result.pid : undefined;
  const child = {
    pid,
    kill(signal) {
      if (typeof pid !== "number") return false;
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
  };
  commands.push({
    client,
    argv,
    status: "executed",
    exitCode: result.status,
  });

  let teardown =
    result.error || result.status !== 0
      ? await terminateProcessTree(child, client, argv)
      : { ok: true };
  let stdout = "";
  let stderr = "";
  let outputError;
  try {
    stdout = readCapturedOutput(stdoutPath, client, argv, "stdout");
    stderr = readCapturedOutput(stderrPath, client, argv, "stderr");
  } catch (error) {
    outputError = error;
  }
  if (outputError && teardown.ok) {
    teardown = await terminateProcessTree(child, client, argv);
  }
  const cleanupError = cleanupCapture(outputRoot, client, argv);

  if (!teardown.ok) throw teardown.error;
  if (cleanupError) throw cleanupError;
  if (result.error?.code === "ETIMEDOUT") {
    throw new LifecycleError(
      "CLIENT_TIMEOUT",
      client + " did not exit within " + String(timeoutMs) + "ms.",
      { client, argv, timeoutMs, stderrBytes: Buffer.byteLength(stderr) },
    );
  }
  if (result.error) {
    const code = result.error.code === "ENOENT" ? "CLIENT_UNAVAILABLE" : "CLIENT_FAILURE";
    throw new LifecycleError(code, client + " could not be executed.", {
      client,
      argv,
      cause: result.error.code ?? null,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
  if (outputError) throw outputError;
  if (result.status !== 0) {
    throw new LifecycleError(
      "CLIENT_COMMAND_FAILED",
      client + " exited with status " + String(result.status) + ".",
      {
        client,
        argv,
        status: result.status,
        signal: result.signal,
        stderrBytes: Buffer.byteLength(stderr),
      },
    );
  }
  return stdout;
}

function parseClientJson(client, argv, stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new LifecycleError(
      "INVALID_CLIENT_OUTPUT",
      `${client} returned invalid JSON for a read-only state query.`,
      { client, argv },
    );
  }
}

function marketplaceEntries(client, value) {
  const entries = client === "codex" ? value?.marketplaces : value;
  if (!Array.isArray(entries)) {
    throw new LifecycleError(
      "INVALID_CLIENT_OUTPUT",
      `${client} marketplace list did not return an array.`,
      { client },
    );
  }
  return entries;
}

function installedEntries(client, value) {
  const entries = client === "codex" ? value?.installed : value;
  if (!Array.isArray(entries)) {
    throw new LifecycleError(
      "INVALID_CLIENT_OUTPUT",
      `${client} plugin list did not return an array.`,
      { client },
    );
  }
  return entries;
}

function canonicalPath(value) {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function marketplaceSource(client, entry) {
  if (!entry || typeof entry !== "object") return undefined;
  if (client === "codex") {
    return entry.marketplaceSource?.source ?? entry.root;
  }
  return entry.path ?? (entry.source === "directory" ? entry.installLocation : undefined);
}

function inspectMarketplace(client, entries) {
  const matches = entries.filter(
    (entry) => entry && typeof entry === "object" && entry.name === MARKETPLACE,
  );
  if (matches.length === 0) return { exists: false };

  const expectedSource = canonicalPath(REPOSITORY_ROOT);
  for (const entry of matches) {
    const source = marketplaceSource(client, entry);
    const actualSource = typeof source === "string" ? canonicalPath(source) : undefined;
    if (actualSource !== expectedSource) {
      throw new LifecycleError(
        "MARKETPLACE_COLLISION",
        `${MARKETPLACE} already belongs to a different ${client} source.`,
        {
          client,
          expectedSource,
          actualSource: source ?? null,
        },
      );
    }
  }

  return { exists: true };
}

function isPluginInstalled(entry) {
  if (typeof entry === "string") return entry === PLUGIN_ID;
  if (!entry || typeof entry !== "object") return false;
  if (entry.pluginId === PLUGIN_ID || entry.id === PLUGIN_ID) return true;
  const marketplaceName = entry.marketplaceName ?? entry.marketplace;
  return entry.name === PLUGIN && marketplaceName === MARKETPLACE;
}

function safeVersion(entry) {
  const version = entry.version;
  return typeof version === "string" &&
    version !== "." &&
    version !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(version)
    ? version
    : undefined;
}

export function resolveHostConfigRoot(
  client,
  environment = process.env,
  home = homedir(),
) {
  return client === "codex"
    ? environment.CODEX_HOME ?? join(home, ".codex")
    : environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
}

function canonicalHostPath(value, configRoot) {
  const lexicalConfigRoot = resolve(configRoot);
  const lexicalValue = resolve(value);
  const rel = relative(lexicalConfigRoot, lexicalValue);
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) {
    return canonicalPath(join(canonicalPath(lexicalConfigRoot), rel));
  }
  return canonicalPath(lexicalValue);
}

function installRoot(client, entry, roots = {}) {
  const version = safeVersion(entry);
  if (!version) return undefined;
  const configRoot =
    client === "codex"
      ? roots.codexHome ?? resolveHostConfigRoot(client)
      : roots.claudeConfigDir ??
        resolveHostConfigRoot(client);
  const cacheRoot = join(
    canonicalPath(configRoot),
    "plugins",
    "cache",
    MARKETPLACE,
    PLUGIN,
  );
  const expected = join(cacheRoot, version);
  const canonicalExpected = canonicalPath(expected);
  if (relative(canonicalPath(cacheRoot), canonicalExpected) !== version) {
    return undefined;
  }
  if (
    client === "claude" &&
    (typeof entry.installPath !== "string" ||
      canonicalHostPath(entry.installPath, configRoot) !== canonicalExpected)
  ) {
    return undefined;
  }
  return canonicalExpected;
}

function runtimeArtifacts(client) {
  const artifacts = [
    "bin/openwiki",
    "dist/cli.js",
    "dist/mcp.js",
    client === "codex"
      ? ".codex-plugin/plugin.json"
      : ".claude-plugin/plugin.json",
    client === "codex" ? ".codex-plugin/mcp.json" : ".claude-plugin/mcp.json",
    "skills/openwiki/SKILL.md",
  ];
  if (client === "claude") artifacts.push("hooks/hooks.json", "dist/hook.js");
  return artifacts;
}

export function inspectInstalledRuntime(client, entries, roots = {}) {
  const entry = entries.find(isPluginInstalled);
  if (!entry) return { ready: false, missing: ["installed-entry"] };
  const root = installRoot(client, entry, roots);
  if (!root) return { ready: false, invalid: true, missing: ["install-root"] };
  const missing = runtimeArtifacts(client).filter((artifact) => {
    try {
      const path = join(root, artifact);
      if (!existsSync(path)) return true;
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) return true;
      const resolved = realpathSync.native(path);
      const rel = relative(canonicalPath(root), resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(resolved) !== resolved) return true;
      return (
        artifact === "bin/openwiki" &&
        process.platform !== "win32" &&
        (entry.mode & 0o111) === 0
      );
    } catch {
      return true;
    }
  });
  const invalid = runtimeArtifacts(client).some((artifact) => {
    try {
      return lstatSync(join(root, artifact)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  return { ready: missing.length === 0, invalid, missing };
}

export async function pollInstalledRuntime(
  read,
  policy = DEFAULT_READINESS_POLICY,
  clock = SYSTEM_READINESS_CLOCK,
) {
  const deadline = clock.now() + policy.timeoutMs;
  let readiness = { ready: false, missing: ["installed-entry"] };
  do {
    readiness = await read();
    if (readiness.ready) return readiness;
    if (readiness.invalid) break;
    await clock.sleep(policy.pollMs);
  } while (clock.now() < deadline);
  throw new LifecycleError(
    "INSTALL_NOT_READY",
    "The installed OpenWiki runtime did not become ready in time.",
    { timeoutMs: policy.timeoutMs, missing: readiness.missing },
  );
}

async function waitForInstalledRuntime(client, argv, commands) {
  try {
    await pollInstalledRuntime(async () => {
      const value = parseClientJson(
        client,
        argv,
        await runClient(client, argv, commands),
      );
      return inspectInstalledRuntime(client, installedEntries(client, value));
    });
  } catch (error) {
    if (!(error instanceof LifecycleError) || error.code !== "INSTALL_NOT_READY") {
      throw error;
    }
    throw new LifecycleError(
      error.code,
      `${client} did not expose a complete installed OpenWiki runtime in time.`,
      { client, argv, ...error.details },
    );
  }
}

function render(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.ok) {
    const verb = result.dryRun ? "planned" : "completed";
    process.stdout.write(
      `${result.action} ${verb} for ${result.clients.join(", ")} (${String(result.commands.length)} commands).\n`,
    );
  } else {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }
}

async function execute(action, options) {
  const commands = [];
  if (options.dryRun) {
    return {
      ok: true,
      action,
      dryRun: true,
      marketplace: MARKETPLACE,
      plugin: PLUGIN,
      clients: options.clients,
      commands: createPlan(action, options.clients).map((command) => ({
        ...command,
        status: "planned",
      })),
    };
  }

  const marketplaceState = new Map();
  for (const client of options.clients) {
    const argv = COMMANDS[action][client].marketplaceList;
    const value = parseClientJson(client, argv, await runClient(client, argv, commands));
    const entries = marketplaceEntries(client, value);
    marketplaceState.set(client, inspectMarketplace(client, entries));
  }

  for (const client of options.clients) {
    const state = marketplaceState.get(client);
    const command = COMMANDS[action][client];

    if (action === "install") {
      if (!state.exists) await runClient(client, command.marketplaceMutation, commands);
      const value = parseClientJson(
        client,
        command.pluginList,
        await runClient(client, command.pluginList, commands),
      );
      if (!installedEntries(client, value).some(isPluginInstalled)) {
        await runClient(client, command.pluginMutation, commands);
      }
      await waitForInstalledRuntime(client, command.pluginList, commands);
    } else if (state.exists) {
      const value = parseClientJson(
        client,
        command.pluginList,
        await runClient(client, command.pluginList, commands),
      );
      if (installedEntries(client, value).some(isPluginInstalled)) {
        await runClient(client, command.pluginMutation, commands);
      }
      await runClient(client, command.marketplaceMutation, commands);
    }
  }

  return {
    ok: true,
    action,
    dryRun: false,
    marketplace: MARKETPLACE,
    plugin: PLUGIN,
    clients: options.clients,
    commands,
  };
}

export async function runLifecycleCli(action, argv = process.argv.slice(2)) {
  const jsonRequested = argv.includes("--json");
  let commands = [];

  try {
    if (action !== "install" && action !== "uninstall") {
      throw new LifecycleError("INVALID_ARGUMENT", `Unsupported action: ${action}`, {}, 2);
    }
    const options = parseArguments(argv);
    const result = await execute(action, options);
    commands = result.commands;
    render(result, options.json);
    return 0;
  } catch (error) {
    const lifecycleError =
      error instanceof LifecycleError
        ? error
        : new LifecycleError("INTERNAL_ERROR", "Unexpected lifecycle failure.");
    const result = {
      ok: false,
      action,
      error: {
        code: lifecycleError.code,
        message: lifecycleError.message,
        ...lifecycleError.details,
      },
      commands,
    };
    render(result, jsonRequested);
    return lifecycleError.exitCode;
  }
}

if (
  process.argv[1] &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runLifecycleCli("install");
}
