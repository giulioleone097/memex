import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runDoctor } from "../../dist/doctor.js";
import { withWikiLock } from "../../dist/atomic.js";
import { MemexError } from "../../dist/errors.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import {
  listSchedules,
  removeSchedule,
  setSchedule,
} from "../../dist/schedules.js";
import { ingestSource, purgeData } from "../../dist/sources.js";
import { initializeWiki } from "../../dist/wiki.js";

const NOW = "2026-07-11T10:15:30.000Z";
const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const temporaryRoots = [];

async function makeTemporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function makePersonalLocation(label, initialize = false) {
  const homeDir = await makeTemporaryRoot(label);
  if (initialize) {
    return (
      await initializeWiki({
        mode: "personal",
        homeDir,
        now: NOW,
        runId: `${label}-init`,
      })
    ).location;
  }
  return resolveWikiLocation({ mode: "personal", homeDir });
}

function createSchedule(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "daily-update",
    command: "update",
    cron: "0 2 * * *",
    timezone: "UTC",
    enabled: true,
    ...overrides,
  };
}

function createEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: "gmail-primary",
    kind: "gmail",
    fetchedAt: NOW,
    provenance: { host: "cli" },
    items: [{ externalId: "message-1", text: "Safe source content." }],
    ...overrides,
  };
}

async function expectMemexError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MemexError);
    assert.equal(error.code, code);
    return true;
  });
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function snapshotTree(root) {
  const entries = [];

  async function visit(current, relative) {
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === ".memex.lock") {
        continue;
      }
      const childRelative = path.join(relative, child.name);
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        entries.push(`directory:${childRelative}`);
        await visit(childPath, childRelative);
      } else if (child.isSymbolicLink()) {
        entries.push(`symlink:${childRelative}`);
      } else {
        const digest = createHash("sha256").update(await readFile(childPath)).digest("hex");
        entries.push(`file:${childRelative}:${digest}`);
      }
    }
  }

  await visit(root, "");
  return entries;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("schedule, doctor, and purge operations", () => {
  test("schedules: set is idempotent, updates by id, lists, and removes", async () => {
    const location = await makePersonalLocation("schedules");
    const schedule = createSchedule();

    const created = await setSchedule({ location, schedule });
    const unchanged = await setSchedule({
      location,
      schedule: {
        enabled: true,
        timezone: "UTC",
        cron: "0 2 * * *",
        command: "update",
        id: "daily-update",
        schemaVersion: 1,
      },
    });
    assert.equal(created.changed, true);
    assert.deepEqual(created.schedule, schedule);
    assert.equal(unchanged.changed, false);
    assert.deepEqual(await listSchedules(location), [schedule]);

    const updatedSchedule = createSchedule({ cron: "30 3 * * *" });
    const updated = await setSchedule({ location, schedule: updatedSchedule });
    assert.equal(updated.changed, true);
    assert.deepEqual(await listSchedules(location), [updatedSchedule]);

    assert.deepEqual(await removeSchedule({ location, id: "daily-update" }), {
      id: "daily-update",
      removed: true,
    });
    assert.deepEqual(await removeSchedule({ location, id: "daily-update" }), {
      id: "daily-update",
      removed: false,
    });
    assert.deepEqual(await listSchedules(location), []);
  });

  test("schedules: validates malformed intent and persisted state", async () => {
    const location = await makePersonalLocation("malformed-schedules");

    await expectMemexError(
      setSchedule({ location, schedule: createSchedule({ cron: "not a cron" }) }),
      "INVALID_ARGUMENT",
    );
    await expectMemexError(
      setSchedule({ location, schedule: createSchedule({ cron: "99 2 * * *" }) }),
      "INVALID_ARGUMENT",
    );
    await expectMemexError(
      setSchedule({
        location,
        schedule: createSchedule({ command: "ingest", sourceId: undefined }),
      }),
      "INVALID_ARGUMENT",
    );
    await expectMemexError(
      setSchedule({
        location,
        schedule: createSchedule({
          command: "ingest",
          sourceId: "sk-proj-this-must-never-reach-disk",
        }),
      }),
      "INVALID_ARGUMENT",
    );
    await expectMemexError(
      setSchedule({ location, schedule: { ...createSchedule(), unexpected: true } }),
      "INVALID_ARGUMENT",
    );
    await expectMemexError(
      removeSchedule({ location, id: "../escape" }),
      "INVALID_ARGUMENT",
    );

    await mkdir(location.dataRoot, { recursive: true });
    await writeFile(path.join(location.dataRoot, "schedules.json"), "{not-json}\n", "utf8");
    await expectMemexError(listSchedules(location), "INVALID_STATE");
  });

  test("doctor: returns actionable checks without mutating state", async () => {
    const location = await makePersonalLocation("doctor-read-only", true);
    await setSchedule({ location, schedule: createSchedule() });
    await ingestSource({ location, envelope: createEnvelope() });
    const homeRoot = path.dirname(path.dirname(location.wikiRoot));
    const before = await snapshotTree(homeRoot);

    const result = await runDoctor({ location, homeDir: homeRoot });
    const after = await snapshotTree(homeRoot);

    assert.equal(result.ok, true);
    assert.equal(result.checks.every((check) => check.status !== "fail"), true);
    assert.equal(result.checks.some((check) => check.id === "node"), true);
    assert.equal(result.checks.some((check) => check.id === "manifests"), true);
    assert.equal(result.checks.some((check) => check.id === "state"), true);
    assert.equal(result.checks.some((check) => check.id === "retention"), true);
    assert.equal(result.checks.some((check) => check.id === "secret-leakage"), true);
    assert.equal(result.checks.some((check) => check.id === "legacy-storage"), true);
    assert.deepEqual(after, before);
  });

  test("doctor: reports malformed state and secret leakage without exposing the secret", async () => {
    const location = await makePersonalLocation("doctor-failures", true);
    const leakedToken = "xoxb-123456789012-123456789012-doctorsecretvalue";
    await writeFile(location.statePath, "{malformed-state}\n", "utf8");
    const rawRoot = path.join(location.dataRoot, "raw", "manual");
    await mkdir(rawRoot, { recursive: true });
    await writeFile(
      path.join(rawRoot, "leak.json"),
      JSON.stringify({ token: leakedToken }),
      "utf8",
    );

    const homeRoot = path.dirname(path.dirname(location.wikiRoot));
    const before = await snapshotTree(homeRoot);
    const result = await runDoctor({ location, homeDir: homeRoot, pluginRoot: PLUGIN_ROOT });
    const after = await snapshotTree(homeRoot);

    assert.equal(result.ok, false);
    assert.equal(
      result.checks.some((check) => check.id === "state" && check.status === "fail"),
      true,
    );
    assert.equal(
      result.checks.some(
        (check) => check.id === "secret-leakage" && check.status === "fail",
      ),
      true,
    );
    assert.equal(JSON.stringify(result).includes(leakedToken), false);
    assert.deepEqual(after, before);
  });

  test("purge: removes only explicit scopes and never follows symlinks", async () => {
    const location = await makePersonalLocation("purge-scopes", true);
    await setSchedule({ location, schedule: createSchedule() });
    await ingestSource({ location, envelope: createEnvelope() });

    const outside = await makeTemporaryRoot("purge-outside");
    const outsideFile = path.join(outside, "must-survive.txt");
    await writeFile(outsideFile, "preserve me\n", "utf8");
    const rawRoot = path.join(location.dataRoot, "raw");
    await symlink(outside, path.join(rawRoot, "outside-link"));

    assert.deepEqual(await purgeData({ location, scope: "raw" }), {
      requestedScope: "raw",
      removedScopes: ["raw"],
    });
    assert.equal(await pathExists(rawRoot), false);
    assert.equal(await readFile(outsideFile, "utf8"), "preserve me\n");
    assert.equal(await pathExists(path.join(location.dataRoot, "schedules.json")), true);
    assert.equal(await pathExists(location.wikiRoot), true);

    assert.deepEqual(await purgeData({ location, scope: "schedules" }), {
      requestedScope: "schedules",
      removedScopes: ["schedules"],
    });
    assert.equal(await pathExists(path.join(location.dataRoot, "schedules.json")), false);
    assert.equal(await pathExists(location.wikiRoot), true);

    assert.deepEqual(await purgeData({ location, scope: "personal-wiki" }), {
      requestedScope: "personal-wiki",
      removedScopes: ["personal-wiki"],
    });
    assert.equal(await pathExists(location.wikiRoot), false);
    assert.equal(await pathExists(location.statePath), false);
  });

  test("purge: all is explicit, idempotent, and never removes a code wiki", async () => {
    const personal = await makePersonalLocation("purge-all", true);
    await setSchedule({ location: personal, schedule: createSchedule() });
    await ingestSource({ location: personal, envelope: createEnvelope() });

    assert.deepEqual(await purgeData({ location: personal, scope: "all" }), {
      requestedScope: "all",
      removedScopes: ["raw", "schedules", "personal-wiki"],
    });
    assert.equal(await pathExists(personal.statePath), false);
    assert.deepEqual(await purgeData({ location: personal, scope: "all" }), {
      requestedScope: "all",
      removedScopes: [],
    });

    const repository = await makeTemporaryRoot("purge-code-repository");
    const homeDir = await makeTemporaryRoot("purge-code-home");
    const code = (
      await initializeWiki({
        mode: "code",
        root: repository,
        homeDir,
        now: NOW,
        runId: "purge-code-init",
      })
    ).location;

    await expectMemexError(
      purgeData({ location: code, scope: "personal-wiki" }),
      "INVALID_ARGUMENT",
    );
    assert.equal(await pathExists(code.wikiRoot), true);
    await expectMemexError(
      purgeData({ location: code, scope: "missing" }),
      "INVALID_ARGUMENT",
    );
  });

  test("purge: refuses to delete a personal wiki while its operation lock is active", async () => {
    const location = await makePersonalLocation("purge-active-lock", true);
    await setSchedule({ location, schedule: createSchedule() });
    await ingestSource({ location, envelope: createEnvelope() });

    await withWikiLock(location.wikiRoot, async () => {
      await expectMemexError(
        purgeData({ location, scope: "personal-wiki" }),
        "LOCKED",
      );
      assert.equal(await pathExists(location.wikiRoot), true);
      assert.equal(await pathExists(location.statePath), true);
      await expectMemexError(purgeData({ location, scope: "all" }), "LOCKED");
      assert.equal(await pathExists(path.join(location.dataRoot, "raw")), true);
      assert.equal(await pathExists(path.join(location.dataRoot, "schedules.json")), true);
    });
  });
});
