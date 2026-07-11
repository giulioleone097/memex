import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
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
  "openwiki",
  "openwiki-init",
  "openwiki-update",
  "openwiki-query",
  "openwiki-ingest",
  "openwiki-ops",
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

function assertRelativePluginPath(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.startsWith("./"), `${label} must start with ./`);
  assert.equal(isAbsolute(value), false, `${label} must be relative`);
  assert.equal(value.split("/").includes(".."), false, `${label} must not escape its root`);
}

describe("native plugin packaging", () => {
  test("Codex and Claude manifests expose the same plugin identity without speculative components", async () => {
    const codex = await readJson(resolve(PLUGIN_ROOT, ".codex-plugin/plugin.json"));
    const claude = await readJson(resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json"));

    for (const manifest of [codex, claude]) {
      assert.equal(manifest.name, "openwiki");
      assert.equal(manifest.version, "0.1.0");
      assert.equal(manifest.author?.name, "Giulio Leone");
      assert.equal(manifest.license, "MIT");
      assert.equal(manifest.skills, "./skills/");
      assert.equal("hooks" in manifest, false);
      assert.equal("apps" in manifest, false);
    }

    assert.equal(codex.interface?.displayName, "OpenWiki");
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
      assert.ok(Object.keys(mcp.mcpServers ?? {}).length > 0, "Codex MCP config must be real");
    }

    assert.equal(
      claude.$schema,
      "https://json.schemastore.org/claude-code-plugin-manifest.json",
    );
    assert.equal(claude.displayName, "OpenWiki");
    if ("mcpServers" in claude) {
      assert.equal(claude.mcpServers, "./.claude-plugin/mcp.json");
      const mcp = await readJson(resolve(PLUGIN_ROOT, ".claude-plugin/mcp.json"));
      assert.ok(Object.keys(mcp.mcpServers ?? {}).length > 0, "Claude MCP config must be real");
    }
  });

  test("repository marketplaces use host-native local source shapes", async () => {
    const codex = await readJson(
      resolve(REPOSITORY_ROOT, ".agents/plugins/marketplace.json"),
    );
    const claude = await readJson(
      resolve(REPOSITORY_ROOT, ".claude-plugin/marketplace.json"),
    );

    assert.equal(codex.name, "openwiki-local");
    assert.equal(claude.name, "openwiki-local");
    assert.equal(codex.plugins.length, 1);
    assert.equal(claude.plugins.length, 1);
    assert.deepEqual(codex.plugins[0].source, {
      source: "local",
      path: "./plugins/openwiki",
    });
    assert.equal(claude.plugins[0].source, "./plugins/openwiki");
    assert.equal(claude.owner?.name, "Giulio Leone");
    assert.equal(claude.plugins[0].version, "0.1.0");
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
      resolve(PLUGIN_ROOT, "skills/openwiki-ingest/SKILL.md"),
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
    assert.match(readme, /codex plugin add openwiki@openwiki-local/);
    assert.match(readme, /claude plugin install openwiki@openwiki-local/);

    const security = await readText(resolve(PLUGIN_ROOT, "SECURITY.md"));
    assert.match(security, /path confinement/i);
    assert.match(security, /symlink/i);
    assert.match(security, /prompt injection/i);
    assert.match(security, /host credential/i);

    const privacy = await readText(resolve(PLUGIN_ROOT, "PRIVACY.md"));
    assert.match(privacy, /local deterministic proof/i);
    assert.match(privacy, /authenticated external connector proof/i);
    assert.match(privacy, /~\/.openwiki\/data/);
    assert.match(privacy, /never stores provider tokens/i);

    const upstream = await readText(resolve(PLUGIN_ROOT, "UPSTREAM.md"));
    assert.match(upstream, new RegExp(UPSTREAM_COMMIT));
    assert.match(upstream, /not endorsed by/i);

    const upstreamLicense = await readText(resolve(PLUGIN_ROOT, "UPSTREAM_LICENSE"));
    assert.match(upstreamLicense, /^MIT License/m);
    assert.match(upstreamLicense, /Copyright \(c\) 2026/);

    const thirdParty = await readText(resolve(PLUGIN_ROOT, "THIRD_PARTY_NOTICES.md"));
    assert.match(thirdParty, /langchain-ai\/openwiki/i);
    assert.match(thirdParty, /MIT License/i);
  });

  test("packaged surfaces contain no placeholders or external OpenWiki runtime dependency", async () => {
    const files = [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ...SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`),
      ...SKILL_NAMES.map((name) => `skills/${name}/agents/openai.yaml`),
      ...DOCUMENTS,
    ];
    const externalRuntimePattern =
      /\bnpx\s+openwiki\b|\bbunx\s+openwiki\b|\bnpm\s+(?:install|i)\s+(?:-g\s+)?openwiki\b|\bpnpm\s+(?:add|dlx)\s+(?:-g\s+)?openwiki\b/i;

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
});
