import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";

import { OpenWikiError } from "../../dist/errors.js";
import { collectGitContext } from "../../dist/git.js";
import { checkWiki, initializeWiki } from "../../dist/wiki.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = [];

async function makeTemporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function runGit(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

async function commitAll(root, message) {
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("git-wiki", () => {
  test("git-wiki: collects bounded evidence from a real repository with changes", async () => {
    const parent = await makeTemporaryRoot("git-parent");
    const repository = path.join(parent, "repository with spaces $() [safe]");
    await mkdir(repository);
    await runGit(repository, ["init", "--initial-branch=main"]);
    await runGit(repository, ["config", "user.email", "openwiki@example.test"]);
    await runGit(repository, ["config", "user.name", "OpenWiki Test"]);
    await mkdir(path.join(repository, "src"));
    await writeFile(path.join(repository, "src", "app.ts"), "export const version = 1;\n");
    const initialHead = await commitAll(repository, "feat: initial application");

    const initial = await collectGitContext(repository);
    assert.equal(initial.branch, "main");
    assert.equal(initial.head, initialHead);
    assert.equal(initial.status, "");
    assert.match(initial.recentCommits, /initial application/u);

    await writeFile(path.join(repository, "src", "app.ts"), "export const version = 2;\n");
    await writeFile(path.join(repository, "release notes; safe.md"), "# Release\n");
    const dirty = await collectGitContext(repository, initialHead);
    assert.match(dirty.status, /src\/app\.ts/u);
    assert.match(dirty.status, /release notes; safe\.md/u);
    assert.match(dirty.workingTreeChanges, /src\/app\.ts/u);

    const nextHead = await commitAll(repository, "feat: release version two");
    const updated = await collectGitContext(repository, initialHead);
    assert.equal(updated.head, nextHead);
    assert.match(updated.commitsSincePreviousHead, /release version two/u);
    assert.deepEqual(updated.changedPaths.sort(), ["release notes; safe.md", "src/app.ts"]);

    const initialized = await initializeWiki({
      mode: "code",
      root: repository,
      now: "2026-07-11T10:15:30.000Z",
      runId: "git-wiki-init",
    });
    assert.equal((await checkWiki(initialized.location)).ok, true);
  });

  test("git-wiki: rejects unsafe previous heads and sanitizes Git failures", async () => {
    const repository = await makeTemporaryRoot("git-errors");

    await assert.rejects(collectGitContext(repository, "--help"), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });

    await assert.rejects(collectGitContext(repository), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "GIT_FAILURE");
      assert.equal(error.message, "Unable to collect Git repository evidence.");
      assert.equal(error.message.includes(repository), false);
      return true;
    });
  });
});
