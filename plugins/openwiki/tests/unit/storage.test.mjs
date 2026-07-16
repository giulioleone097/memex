import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, test } from "node:test";
import { URL } from "node:url";

import { withWikiLock } from "../../dist/atomic.js";
import { OpenWikiError } from "../../dist/errors.js";
import { resolveWikiLocation } from "../../dist/paths.js";
import { readState } from "../../dist/state.js";
import {
  REQUIRED_WIKI_PAGES,
  checkWiki,
  finalizeRun,
  initializeWiki,
  readPage,
  writePage,
} from "../../dist/wiki.js";

const NOW = "2026-07-11T10:15:30.000Z";
const LATER = "2026-07-11T10:20:30.000Z";
const temporaryRoots = [];

async function makeTemporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function expectOpenWikiError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OpenWikiError);
    assert.equal(error.code, code);
    return true;
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("storage", () => {
  test("storage: resolves deterministic code and personal wiki locations", async () => {
    const repository = await makeTemporaryRoot("locations-repository");
    const home = await makeTemporaryRoot("locations-home");

    const code = await resolveWikiLocation({ mode: "code", root: repository });
    assert.equal(code.mode, "code");
    assert.equal(code.workspaceRoot, await realpath(repository));
    assert.equal(code.wikiRoot, path.join(code.workspaceRoot, "openwiki"));
    assert.equal(code.statePath, path.join(code.wikiRoot, ".last-update.json"));
    assert.match(code.workspaceId, /^[a-f0-9]{64}$/u);

    const personal = await resolveWikiLocation({ mode: "personal", homeDir: home });
    const canonicalHome = await realpath(home);
    assert.equal(personal.mode, "personal");
    assert.equal(personal.workspaceId, "personal");
    assert.equal(personal.wikiRoot, path.join(canonicalHome, ".openwiki", "wiki"));
    assert.equal(
      personal.statePath,
      path.join(canonicalHome, ".openwiki", ".last-update.json"),
    );
    assert.equal(
      personal.dataRoot,
      path.join(canonicalHome, ".openwiki", "data", "personal"),
    );
  });

  test("storage: rejects a private data symlink that escapes the configured home", async () => {
    const home = await makeTemporaryRoot("data-symlink-home");
    const outside = await makeTemporaryRoot("data-symlink-outside");
    const privateRoot = path.join(home, ".openwiki");
    await mkdir(privateRoot);
    await symlink(outside, path.join(privateRoot, "data"));

    await expectOpenWikiError(
      resolveWikiLocation({ mode: "personal", homeDir: home }),
      "SYMLINK_ESCAPE",
    );
  });

  test("storage: rejects a configured repository root that is not a directory", async () => {
    const parent = await makeTemporaryRoot("invalid-repository-root");
    const repositoryFile = path.join(parent, "repository.txt");
    await writeFile(repositoryFile, "not a directory", "utf8");

    await expectOpenWikiError(
      resolveWikiLocation({ mode: "code", root: repositoryFile }),
      "NOT_FOUND",
    );
  });

  test("storage: initializes required pages idempotently without overwriting user content", async () => {
    const repository = await makeTemporaryRoot("initialize");
    const wikiRoot = path.join(repository, "openwiki");
    await mkdir(wikiRoot, { recursive: true });
    await writeFile(path.join(wikiRoot, "quickstart.md"), "# Custom quickstart\n", "utf8");

    const first = await initializeWiki({
      mode: "code",
      root: repository,
      now: NOW,
      runId: "init-1",
    });
    assert.equal(first.changed, true);
    assert.equal(first.state.schemaVersion, 1);
    assert.equal(first.state.lastRun.command, "init");
    assert.equal(await readFile(path.join(wikiRoot, "quickstart.md"), "utf8"), "# Custom quickstart\n");
    for (const page of REQUIRED_WIKI_PAGES) {
      assert.equal((await stat(path.join(wikiRoot, page))).isFile(), true);
    }

    const stateBefore = await readFile(first.location.statePath, "utf8");
    const second = await initializeWiki({
      mode: "code",
      root: repository,
      now: LATER,
      runId: "init-2",
    });
    const stateAfter = await readFile(first.location.statePath, "utf8");

    assert.equal(second.changed, false);
    assert.equal(stateAfter, stateBefore);
    assert.equal(second.state.lastRun.id, "init-1");
  });

  test("storage: rejects a directory masquerading as a required wiki page", async () => {
    const repository = await makeTemporaryRoot("required-page-directory");
    await mkdir(path.join(repository, "openwiki", "quickstart.md"), {
      recursive: true,
    });

    await expectOpenWikiError(
      initializeWiki({
        mode: "code",
        root: repository,
        now: NOW,
        runId: "init-invalid-page",
      }),
      "IO_FAILURE",
    );
  });

  test("storage: rejects traversal, absolute paths, non-markdown pages, and symlink escapes", async () => {
    const repository = await makeTemporaryRoot("confinement");
    const outside = await makeTemporaryRoot("confinement-outside");
    const initialized = await initializeWiki({
      mode: "code",
      root: repository,
      now: NOW,
      runId: "init-confinement",
    });

    await expectOpenWikiError(
      writePage(initialized.location, "../outside.md", "blocked"),
      "PATH_OUTSIDE_ROOT",
    );
    await expectOpenWikiError(
      writePage(initialized.location, path.join(outside, "absolute.md"), "blocked"),
      "PATH_OUTSIDE_ROOT",
    );
    await expectOpenWikiError(
      writePage(initialized.location, "notes.txt", "blocked"),
      "INVALID_ARGUMENT",
    );

    const outsideFile = path.join(outside, "secret.md");
    await writeFile(outsideFile, "outside remains unchanged", "utf8");
    await symlink(outsideFile, path.join(initialized.location.wikiRoot, "escape.md"));
    await expectOpenWikiError(
      readPage(initialized.location, "escape.md"),
      "SYMLINK_ESCAPE",
    );
    await expectOpenWikiError(
      writePage(initialized.location, "escape.md", "overwrite attempt"),
      "SYMLINK_ESCAPE",
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside remains unchanged");

    const outsideDirectory = path.join(outside, "linked-directory");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(initialized.location.wikiRoot, "linked"));
    await expectOpenWikiError(
      writePage(initialized.location, "linked/new.md", "blocked"),
      "SYMLINK_ESCAPE",
    );
  });

  test("storage: writes atomically, reads line metadata, ranks search, and reports checks", async () => {
    const repository = await makeTemporaryRoot("wiki-operations");
    const initialized = await initializeWiki({
      mode: "code",
      root: repository,
      now: NOW,
      runId: "init-operations",
    });

    await writePage(
      initialized.location,
      "notes/release.md",
      "# Release\nDeployment completed.\nRollback procedure is documented here.\n",
    );
    const page = await readPage(initialized.location, "notes/release.md");
    assert.equal(page.page, "notes/release.md");
    assert.equal(page.lineCount, 3);
    assert.equal(page.content.includes("Rollback procedure"), true);

    await finalizeRun({
      location: initialized.location,
      command: "update",
      runId: "update-operations",
      startedAt: LATER,
      completedAt: LATER,
      summary: "Added release notes.",
    });

    const healthy = await checkWiki(initialized.location);
    assert.equal(healthy.ok, true);
    assert.deepEqual(healthy.issues, []);

    await writePage(
      initialized.location,
      "notes/unsafe-link.md",
      "# Unsafe link\n[Outside](../../outside.md)\n",
    );
    await finalizeRun({
      location: initialized.location,
      command: "update",
      runId: "update-unsafe-link",
      startedAt: LATER,
      completedAt: LATER,
      summary: "Added link fixture.",
    });
    const brokenLink = await checkWiki(initialized.location);
    assert.equal(
      brokenLink.issues.some(
        (issue) => issue.code === "BROKEN_LINK" && issue.page === "notes/unsafe-link.md",
      ),
      true,
    );

    await rm(path.join(initialized.location.wikiRoot, "testing.md"));
    const unhealthy = await checkWiki(initialized.location);
    assert.equal(unhealthy.ok, false);
    assert.equal(
      unhealthy.issues.some((issue) => issue.code === "MISSING_PAGE" && issue.page === "testing.md"),
      true,
    );
  });

  test("storage: preserves state on no-op finalize and records changed content", async () => {
    const repository = await makeTemporaryRoot("finalize");
    const initialized = await initializeWiki({
      mode: "code",
      root: repository,
      now: NOW,
      runId: "init-finalize",
    });
    const serializedBefore = await readFile(initialized.location.statePath, "utf8");

    const noOp = await finalizeRun({
      location: initialized.location,
      command: "update",
      runId: "update-noop",
      startedAt: LATER,
      completedAt: LATER,
      summary: "No documentation changes.",
      lastGitHead: "b".repeat(40),
    });
    assert.equal(noOp.changed, false);
    assert.equal(await readFile(initialized.location.statePath, "utf8"), serializedBefore);
    assert.equal(noOp.state.lastRun.id, "init-finalize");

    await writePage(initialized.location, "architecture.md", "# Architecture\nUpdated boundary.\n");
    const changed = await finalizeRun({
      location: initialized.location,
      command: "update",
      runId: "update-changed",
      startedAt: LATER,
      completedAt: LATER,
      summary: "Updated architecture.",
      lastGitHead: "c".repeat(40),
    });
    assert.equal(changed.changed, true);
    assert.equal(changed.state.lastRun.id, "update-changed");
    assert.equal(changed.state.lastRun.changed, true);
    assert.equal(changed.state.lastGitHead, "c".repeat(40));
    assert.notEqual(changed.state.contentHash, initialized.state.contentHash);
  });

  test("storage: rejects missing and malformed state with typed errors", async () => {
    const repository = await makeTemporaryRoot("state-errors");
    const location = await resolveWikiLocation({ mode: "code", root: repository });
    await expectOpenWikiError(readState(location), "NOT_INITIALIZED");

    await mkdir(location.wikiRoot, { recursive: true });
    await writeFile(location.statePath, "{not-json", "utf8");
    await expectOpenWikiError(readState(location), "INVALID_STATE");
  });

  test("storage: rejects state copied from a different workspace", async () => {
    const firstRepository = await makeTemporaryRoot("state-origin");
    const secondRepository = await makeTemporaryRoot("state-destination");
    const first = await initializeWiki({
      mode: "code",
      root: firstRepository,
      now: NOW,
      runId: "state-origin",
    });
    const secondLocation = await resolveWikiLocation({
      mode: "code",
      root: secondRepository,
    });
    await mkdir(secondLocation.wikiRoot, { recursive: true });
    await writeFile(
      secondLocation.statePath,
      await readFile(first.location.statePath, "utf8"),
      "utf8",
    );

    await expectOpenWikiError(readState(secondLocation), "INVALID_STATE");
  });

  test("storage: serializes concurrent processes and never guesses stale lock ownership", async () => {
    const root = await makeTemporaryRoot("lock");
    const atomicModuleUrl = new URL("../../dist/atomic.js", import.meta.url).href;
    const childScript = `
      import { withWikiLock } from ${JSON.stringify(atomicModuleUrl)};
      await withWikiLock(${JSON.stringify(root)}, async () => {
        process.stdout.write("acquired\\n");
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOutput = "";
    await new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        childOutput += chunk;
        if (childOutput.includes("acquired\n")) {
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!childOutput.includes("acquired\n")) {
          reject(new Error(`Lock child exited before acquisition with code ${code}.`));
        }
      });
    });

    await expectOpenWikiError(withWikiLock(root, async () => undefined), "LOCKED");
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.equal(await withWikiLock(root, async () => "released"), "released");

    const staleLock = path.join(root, ".openwiki.lock");
    await writeFile(staleLock, '{"pid":999999,"createdAt":"2020-01-01T00:00:00.000Z"}\n');
    await expectOpenWikiError(withWikiLock(root, async () => undefined), "LOCKED");
    assert.equal((await stat(staleLock)).isFile(), true);
  });
});
