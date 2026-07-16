#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_PLUGIN_ROOT, "../..");
const MARKETPLACE = "memex-local";
const PLUGIN = "memex";
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const REQUIRED_REPOSITORY_FILES = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
];

const REQUIRED_PLUGIN_FILES = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".mcp.json",
  ".claude-plugin/mcp.json",
  "hooks/hooks.json",
  "bin/memex",
  "bin/memex.cmd",
  "skills/memex/SKILL.md",
  "skills/memex-init/SKILL.md",
  "skills/memex-update/SKILL.md",
  "skills/memex-query/SKILL.md",
  "skills/memex-ingest/SKILL.md",
  "skills/memex-ops/SKILL.md",
  "src/cli.ts",
  "src/mcp.ts",
  "src/hook.ts",
  "package.json",
  "README.md",
  "SECURITY.md",
  "PRIVACY.md",
  "CHANGELOG.md",
];

const REQUIRED_ATTRIBUTION_FILES = [
  "LICENSE",
  "UPSTREAM.md",
  "UPSTREAM_LICENSE",
  "THIRD_PARTY_NOTICES.md",
];

const EXECUTABLE_FILES = [
  "bin/memex",
  "scripts/install.mjs",
  "scripts/uninstall.mjs",
  "scripts/validate.mjs",
];

const COMPONENT_PATH_FIELDS = new Set([
  "agents",
  "commands",
  "hooks",
  "lspServers",
  "mcpServers",
  "outputStyles",
  "skills",
]);

const SCANNABLE_EXTENSIONS = new Set([
  "",
  ".cmd",
  ".json",
  ".js",
  ".md",
  ".mjs",
  ".ts",
]);

function parseArguments(argv) {
  let json = false;
  let root = DEFAULT_REPOSITORY_ROOT;
  let rootSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new Error("Argument --json may only be provided once.");
      json = true;
    } else if (argument === "--root") {
      if (rootSeen) throw new Error("Argument --root may only be provided once.");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Argument --root needs a path.");
      root = resolve(value);
      rootSeen = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { json, root };
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function repositoryPath(root, path) {
  return join(root, path);
}

function pluginPath(pluginRoot, path) {
  return join(pluginRoot, path);
}

function createFinding(code, path, message, severity = "error") {
  return { code, severity, path, message };
}

function readJson(path, displayPath, findings, documents) {
  if (!exists(path)) return undefined;

  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    documents.set(path, value);
    return value;
  } catch (error) {
    findings.push(
      createFinding(
        "INVALID_JSON",
        displayPath,
        `Invalid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
      ),
    );
    return undefined;
  }
}

function walkFiles(root, excludedDirectories = new Set()) {
  if (!exists(root)) return [];
  const files = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) pending.push(path);
      } else {
        files.push(path);
      }
    }
  }

  return files.sort();
}

function validateRequiredFiles(repositoryRoot, pluginRoot, findings) {
  for (const path of REQUIRED_REPOSITORY_FILES) {
    if (!exists(repositoryPath(repositoryRoot, path))) {
      findings.push(createFinding("MISSING_FILE", path, "Required repository file is missing."));
    }
  }
  for (const path of REQUIRED_PLUGIN_FILES) {
    if (!exists(pluginPath(pluginRoot, path))) {
      findings.push(
        createFinding(
          "MISSING_FILE",
          `plugins/memex/${path}`,
          "Required plugin file is missing.",
        ),
      );
    }
  }
  for (const path of REQUIRED_ATTRIBUTION_FILES) {
    const absolutePath = pluginPath(pluginRoot, path);
    if (!exists(absolutePath) || statSync(absolutePath).size === 0) {
      findings.push(
        createFinding(
          "MISSING_ATTRIBUTION",
          `plugins/memex/${path}`,
          "Required license or upstream attribution is missing or empty.",
        ),
      );
    }
  }
}

function validateJsonFiles(repositoryRoot, pluginRoot, findings, documents) {
  const paths = [
    ...REQUIRED_REPOSITORY_FILES.map((path) => repositoryPath(repositoryRoot, path)),
    ...walkFiles(pluginRoot, new Set(["node_modules", ".git"]))
      .filter((path) => extname(path) === ".json"),
  ];
  for (const path of [...new Set(paths)].sort()) {
    const displayPath = relative(repositoryRoot, path);
    readJson(path, displayPath, findings, documents);
  }
}

function findMarketplacePlugin(document) {
  if (!document || typeof document !== "object" || !Array.isArray(document.plugins)) {
    return undefined;
  }
  return document.plugins.find(
    (entry) => entry && typeof entry === "object" && entry.name === PLUGIN,
  );
}

function validateMarketplaceDocuments(repositoryRoot, pluginRoot, documents, findings) {
  const codexPath = repositoryPath(repositoryRoot, ".agents/plugins/marketplace.json");
  const claudePath = repositoryPath(repositoryRoot, ".claude-plugin/marketplace.json");
  const expectedPluginRoot = resolve(pluginRoot);

  const codex = documents.get(codexPath);
  if (codex) {
    if (codex.name !== MARKETPLACE) {
      findings.push(
        createFinding(
          "INVALID_MARKETPLACE",
          ".agents/plugins/marketplace.json",
          `Marketplace name must be ${MARKETPLACE}.`,
        ),
      );
    }
    const entry = findMarketplacePlugin(codex);
    const sourcePath = entry?.source?.path;
    if (entry?.source?.source !== "local" || sourcePath !== "./plugins/memex") {
      findings.push(
        createFinding(
          "SOURCE_PATH_MISMATCH",
          ".agents/plugins/marketplace.json",
          "Codex Memex source must be local ./plugins/memex.",
        ),
      );
    }
    if (typeof sourcePath === "string") {
      const resolved = resolve(repositoryRoot, sourcePath);
      if (!isWithin(repositoryRoot, resolved)) {
        findings.push(
          createFinding(
            "PATH_OUTSIDE_ROOT",
            ".agents/plugins/marketplace.json",
            "Codex marketplace source escapes the repository root.",
          ),
        );
      } else if (resolved !== expectedPluginRoot) {
        findings.push(
          createFinding(
            "SOURCE_PATH_MISMATCH",
            ".agents/plugins/marketplace.json",
            "Codex marketplace source does not resolve to plugins/memex.",
          ),
        );
      }
    }
  }

  const claude = documents.get(claudePath);
  if (claude) {
    if (claude.name !== MARKETPLACE) {
      findings.push(
        createFinding(
          "INVALID_MARKETPLACE",
          ".claude-plugin/marketplace.json",
          `Marketplace name must be ${MARKETPLACE}.`,
        ),
      );
    }
    const entry = findMarketplacePlugin(claude);
    const sourcePath = entry?.source;
    if (sourcePath !== "./plugins/memex") {
      findings.push(
        createFinding(
          "SOURCE_PATH_MISMATCH",
          ".claude-plugin/marketplace.json",
          "Claude Memex source must be ./plugins/memex.",
        ),
      );
    }
    if (typeof sourcePath === "string") {
      const resolved = resolve(repositoryRoot, sourcePath);
      if (!isWithin(repositoryRoot, resolved)) {
        findings.push(
          createFinding(
            "PATH_OUTSIDE_ROOT",
            ".claude-plugin/marketplace.json",
            "Claude marketplace source escapes the repository root.",
          ),
        );
      } else if (resolved !== expectedPluginRoot) {
        findings.push(
          createFinding(
            "SOURCE_PATH_MISMATCH",
            ".claude-plugin/marketplace.json",
            "Claude marketplace source does not resolve to plugins/memex.",
          ),
        );
      }
    }
  }
}

function componentPaths(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  return [];
}

function validateComponentPath(value, displayPath, pluginRoot, findings) {
  if (value.startsWith("${CLAUDE_PLUGIN_ROOT}/")) {
    value = `./${value.slice("${CLAUDE_PLUGIN_ROOT}/".length)}`;
  }

  if (isAbsolute(value) || value === ".." || value.startsWith("../")) {
    findings.push(
      createFinding(
        "PATH_OUTSIDE_ROOT",
        displayPath,
        `Component path must stay inside the plugin: ${value}`,
      ),
    );
    return;
  }
  if (!value.startsWith("./") && value !== ".") {
    findings.push(
      createFinding(
        "INVALID_COMPONENT_PATH",
        displayPath,
        `Component path must be plugin-relative and start with ./: ${value}`,
      ),
    );
    return;
  }

  const resolved = resolve(pluginRoot, value);
  if (!isWithin(pluginRoot, resolved)) {
    findings.push(
      createFinding(
        "PATH_OUTSIDE_ROOT",
        displayPath,
        `Component path escapes the plugin root: ${value}`,
      ),
    );
  }
}

function visitComponentFields(value, displayPath, pluginRoot, findings) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (COMPONENT_PATH_FIELDS.has(key)) {
      for (const path of componentPaths(child)) {
        validateComponentPath(path, displayPath, pluginRoot, findings);
      }
    }
    if (key === "args" && Array.isArray(child)) {
      for (const argument of child) {
        if (
          typeof argument === "string" &&
          (argument.startsWith("./") ||
            argument.startsWith("../") ||
            argument.startsWith("${CLAUDE_PLUGIN_ROOT}/") ||
            isAbsolute(argument))
        ) {
          validateComponentPath(argument, displayPath, pluginRoot, findings);
        }
      }
    }
    visitComponentFields(child, displayPath, pluginRoot, findings);
  }
}

function validatePluginDocuments(repositoryRoot, pluginRoot, documents, findings) {
  for (const relativePath of [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    ".claude-plugin/mcp.json",
    "hooks/hooks.json",
  ]) {
    const absolutePath = pluginPath(pluginRoot, relativePath);
    const document = documents.get(absolutePath);
    if (!document) continue;
    if (relativePath.endsWith("plugin.json") && document.name !== PLUGIN) {
      findings.push(
        createFinding(
          "INVALID_MANIFEST",
          relative(repositoryRoot, absolutePath),
          `Plugin name must be ${PLUGIN}.`,
        ),
      );
    }
    visitComponentFields(document, relative(repositoryRoot, absolutePath), pluginRoot, findings);
  }
}

function validateSymlinks(repositoryRoot, pluginRoot, findings) {
  for (const path of walkFiles(pluginRoot, new Set(["node_modules", ".git"]))) {
    const info = lstatSync(path);
    if (!info.isSymbolicLink()) continue;
    try {
      const target = realpathSync.native(path);
      if (!isWithin(pluginRoot, target)) {
        findings.push(
          createFinding(
            "PATH_OUTSIDE_ROOT",
            relative(repositoryRoot, path),
            "Symlink resolves outside the plugin root.",
          ),
        );
      }
    } catch {
      findings.push(
        createFinding(
          "BROKEN_SYMLINK",
          relative(repositoryRoot, path),
          "Symlink target cannot be resolved.",
        ),
      );
    }
  }
}

function validateExecutables(repositoryRoot, pluginRoot, findings) {
  if (process.platform === "win32") return;
  for (const relativePath of EXECUTABLE_FILES) {
    const path = pluginPath(pluginRoot, relativePath);
    if (!exists(path)) continue;
    if ((statSync(path).mode & 0o111) === 0) {
      findings.push(
        createFinding(
          "NOT_EXECUTABLE",
          relative(repositoryRoot, path),
          "Executable script has no executable mode bit.",
        ),
      );
    }
  }
}

function sourceFiles(pluginRoot) {
  const sourceRoot = pluginPath(pluginRoot, "src");
  return walkFiles(sourceRoot).filter((path) => path.endsWith(".ts"));
}

function isTracked(repositoryRoot, path) {
  const result = spawnSync(
    "git",
    ["-C", repositoryRoot, "ls-files", "--error-unmatch", "--", relative(repositoryRoot, path)],
    { encoding: "utf8", shell: false, timeout: 5_000 },
  );
  return result.status === 0;
}

function validateDist(repositoryRoot, pluginRoot, findings) {
  for (const source of sourceFiles(pluginRoot)) {
    const sourceRelative = relative(pluginPath(pluginRoot, "src"), source).replace(/\.ts$/u, "");
    for (const extension of [".js", ".d.ts"]) {
      const dist = pluginPath(pluginRoot, `dist/${sourceRelative}${extension}`);
      const displayPath = relative(repositoryRoot, dist);
      if (!exists(dist)) {
        findings.push(
          createFinding(
            "MISSING_DIST",
            displayPath,
            `Compiled artifact is missing for ${relative(repositoryRoot, source)}.`,
          ),
        );
        continue;
      }
      if (statSync(source).mtimeMs > statSync(dist).mtimeMs + 1_000) {
        findings.push(
          createFinding(
            "STALE_DIST",
            displayPath,
            `Compiled artifact is older than ${relative(repositoryRoot, source)}.`,
          ),
        );
      }
      if (isWithin(repositoryRoot, dist) && !isTracked(repositoryRoot, dist)) {
        findings.push(
          createFinding(
            "DIST_NOT_COMMITTED",
            displayPath,
            "Compiled artifact is not committed to the repository.",
          ),
        );
      }
    }
  }
}

function placeholderPatterns() {
  const markerWords = [
    ["TO", "DO"],
    ["T", "BD"],
    ["FI", "XME"],
  ].map((parts) => parts.join(""));
  const yourPrefix = ["YOUR", "_"].join("");
  const localDeveloper = ["Local", " developer"].join("");
  const angleMarkers = ["owner", "package", "placeholder", "publisher"].join("|");

  return [
    new RegExp(`\\b(?:${markerWords.join("|")})\\b`, "iu"),
    new RegExp(`<(?:${angleMarkers}|your[-_ ][^>]*)>`, "iu"),
    new RegExp(`\\b${yourPrefix}[A-Z0-9_]+\\b`, "u"),
    new RegExp(`\\b${localDeveloper}\\b`, "iu"),
  ];
}

function secretPatterns() {
  return [
    new RegExp(`sk-${"[A-Za-z0-9]"}{24,}`, "u"),
    new RegExp(`gh${"[pousr]"}_${"[A-Za-z0-9]"}{30,}`, "u"),
    new RegExp(`AKIA${"[0-9A-Z]"}{16}`, "u"),
    new RegExp(`${"-----BEGIN "}(?:RSA |EC |OPENSSH )?${"PRIVATE KEY-----"}`, "u"),
    new RegExp(`Bearer ${"[A-Za-z0-9._-]"}{24,}`, "iu"),
  ];
}

function scanTextFile(repositoryRoot, path, findings) {
  const info = statSync(path);
  if (info.size > MAX_SCAN_BYTES || !SCANNABLE_EXTENSIONS.has(extname(path))) return;

  const content = readFileSync(path, "utf8");
  const displayPath = relative(repositoryRoot, path);
  if (placeholderPatterns().some((pattern) => pattern.test(content))) {
    findings.push(
      createFinding("PLACEHOLDER", displayPath, "Unresolved placeholder marker found."),
    );
  }
  if (secretPatterns().some((pattern) => pattern.test(content))) {
    findings.push(
      createFinding("LIKELY_SECRET", displayPath, "Likely credential or private key found."),
    );
  }
}

function validateText(repositoryRoot, pluginRoot, findings) {
  const paths = [
    ...REQUIRED_REPOSITORY_FILES.map((path) => repositoryPath(repositoryRoot, path)),
    ...walkFiles(pluginRoot, new Set(["node_modules", ".git", "tests"])),
  ];
  for (const path of [...new Set(paths)].sort()) {
    if (!exists(path) || lstatSync(path).isSymbolicLink()) continue;
    scanTextFile(repositoryRoot, path, findings);
  }
}

function validateAttribution(repositoryRoot, pluginRoot, findings) {
  const upstreamPath = pluginPath(pluginRoot, "UPSTREAM.md");
  if (exists(upstreamPath)) {
    const content = readFileSync(upstreamPath, "utf8");
    // The pinned upstream project is `langchain-ai/openwiki`: a real,
    // immutable third-party provenance fact that does not follow this
    // plugin's own name (this plugin is independently named `memex`).
    if (!/langchain-ai\/openwiki/iu.test(content) || !/\b[0-9a-f]{40}\b/iu.test(content)) {
      findings.push(
        createFinding(
          "INVALID_ATTRIBUTION",
          relative(repositoryRoot, upstreamPath),
          "UPSTREAM.md must identify langchain-ai/openwiki and a pinned 40-character commit.",
        ),
      );
    }
  }

  const noticesPath = pluginPath(pluginRoot, "THIRD_PARTY_NOTICES.md");
  if (exists(noticesPath)) {
    const content = readFileSync(noticesPath, "utf8");
    if (!/Memex/iu.test(content) || !/MIT/iu.test(content)) {
      findings.push(
        createFinding(
          "INVALID_ATTRIBUTION",
          relative(repositoryRoot, noticesPath),
          "Third-party notices must identify Memex and its MIT license.",
        ),
      );
    }
  }
}

function render(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  for (const finding of result.findings) {
    process.stdout.write(
      `${finding.severity.toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}\n`,
    );
  }
  process.stdout.write(
    `Validation ${result.ok ? "passed" : "failed"}: ${String(result.summary.errors)} errors, ${String(result.summary.warnings)} warnings.\n`,
  );
}

function validateRepository(repositoryRoot) {
  const pluginRoot = pluginPath(repositoryRoot, "plugins/memex");
  const findings = [];
  const documents = new Map();

  validateRequiredFiles(repositoryRoot, pluginRoot, findings);
  validateJsonFiles(repositoryRoot, pluginRoot, findings, documents);
  validateMarketplaceDocuments(repositoryRoot, pluginRoot, documents, findings);
  validatePluginDocuments(repositoryRoot, pluginRoot, documents, findings);
  validateSymlinks(repositoryRoot, pluginRoot, findings);
  validateExecutables(repositoryRoot, pluginRoot, findings);
  validateDist(repositoryRoot, pluginRoot, findings);
  validateText(repositoryRoot, pluginRoot, findings);
  validateAttribution(repositoryRoot, pluginRoot, findings);

  findings.sort((left, right) => {
    const severity = left.severity.localeCompare(right.severity);
    if (severity !== 0) return severity;
    const path = left.path.localeCompare(right.path);
    return path !== 0 ? path : left.code.localeCompare(right.code);
  });
  const errors = findings.filter(({ severity }) => severity === "error").length;
  const warnings = findings.length - errors;

  return {
    ok: errors === 0,
    action: "validate",
    root: repositoryRoot,
    summary: { errors, warnings },
    findings,
  };
}

export function runValidatorCli(argv = process.argv.slice(2)) {
  const jsonRequested = argv.includes("--json");
  try {
    const options = parseArguments(argv);
    const result = validateRepository(options.root);
    render(result, options.json);
    return result.ok ? 0 : 1;
  } catch (error) {
    const result = {
      ok: false,
      action: "validate",
      summary: { errors: 1, warnings: 0 },
      findings: [
        createFinding(
          "INVALID_ARGUMENT",
          ".",
          error instanceof Error ? error.message : "Unexpected validation failure.",
        ),
      ],
    };
    render(result, jsonRequested);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runValidatorCli();
}
