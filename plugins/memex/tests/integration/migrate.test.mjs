import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import {
  CLI_PATH,
  assertAdapterExists,
  makeIsolatedEnvironment,
  makeTemporaryRoot,
  parseSingleJsonDocument,
  runNodeAdapter,
} from "../fixtures/adapter/process-harness.mjs";

before(() => assertAdapterExists(CLI_PATH, "CLI"));

function runCli(args, { home } = {}) {
  return runNodeAdapter(CLI_PATH, args, { env: makeIsolatedEnvironment(home) });
}

function assertSuccess(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = parseSingleJsonDocument(result.stdout);
  assert.equal(output.ok, true);
  return output.data;
}

function assertFailure(result, code) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 2, result.stderr);
  const output = parseSingleJsonDocument(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, code);
  return output.error;
}

describe("CLI migrate operation", () => {
  test("migrate: no-op through the CLI when neither storage root exists", (t) => {
    const home = makeTemporaryRoot(t, "migrate-none");

    const data = assertSuccess(runCli(["migrate"], { home }));

    assert.deepEqual(data, {
      migrated: false,
      from: join(home, ".openwiki"),
      to: join(home, ".memex"),
      entries: 0,
    });
  });

  test("migrate: moves a real legacy root end-to-end and doctor stops warning afterward", (t) => {
    const home = makeTemporaryRoot(t, "migrate-move");
    const legacyRoot = join(home, ".openwiki");
    mkdirSync(join(legacyRoot, "wiki"), { recursive: true });
    writeFileSync(join(legacyRoot, "wiki", "quickstart.md"), "# Quickstart\n", "utf8");

    const beforeDoctor = assertSuccess(
      runCli(["doctor", "--mode", "personal"], { home }),
    );
    const beforeCheck = beforeDoctor.checks.find((check) => check.id === "legacy-storage");
    assert.equal(beforeCheck.status, "warning");

    const migrated = assertSuccess(runCli(["migrate"], { home }));
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.entries, 1);
    assert.equal(
      readFileSync(join(home, ".memex", "wiki", "quickstart.md"), "utf8"),
      "# Quickstart\n",
    );
    assert.deepEqual(readdirSync(legacyRoot), ["MIGRATED.md"]);

    const afterDoctor = assertSuccess(
      runCli(["doctor", "--mode", "personal"], { home }),
    );
    const afterCheck = afterDoctor.checks.find((check) => check.id === "legacy-storage");
    assert.equal(afterCheck.status, "pass");

    const rerun = assertSuccess(runCli(["migrate"], { home }));
    assert.equal(rerun.migrated, false);
  });

  test("migrate: reports MIGRATION_CONFLICT through the CLI without touching either root", (t) => {
    const home = makeTemporaryRoot(t, "migrate-conflict");
    const legacyRoot = join(home, ".openwiki");
    const newRoot = join(home, ".memex");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "legacy.txt"), "legacy\n", "utf8");
    mkdirSync(newRoot, { recursive: true });
    writeFileSync(join(newRoot, "new.txt"), "new\n", "utf8");

    const error = assertFailure(runCli(["migrate"], { home }), "MIGRATION_CONFLICT");
    assert.notEqual(error.message, "");

    assert.equal(readFileSync(join(legacyRoot, "legacy.txt"), "utf8"), "legacy\n");
    assert.equal(readFileSync(join(newRoot, "new.txt"), "utf8"), "new\n");
  });

  test("migrate: rejects unknown arguments", (t) => {
    const home = makeTemporaryRoot(t, "migrate-args");

    assertFailure(runCli(["migrate", "--root", "/tmp"], { home }), "INVALID_ARGUMENT");
  });
});
