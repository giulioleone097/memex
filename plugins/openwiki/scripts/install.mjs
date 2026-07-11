#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "../..");
const MARKETPLACE = "openwiki-local";
const PLUGIN = "openwiki";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
const CLIENT_TIMEOUT_MS = 30_000;
const CLIENT_MAX_BUFFER_BYTES = 1024 * 1024;

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

function runClient(client, argv, commands) {
  const result = spawnSync(client, argv, {
    encoding: "utf8",
    maxBuffer: CLIENT_MAX_BUFFER_BYTES,
    shell: false,
    timeout: CLIENT_TIMEOUT_MS,
  });

  commands.push({
    client,
    argv,
    status: "executed",
    exitCode: result.status,
  });

  if (result.error) {
    const code = result.error.code === "ENOENT" ? "CLIENT_UNAVAILABLE" : "CLIENT_FAILURE";
    throw new LifecycleError(code, `${client} could not be executed.`, { client, argv });
  }
  if (result.status !== 0) {
    throw new LifecycleError(
      "CLIENT_COMMAND_FAILED",
      `${client} exited with status ${String(result.status)}.`,
      { client, argv, status: result.status },
    );
  }

  return result.stdout;
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
    const value = parseClientJson(client, argv, runClient(client, argv, commands));
    const entries = marketplaceEntries(client, value);
    marketplaceState.set(client, inspectMarketplace(client, entries));
  }

  for (const client of options.clients) {
    const state = marketplaceState.get(client);
    const command = COMMANDS[action][client];

    if (action === "install") {
      if (!state.exists) runClient(client, command.marketplaceMutation, commands);
      const value = parseClientJson(
        client,
        command.pluginList,
        runClient(client, command.pluginList, commands),
      );
      if (!installedEntries(client, value).some(isPluginInstalled)) {
        runClient(client, command.pluginMutation, commands);
      }
    } else if (state.exists) {
      const value = parseClientJson(
        client,
        command.pluginList,
        runClient(client, command.pluginList, commands),
      );
      if (installedEntries(client, value).some(isPluginInstalled)) {
        runClient(client, command.pluginMutation, commands);
      }
      runClient(client, command.marketplaceMutation, commands);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLifecycleCli("install");
}
