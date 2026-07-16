import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { MemexError } from "../../dist/errors.js";
import { runMigration } from "../../dist/migrate.js";

const temporaryRoots = [];

async function makeTemporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-migrate-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function expectMemexError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MemexError);
    assert.equal(error.code, code);
    return true;
  });
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("migrate", () => {
  test("migrate: neither root exists is a safe no-op", async () => {
    const home = await makeTemporaryRoot("none");

    const result = await runMigration(home);

    assert.deepEqual(result, {
      migrated: false,
      from: path.join(home, ".openwiki"),
      to: path.join(home, ".memex"),
      entries: 0,
    });
    assert.equal(await pathExists(path.join(home, ".openwiki")), false);
    assert.equal(await pathExists(path.join(home, ".memex")), false);
  });

  test("migrate: moves an existing legacy root to the new root and writes a tombstone", async () => {
    const home = await makeTemporaryRoot("move");
    const legacyRoot = path.join(home, ".openwiki");
    await mkdir(path.join(legacyRoot, "wiki"), { recursive: true });
    await writeFile(path.join(legacyRoot, "wiki", "quickstart.md"), "# Quickstart\n", "utf8");
    await mkdir(path.join(legacyRoot, "data", "personal"), { recursive: true });
    await writeFile(
      path.join(legacyRoot, "data", "personal", "schedules.json"),
      "{}\n",
      "utf8",
    );

    const result = await runMigration(home);

    assert.equal(result.migrated, true);
    assert.equal(result.from, legacyRoot);
    assert.equal(result.to, path.join(home, ".memex"));
    assert.equal(result.entries, 2); // "wiki" and "data" top-level entries
    assert.equal(result.tombstonePath, path.join(legacyRoot, "MIGRATED.md"));

    assert.equal(
      await readFile(path.join(home, ".memex", "wiki", "quickstart.md"), "utf8"),
      "# Quickstart\n",
    );
    assert.equal(
      await readFile(path.join(home, ".memex", "data", "personal", "schedules.json"), "utf8"),
      "{}\n",
    );

    const legacyEntries = await readdir(legacyRoot);
    assert.deepEqual(legacyEntries, ["MIGRATED.md"]);
    const tombstone = await readFile(path.join(legacyRoot, "MIGRATED.md"), "utf8");
    assert.match(tombstone, new RegExp(path.join(home, ".memex").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });

  test("migrate: re-running after a successful migration is a safe no-op", async () => {
    const home = await makeTemporaryRoot("rerun");
    const legacyRoot = path.join(home, ".openwiki");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(path.join(legacyRoot, "marker.txt"), "legacy\n", "utf8");

    const first = await runMigration(home);
    assert.equal(first.migrated, true);

    const second = await runMigration(home);
    assert.deepEqual(second, {
      migrated: false,
      from: legacyRoot,
      to: path.join(home, ".memex"),
      entries: 0,
      tombstonePath: path.join(legacyRoot, "MIGRATED.md"),
    });

    // Re-running must not touch the already-migrated data.
    assert.equal(
      await readFile(path.join(home, ".memex", "marker.txt"), "utf8"),
      "legacy\n",
    );
  });

  test("migrate: refuses to guess when both roots hold real data", async () => {
    const home = await makeTemporaryRoot("conflict");
    const legacyRoot = path.join(home, ".openwiki");
    const newRoot = path.join(home, ".memex");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(path.join(legacyRoot, "legacy.txt"), "legacy\n", "utf8");
    await mkdir(newRoot, { recursive: true });
    await writeFile(path.join(newRoot, "new.txt"), "new\n", "utf8");

    await expectMemexError(runMigration(home), "MIGRATION_CONFLICT");

    // Neither side may be touched while the conflict is unresolved.
    assert.equal(await readFile(path.join(legacyRoot, "legacy.txt"), "utf8"), "legacy\n");
    assert.equal(await readFile(path.join(newRoot, "new.txt"), "utf8"), "new\n");
  });

  test("migrate: migrates into an existing but empty new root", async () => {
    const home = await makeTemporaryRoot("empty-target");
    const legacyRoot = path.join(home, ".openwiki");
    const newRoot = path.join(home, ".memex");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(path.join(legacyRoot, "legacy.txt"), "legacy\n", "utf8");
    await mkdir(newRoot, { recursive: true });

    const result = await runMigration(home);

    assert.equal(result.migrated, true);
    assert.equal(
      await readFile(path.join(newRoot, "legacy.txt"), "utf8"),
      "legacy\n",
    );
  });

  test("migrate: rejects a symlinked legacy root with the existing confinement error", async () => {
    const home = await makeTemporaryRoot("symlink");
    const outside = await makeTemporaryRoot("symlink-outside");
    await symlink(outside, path.join(home, ".openwiki"));

    await expectMemexError(runMigration(home), "SYMLINK_ESCAPE");
  });
});
