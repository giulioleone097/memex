import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import {
  CLI_PATH,
  SOURCE_ENVELOPE_PATH,
  assertAdapterExists,
  initializeGitRepository,
  makeIsolatedEnvironment,
  makeTemporaryRoot,
  parseSingleJsonDocument,
  runGit,
  runNodeAdapter,
} from "../fixtures/adapter/process-harness.mjs";

const OPERATIONS = [
  "init",
  "status",
  "context",
  "search",
  "read",
  "write",
  "ingest",
  "finalize",
  "check",
  "doctor",
  "schedule",
  "purge",
  "graph",
];

before(() => assertAdapterExists(CLI_PATH, "CLI"));

function runCli(args, { cwd, home, input } = {}) {
  return runNodeAdapter(CLI_PATH, args, {
    cwd,
    env: makeIsolatedEnvironment(home),
    input,
  });
}

function assertSuccess(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = parseSingleJsonDocument(result.stdout);
  assert.equal(output.ok, true);
  assert.ok(Object.hasOwn(output, "data"));
  return output.data;
}

function assertInvalidArgument(result, label) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 2, `${label}: ${result.stderr}`);
  const output = parseSingleJsonDocument(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), ["error", "ok"]);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "INVALID_ARGUMENT");
  assert.equal(typeof output.error.message, "string");
  assert.notEqual(output.error.message, "");
}

function assertGraphCommon(data, action, root) {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.action, action);
  assert.equal(data.root, root);
  const serialized = JSON.stringify(data).toLowerCase();
  assert.equal(serialized.includes("gitnexus"), false);
  assert.equal(Object.hasOwn(data, "provider"), false);
}

function assertGraphSlice(data, expected) {
  assertGraphCommon(data, expected.action, expected.root);
  assert.ok(Array.isArray(data.nodes));
  assert.ok(Array.isArray(data.edges));
  assert.equal(typeof data.truncated, "boolean");
  assert.ok(Array.isArray(data.diagnostics));
  for (const [key, value] of Object.entries(expected.echoed)) {
    assert.deepEqual(data[key], value);
  }
}

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

function jsonPayloadAtLeast(byteLength, character = "x") {
  const prefix = '{"x":"';
  const suffix = '"}';
  const characterBytes = Buffer.byteLength(character, "utf8");
  const count = Math.ceil((byteLength - Buffer.byteLength(prefix + suffix, "utf8")) / characterBytes);
  const payload = `${prefix}${character.repeat(count)}${suffix}`;
  assert.ok(Buffer.byteLength(payload, "utf8") >= byteLength);
  return payload;
}

function assertTooLargeEnvelope(result, marker) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 2, result.stderr);
  const failure = parseSingleJsonDocument(result.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "SOURCE_TOO_LARGE");
  assert.equal(failure.error.message.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
}

function corruptUtf8Envelope() {
  const valid = readFileSync(SOURCE_ENVELOPE_PATH);
  const marker = Buffer.from("adapter-fixture", "utf8");
  const index = valid.indexOf(marker);
  assert.notEqual(index, -1, "source envelope fixture must contain the source id marker");
  return Buffer.concat([
    valid.subarray(0, index),
    Buffer.from([0xc3, 0x28]),
    valid.subarray(index + marker.length),
  ]);
}

function assertInvalidUtf8Envelope(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 2, result.stderr);
  const failure = parseSingleJsonDocument(result.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "INVALID_ARGUMENT");
  assert.equal(failure.error.message, "Source envelope input must be valid UTF-8.");
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(result.stderr, "");
}

describe("CLI adapter", () => {
  test("CLI rejects unknown, repeated, missing, conflicting, and unsafe target flags", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli invalid");
    const home = join(sandbox, "home with spaces");
    const repository = join(sandbox, "repository with spaces");
    mkdirSync(home);
    initializeGitRepository(repository);

    const invalidCases = [
      ["unknown operation", ["not-an-operation"]],
      ["unknown flag", ["init", "--mode", "code", "--root", repository, "--bogus", "value"]],
      ["repeated flag", ["init", "--mode", "code", "--mode", "code", "--root", repository]],
      ["missing value", ["init", "--mode"]],
      ["conflicting rendering", ["init", "--mode", "code", "--root", repository, "--json", "--pretty"]],
      ["code without root", ["init", "--mode", "code"]],
      ["personal with root", ["init", "--mode", "personal", "--root", repository]],
      ["write without input", ["write", "--mode", "code", "--root", repository, "--page", "notes.md"]],
      [
        "write with conflicting inputs",
        [
          "write",
          "--mode",
          "code",
          "--root",
          repository,
          "--page",
          "notes.md",
          "--content",
          "inline",
          "--stdin",
        ],
      ],
      ["ingest without input", ["ingest", "--mode", "code", "--root", repository]],
      [
        "ingest with conflicting inputs",
        [
          "ingest",
          "--mode",
          "code",
          "--root",
          repository,
          "--envelope-file",
          SOURCE_ENVELOPE_PATH,
          "--stdin",
        ],
      ],
      ["search limit below range", ["search", "--mode", "code", "--root", repository, "--query", "wiki", "--limit", "0"]],
      ["search limit above range", ["search", "--mode", "code", "--root", repository, "--query", "wiki", "--limit", "101"]],
    ];

    for (const [label, args] of invalidCases) {
      assertInvalidArgument(runCli(args, { home, input: "{}\n" }), label);
    }
  });

  test("CLI emits one JSON envelope, keeps successful stderr quiet, and preserves spaced literal paths", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli io");
    const home = join(sandbox, "home with spaces $() [literal]");
    const repository = join(sandbox, "repository with spaces $() [literal]");
    mkdirSync(home);
    initializeGitRepository(repository);

    const initialized = runCli(
      ["init", "--mode", "code", "--root", repository],
      { home },
    );
    const initializedData = assertSuccess(initialized);
    assert.equal(initialized.stdout.trim().split(/\r?\n/u).length, 1);
    assert.match(JSON.stringify(initializedData), /repository with spaces/u);

    const pretty = runCli(
      ["status", "--mode", "code", "--root", repository, "--pretty"],
      { home },
    );
    assertSuccess(pretty);
    assert.ok(pretty.stdout.trim().split(/\r?\n/u).length > 1);

    const missing = runCli(
      ["read", "--mode", "code", "--root", repository, "--page", "missing.md"],
      { home },
    );
    assert.equal(missing.status, 2);
    const failure = parseSingleJsonDocument(missing.stdout);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "NOT_FOUND");
  });

  test("CLI write and ingest transports are exclusive, literal, and process-level", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli input");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    const contentFile = join(sandbox, "content file with spaces.md");
    const envelopeFile = join(sandbox, "envelope file with spaces.json");
    const shellMarker = join(sandbox, "must-not-exist");
    mkdirSync(home);
    initializeGitRepository(repository);
    assertSuccess(runCli(["init", "--mode", "code", "--root", repository], { home }));
    writeFileSync(contentFile, "# File content\n", "utf8");
    writeFileSync(envelopeFile, readFileSync(SOURCE_ENVELOPE_PATH), "utf8");

    assert.deepEqual(
      assertSuccess(
        runCli(
          [
            "write",
            "--mode",
            "code",
            "--root",
            repository,
            "--page",
            "notes/literal.md",
            "--content",
            `$(touch ${shellMarker})`,
          ],
          { home },
        ),
      ),
      { page: "notes/literal.md", written: true },
    );
    assert.equal(existsSync(shellMarker), false);

    assert.deepEqual(
      assertSuccess(
        runCli(
          [
            "write",
            "--mode",
            "code",
            "--root",
            repository,
            "--page",
            "notes/file.md",
            "--content-file",
            contentFile,
          ],
          { home },
        ),
      ),
      { page: "notes/file.md", written: true },
    );
    assert.deepEqual(
      assertSuccess(
        runCli(
          [
            "write",
            "--mode",
            "code",
            "--root",
            repository,
            "--page",
            "notes/stdin.md",
            "--stdin",
          ],
          { home, input: "# Standard input\n" },
        ),
      ),
      { page: "notes/stdin.md", written: true },
    );

    assertSuccess(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--envelope-file", envelopeFile],
        { home },
      ),
    );
    assertSuccess(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--stdin"],
        { home, input: readFileSync(SOURCE_ENVELOPE_PATH, "utf8") },
      ),
    );
  });

  test("CLI bounds ingest stdin and envelope files by UTF-8 bytes before JSON parsing without limiting write content", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli bounded ingest");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    const overLimitFile = join(sandbox, "oversized-envelope.json");
    const oversizedWriteFile = join(sandbox, "large-content.md");
    const marker = "hostile-envelope-marker";
    mkdirSync(home);
    initializeGitRepository(repository);
    assertSuccess(runCli(["init", "--mode", "code", "--root", repository], { home }));

    const exactBoundary = jsonPayloadAtLeast(MAX_ENVELOPE_BYTES);
    assert.equal(Buffer.byteLength(exactBoundary, "utf8"), MAX_ENVELOPE_BYTES);
    const exactResult = runCli(
      ["ingest", "--mode", "code", "--root", repository, "--stdin"],
      { home, input: exactBoundary },
    );
    assert.equal(exactResult.status, 2);
    assert.equal(parseSingleJsonDocument(exactResult.stdout).error.code, "INVALID_ARGUMENT");

    const oversizedAscii = marker.repeat(Math.ceil((MAX_ENVELOPE_BYTES + 1) / Buffer.byteLength(marker, "utf8")));
    assertTooLargeEnvelope(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--stdin"],
        { home, input: oversizedAscii },
      ),
      marker,
    );

    const oversizedMultibyte = "é".repeat(Math.ceil((MAX_ENVELOPE_BYTES + 1) / Buffer.byteLength("é", "utf8")));
    assertTooLargeEnvelope(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--stdin"],
        { home, input: oversizedMultibyte },
      ),
      "é",
    );

    writeFileSync(overLimitFile, oversizedAscii, "utf8");
    assertTooLargeEnvelope(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--envelope-file", overLimitFile],
        { home },
      ),
      marker,
    );

    const largeContent = "w".repeat(MAX_ENVELOPE_BYTES + 1);
    writeFileSync(oversizedWriteFile, largeContent, "utf8");
    assert.deepEqual(
      assertSuccess(
        runCli(
          ["write", "--mode", "code", "--root", repository, "--page", "large-file.md", "--content-file", oversizedWriteFile],
          { home },
        ),
      ),
      { page: "large-file.md", written: true },
    );
    assert.deepEqual(
      assertSuccess(
        runCli(
          ["write", "--mode", "code", "--root", repository, "--page", "large-stdin.md", "--stdin"],
          { home, input: largeContent },
        ),
      ),
      { page: "large-stdin.md", written: true },
    );
  });

  test("CLI rejects malformed UTF-8 source envelopes before JSON parsing for stdin and files", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli malformed utf8");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    const envelopeFile = join(sandbox, "malformed-envelope.json");
    mkdirSync(home);
    initializeGitRepository(repository);
    assertSuccess(runCli(["init", "--mode", "code", "--root", repository], { home }));

    const malformed = corruptUtf8Envelope();
    assertInvalidUtf8Envelope(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--stdin"],
        { home, input: malformed },
      ),
    );

    writeFileSync(envelopeFile, malformed);
    assertInvalidUtf8Envelope(
      runCli(
        ["ingest", "--mode", "code", "--root", repository, "--envelope-file", envelopeFile],
        { home },
      ),
    );
  });

  test("CLI exposes every operation through a real isolated repository", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli inventory");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    mkdirSync(home);
    initializeGitRepository(repository, {
      "src/math.ts": "export function add(left: number, right: number) { return left + right; }\n",
    });

    const commands = [
      ["init", "--mode", "code", "--root", repository],
      ["status", "--mode", "code", "--root", repository],
      ["context", "--root", repository],
      ["search", "--mode", "code", "--root", repository, "--query", "architecture"],
      ["read", "--mode", "code", "--root", repository, "--page", "architecture.md"],
      ["write", "--mode", "code", "--root", repository, "--page", "notes.md", "--content", "# Notes\n"],
      ["ingest", "--mode", "code", "--root", repository, "--envelope-file", SOURCE_ENVELOPE_PATH],
      [
        "finalize",
        "--mode",
        "code",
        "--root",
        repository,
        "--command",
        "update",
        "--run-id",
        "cli-adapter-run",
        "--started-at",
        "2026-07-11T10:15:30.000Z",
        "--completed-at",
        "2026-07-11T10:16:30.000Z",
        "--summary",
        "CLI adapter process proof",
      ],
      ["check", "--mode", "code", "--root", repository],
      ["doctor", "--mode", "code", "--root", repository],
      ["schedule", "--mode", "code", "--root", repository, "--action", "list"],
      ["purge", "--mode", "code", "--root", repository, "--scope", "raw"],
      ["graph", "--root", repository, "--action", "build"],
    ];

    assert.deepEqual(commands.map(([operation]) => operation), OPERATIONS);
    for (const args of commands) {
      assertSuccess(runCli(args, { home }));
    }
  });

  test("CLI graph rejects invalid limits and action-incompatible native flags", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli graph invalid");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    mkdirSync(home);
    initializeGitRepository(repository);

    const base = ["graph", "--root", repository];
    const invalidCases = [
      ["missing action", base],
      ["invalid action", [...base, "--action", "crawl"]],
      ["provider forbidden", [...base, "--action", "status", "--provider", "gitnexus"]],
      ["query requires query", [...base, "--action", "query"]],
      ["context requires target", [...base, "--action", "context"]],
      ["impact requires target", [...base, "--action", "impact"]],
      ["build rejects limit", [...base, "--action", "build", "--limit", "1"]],
      ["status rejects force", [...base, "--action", "status", "--force"]],
      ["query rejects target", [...base, "--action", "query", "--query", "add", "--target", "add"]],
      ["context rejects query", [...base, "--action", "context", "--target", "add", "--query", "add"]],
      ["impact rejects query", [...base, "--action", "impact", "--target", "add", "--query", "add"]],
      ["changes rejects target", [...base, "--action", "changes", "--target", "add"]],
      ["map rejects force", [...base, "--action", "map", "--force"]],
      ["invalid direction", [...base, "--action", "impact", "--target", "add", "--direction", "sideways"]],
      ["depth below range", [...base, "--action", "impact", "--target", "add", "--depth", "0"]],
      ["depth above range", [...base, "--action", "impact", "--target", "add", "--depth", "6"]],
      ["limit below range", [...base, "--action", "map", "--limit", "0"]],
      ["limit above range", [...base, "--action", "map", "--limit", "101"]],
    ];

    for (const [label, args] of invalidCases) {
      assertInvalidArgument(runCli(args, { home }), label);
    }
  });

  test("CLI graph passes seven native actions and bounded inputs to stable DTOs", (t) => {
    const sandbox = makeTemporaryRoot(t, "cli native graph");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository with spaces");
    mkdirSync(home);
    const baseHead = initializeGitRepository(repository, {
      "src/math.ts": [
        "export function add(left: number, right: number) {",
        "  return left + right;",
        "}",
        "export function double(value: number) { return add(value, value); }",
        "",
      ].join("\n"),
    });
    const graph = ["graph", "--root", repository, "--action"];

    const built = assertSuccess(runCli([...graph, "build", "--force"], { home }));
    assertGraphCommon(built, "build", repository);
    assert.equal(typeof built.fresh, "boolean");
    assert.equal(built.buildMode, "full");
    assert.equal(built.fullRebuild, true);
    assert.ok(Array.isArray(built.changedPaths));
    assert.equal(typeof built.truncated, "boolean");
    assert.equal(Object.hasOwn(built, "graph"), false);
    if (built.head !== undefined) assert.match(built.head, /^[a-f0-9]{40}$/u);
    assert.equal(typeof built.dirtyFingerprint, "string");
    for (const key of [
      "scannedFileCount",
      "removedFileCount",
      "fileCount",
      "nodeCount",
      "edgeCount",
      "diagnosticCount",
    ]) {
      assert.ok(Number.isInteger(built[key]) && built[key] >= 0, key);
    }
    assert.equal(Number.isNaN(Date.parse(built.generatedAt)), false);

    const status = assertSuccess(runCli([...graph, "status"], { home }));
    assertGraphCommon(status, "status", repository);
    assert.equal(typeof status.available, "boolean");
    assert.equal(typeof status.fresh, "boolean");
    if (status.reason !== undefined) assert.equal(typeof status.reason, "string");
    if (status.counts !== undefined) assert.equal(typeof status.counts, "object");

    const queryText = "add";
    assertGraphSlice(
      assertSuccess(runCli([...graph, "query", "--query", queryText, "--limit", "1"], { home })),
      { action: "query", root: repository, echoed: { query: queryText, limit: 1 } },
    );
    assertGraphSlice(
      assertSuccess(runCli([...graph, "context", "--target", "add", "--limit", "2"], { home })),
      { action: "context", root: repository, echoed: { target: "add", limit: 2 } },
    );
    assertGraphSlice(
      assertSuccess(
        runCli(
          [...graph, "impact", "--target", "add", "--direction", "both", "--depth", "2", "--limit", "3"],
          { home },
        ),
      ),
      {
        action: "impact",
        root: repository,
        echoed: { target: "add", direction: "both", depth: 2, limit: 3 },
      },
    );

    writeFileSync(
      join(repository, "src/math.ts"),
      "export function add(left: number, right: number) { return left + right + 0; }\n",
      "utf8",
    );
    assertGraphSlice(
      assertSuccess(runCli([...graph, "changes", "--base", baseHead, "--limit", "4"], { home })),
      { action: "changes", root: repository, echoed: { base: baseHead, limit: 4 } },
    );

    const map = assertSuccess(runCli([...graph, "map", "--limit", "5"], { home }));
    assertGraphCommon(map, "map", repository);
    for (const key of ["modules", "hubs", "cycles", "flows", "diagnostics"]) {
      assert.ok(Array.isArray(map[key]), key);
    }
    assert.equal(map.limit, 5);
    assert.equal(typeof map.truncated, "boolean");

    assert.equal(runGit(repository, ["rev-parse", "HEAD"]).trim(), baseHead);
  });
});
