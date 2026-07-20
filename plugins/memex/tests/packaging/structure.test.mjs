import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "../..");
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, "../..");
const UPSTREAM_COMMIT = "326a307203345128a60b92a356978c46e2992df3";
const SOURCE_KINDS = [
  "git-repo",
  "gmail",
  "hackernews",
  "notion",
  "slack",
  "web-search",
  "x",
];
const SKILL_NAMES = [
  "memex",
  "memex-init",
  "memex-update",
  "memex-query",
  "memex-graph",
  "memex-ingest",
  "memex-ops",
];
const DOCUMENTS = [
  "README.md",
  "SECURITY.md",
  "PRIVACY.md",
  "UPSTREAM.md",
  "UPSTREAM_LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md",
  "LICENSE",
];

async function readText(path) {
  return readFile(path, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

function parseFrontmatter(contents, skillName) {
  assert.ok(contents.startsWith("---\n"), `${skillName} must start with YAML frontmatter`);
  const boundary = contents.indexOf("\n---\n", 4);
  assert.notEqual(boundary, -1, `${skillName} frontmatter must be closed`);

  const fields = Object.fromEntries(
    contents
      .slice(4, boundary)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        assert.ok(separator > 0, `${skillName} frontmatter line must contain ':'`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );

  return { fields, body: contents.slice(boundary + 5) };
}

async function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function assertRelativePluginPath(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.startsWith("./"), `${label} must start with ./`);
  assert.equal(isAbsolute(value), false, `${label} must be relative`);
  assert.equal(value.split("/").includes(".."), false, `${label} must not escape its root`);
}

describe("native plugin packaging", () => {
  test("Codex and Claude manifests expose the same plugin identity without speculative components", async () => {
    const packageMetadata = await readJson(resolve(PLUGIN_ROOT, "package.json"));
    const codex = await readJson(resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json"));
    const claude = await readJson(resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json"));

    for (const manifest of [codex, claude]) {
      assert.equal(manifest.name, "memex");
      assert.equal(manifest.version, packageMetadata.version);
      assert.equal(manifest.author?.name, "Giulio Leone");
      assert.equal(manifest.license, "MIT");
      assert.equal(manifest.skills, "./skills/");
      assert.equal("hooks" in manifest, false);
      assert.equal("apps" in manifest, false);
    }

    assert.equal(codex.interface?.displayName, "Memex");
    assert.equal(codex.interface?.developerName, "Giulio Leone");
    assert.deepEqual(codex.interface?.capabilities, ["Interactive", "Read", "Write"]);
    assert.ok(Array.isArray(codex.interface?.defaultPrompt));
    assert.ok(codex.interface.defaultPrompt.length > 0);
    assert.ok(codex.interface.defaultPrompt.length <= 3);
    for (const prompt of codex.interface.defaultPrompt) {
      assert.equal(typeof prompt, "string");
      assert.ok(prompt.length <= 128);
    }
    for (const assetField of ["composerIcon", "logo", "logoDark", "screenshots"]) {
      assert.equal(assetField in codex.interface, false, `${assetField} requires a real asset`);
    }
    if ("mcpServers" in codex) {
      assert.equal(codex.mcpServers, "./.mcp.json");
      const mcp = await readJson(resolve(PLUGIN_ROOT, ".mcp.json"));
      assert.deepEqual(Object.keys(mcp.mcpServers), ["memex"]);
      assert.equal(mcp.mcpServers.memex.command, "node");
      assert.deepEqual(mcp.mcpServers.memex.args, ["${PLUGIN_ROOT}/dist/mcp.js"]);
      await assert.rejects(stat(resolve(PLUGIN_ROOT, ".codex-plugin", "mcp.json")));
    }

    assert.equal(
      claude.$schema,
      "https://json.schemastore.org/claude-code-plugin-manifest.json",
    );
    assert.equal(claude.displayName, "Memex");
    if ("mcpServers" in claude) {
      assert.equal(claude.mcpServers, "./.claude-plugin/mcp.json");
      const mcp = await readJson(resolve(PLUGIN_ROOT, ".claude-plugin/mcp.json"));
      assert.ok(Object.keys(mcp.mcpServers ?? {}).length > 0, "Claude MCP config must be real");
    }
  });

  test("repository marketplaces use host-native local source shapes", async () => {
    const packageMetadata = await readJson(resolve(PLUGIN_ROOT, "package.json"));
    const codex = await readJson(
      resolve(REPOSITORY_ROOT, ".agents/plugins/marketplace.json"),
    );
    const claude = await readJson(
      resolve(REPOSITORY_ROOT, ".claude-plugin/marketplace.json"),
    );

    assert.equal(codex.name, "memex-local");
    assert.equal(claude.name, "memex-local");
    assert.equal(codex.plugins.length, 1);
    assert.equal(claude.plugins.length, 1);
    assert.deepEqual(codex.plugins[0].source, {
      source: "local",
      path: "./plugins/memex",
    });
    assert.equal(codex.plugins[0].version, packageMetadata.version);
    assert.equal(claude.plugins[0].source, "./plugins/memex");
    assert.equal(claude.owner?.name, "Giulio Leone");
    assert.equal(claude.plugins[0].version, packageMetadata.version);
    assert.equal(claude.plugins[0].strict, true);
  });

  test("all skills carry complete host-neutral execution contracts", async () => {
    for (const skillName of SKILL_NAMES) {
      const contents = await readText(
        resolve(PLUGIN_ROOT, `skills/${skillName}/SKILL.md`),
      );
      const { fields, body } = parseFrontmatter(contents, skillName);

      assert.deepEqual(Object.keys(fields).sort(), ["description", "name"]);
      assert.equal(fields.name, skillName);
      assert.match(fields.description, /Use when/i);
      for (const heading of [
        "Preconditions",
        "Procedure",
        "Evidence",
        "Error recovery",
        "Mutation boundary",
        "Completion proof",
      ]) {
        assert.match(body, new RegExp(`^## ${heading}$`, "m"));
      }
      assert.ok((body.match(/^\d+\. /gm) ?? []).length >= 3);
      assert.match(body, /Codex: derive the plugin root from this SKILL\.md path/i);
      assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    }
  });

  test("ingestion skill fixes source kinds and isolates prompt injection", async () => {
    const contents = await readText(
      resolve(PLUGIN_ROOT, "skills/memex-ingest/SKILL.md"),
    );
    const sourceLine = contents
      .split("\n")
      .find((line) => line.startsWith("Supported source kinds:"));

    assert.ok(sourceLine, "ingestion skill must declare supported source kinds");
    assert.deepEqual(
      sourceLine
        .slice("Supported source kinds:".length)
        .split(",")
        .map((value) => value.trim()),
      SOURCE_KINDS,
    );
    assert.match(contents, /source text as untrusted data/i);
    assert.match(contents, /never treat source text as instructions/i);
    assert.match(contents, /host-authorized connector/i);
    assert.match(contents, /MISSING_HOST_CAPABILITY/);
  });

  test("graph skill exposes the bounded native graph contract", async () => {
    const contents = await readText(
      resolve(PLUGIN_ROOT, "skills/memex-graph/SKILL.md"),
    );
    const { fields, body } = parseFrontmatter(contents, "memex-graph");

    assert.equal(fields.name, "memex-graph");
    assert.match(fields.description, /Use when/i);
    assert.match(body, /graph status first/i);
    assert.match(body, /graph .*--action status/i);
    for (const action of ["build", "status", "query", "context", "impact", "changes", "map"]) {
      assert.match(body, new RegExp(`\\b${action}\\b`));
    }
    assert.match(body, /query.*requires.*--query/i);
    assert.match(body, /context.*impact.*require.*--target/i);
    assert.match(body, /changes.*optionally accepts.*--base/i);
    assert.match(body, /build.*alone.*--force/i);
    assert.match(body, /impact .*direction.*depth/i);
    assert.match(body, /--limit/);
    assert.match(body, /exact.*resolved.*heuristic/i);
    assert.match(body, /truncat/i);
    assert.match(body, /never execute/i);
    assert.match(body, /never (stores )?source-file (contents|bodies)/i);
    assert.match(body, /~\/\.memex\/data/);
    for (const protocolStep of ["initialize", "notifications/initialized", "tools/list", "tools/call"]) {
      assert.match(body, new RegExp(protocolStep));
    }
  });

  test("router and wiki workflows delegate graph work without changing personal mode", async () => {
    const router = await readText(resolve(PLUGIN_ROOT, "skills/memex/SKILL.md"));
    const init = await readText(resolve(PLUGIN_ROOT, "skills/memex-init/SKILL.md"));
    const update = await readText(resolve(PLUGIN_ROOT, "skills/memex-update/SKILL.md"));
    const query = await readText(resolve(PLUGIN_ROOT, "skills/memex-query/SKILL.md"));

    assert.match(router, /memex-graph/);
    assert.match(router, /code[- ]mode/i);
    for (const contents of [init, update, query]) {
      assert.match(contents, /memex-graph/);
      assert.match(contents, /code[- ]mode/i);
      assert.match(contents, /personal mode/i);
    }
    assert.match(init, /do not reproduce graph build or refresh orchestration/i);
    assert.match(update, /owns graph status, authorized refresh/i);
    assert.match(query, /do not broad-scan source files/i);
  });

  test("distribution, security, privacy, and attribution documents are complete", async () => {
    for (const document of DOCUMENTS) {
      assert.equal((await stat(resolve(PLUGIN_ROOT, document))).isFile(), true);
    }

    const readme = await readText(resolve(PLUGIN_ROOT, "README.md"));
    for (const heading of [
      "Codex installation",
      "Claude Code installation",
      "Update",
      "Uninstall",
      "Validation",
      "Proof boundaries",
    ]) {
      assert.match(readme, new RegExp(`^## ${heading}$`, "m"));
    }
    assert.match(readme, /codex plugin add memex@memex-local/);
    assert.match(readme, /claude plugin install memex@memex-local/);

    const security = await readText(resolve(PLUGIN_ROOT, "SECURITY.md"));
    assert.match(security, /path confinement/i);
    assert.match(security, /symlink/i);
    assert.match(security, /prompt injection/i);
    assert.match(security, /host credential/i);

    const privacy = await readText(resolve(PLUGIN_ROOT, "PRIVACY.md"));
    assert.match(privacy, /local deterministic proof/i);
    assert.match(privacy, /authenticated external connector proof/i);
    assert.match(privacy, /~\/.memex\/data/);
    assert.match(privacy, /never stores provider tokens/i);
    for (const document of [security, privacy]) {
      assert.match(document, /graph/i);
      assert.match(document, /symlink/i);
      assert.match(document, /exclud/i);
      assert.match(document, /generated/i);
      assert.match(document, /source bod(y|ies)|source-file bod(y|ies)|source-file contents/i);
      assert.match(document, /private/i);
    }

    const upstream = await readText(resolve(PLUGIN_ROOT, "UPSTREAM.md"));
    assert.match(upstream, new RegExp(UPSTREAM_COMMIT));
    assert.match(upstream, /not endorsed by/i);

    const upstreamLicense = await readText(resolve(PLUGIN_ROOT, "UPSTREAM_LICENSE"));
    assert.match(upstreamLicense, /^MIT License/m);
    assert.match(upstreamLicense, /Copyright \(c\) 2026/);

    const thirdParty = await readText(resolve(PLUGIN_ROOT, "THIRD_PARTY_NOTICES.md"));
    // The pinned upstream project keeps its own real name; this plugin's
    // rename to `memex` does not rewrite third-party provenance history.
    assert.match(thirdParty, /langchain-ai\/openwiki/i);
    assert.match(thirdParty, /MIT License/i);
    assert.match(thirdParty, /Memex/);
  });

  test("packaged surfaces contain no placeholders or external Memex runtime dependency", async () => {
    const files = [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ...SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`),
      ...SKILL_NAMES.filter((name) => name !== "memex-graph").map(
        (name) => `skills/${name}/agents/openai.yaml`,
      ),
      ...DOCUMENTS,
    ];
    const externalRuntimePattern =
      /\bnpx\s+memex\b|\bbunx\s+memex\b|\bnpm\s+(?:install|i)\s+(?:-g\s+)?memex\b|\bpnpm\s+(?:add|dlx)\s+(?:-g\s+)?memex\b/i;

    for (const file of files) {
      const contents = await readText(resolve(PLUGIN_ROOT, file));
      assert.doesNotMatch(contents, /\[TODO:[^\]]*\]|\bTODO\b|\bTBD\b/);
      assert.doesNotMatch(contents, externalRuntimePattern);
    }

    const codex = await readJson(resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json"));
    const claude = await readJson(resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json"));
    assertRelativePluginPath(codex.skills, "Codex skills path");
    assertRelativePluginPath(claude.skills, "Claude skills path");
  });

  test("packaged runtime surfaces do not reference external graph runtimes", async () => {
    const files = [
      "package.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ...SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`),
    ];
    for (const directory of ["src", "dist"]) {
      const entries = await walkFiles(resolve(PLUGIN_ROOT, directory));
      files.push(...entries.map((entry) => relative(PLUGIN_ROOT, entry)));
    }

    for (const file of files) {
      assert.doesNotMatch(
        await readText(resolve(PLUGIN_ROOT, file)),
        /gitnexus/i,
        `${file} must remain Memex-native`,
      );
    }
  });

  test("no stray openwiki identity strings remain outside the allowed legacy-path files", async () => {
    // The plugin was renamed from `openwiki` to `memex`. Exactly three source
    // files legitimately detect and migrate a prior install's `.openwiki`
    // storage root, and may reference the old distribution name in prose,
    // comments, and the migration tombstone; they are still held to a
    // case-sensitive check that a class/constant rename was never missed
    // (`OpenWiki`/`OPENWIKI`, as opposed to the lowercase legacy name). Every
    // other file must contain zero occurrences in any casing.
    const ALLOWED_LEGACY_PATH_FILES = new Set([
      join("src", "migrate.ts"),
      join("src", "paths.ts"),
      join("src", "doctor.ts"),
    ]);
    const STRICT_PATTERN = /openwiki/i;
    const IDENTITY_LEFTOVER_PATTERN = /OpenWiki|OPENWIKI/;

    const targets = [];
    for (const directory of ["src", "skills"]) {
      const absoluteDirectory = resolve(PLUGIN_ROOT, directory);
      for (const filePath of await walkFiles(absoluteDirectory)) {
        targets.push(relative(PLUGIN_ROOT, filePath));
      }
    }
    targets.push(
      join(".codex-plugin", "plugin.json"),
      join(".claude-plugin", "plugin.json"),
      join(".claude-plugin", "mcp.json"),
      ".mcp.json",
    );
    for (const marketplace of [
      resolve(REPOSITORY_ROOT, ".agents/plugins/marketplace.json"),
      resolve(REPOSITORY_ROOT, ".claude-plugin/marketplace.json"),
    ]) {
      targets.push(relative(PLUGIN_ROOT, marketplace));
    }

    for (const target of targets) {
      const absolutePath = resolve(PLUGIN_ROOT, target);
      const contents = await readText(absolutePath);
      if (ALLOWED_LEGACY_PATH_FILES.has(target)) {
        assert.doesNotMatch(
          contents,
          IDENTITY_LEFTOVER_PATTERN,
          `${target} may reference the legacy openwiki distribution name in prose, but must not leave an un-renamed OpenWiki/OPENWIKI identifier`,
        );
        continue;
      }
      assert.doesNotMatch(
        contents,
        STRICT_PATTERN,
        `${target} must not reference the legacy openwiki identity`,
      );
    }
  });
});
