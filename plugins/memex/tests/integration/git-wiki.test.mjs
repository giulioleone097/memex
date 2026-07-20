import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";

import { MemexError } from "../../dist/errors.js";
import { collectGitContext, resolveRepositoryScope } from "../../dist/git.js";
import { checkWiki, initializeWiki } from "../../dist/wiki.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = [];

async function makeTemporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-${label}-`));
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
    await runGit(repository, ["config", "user.email", "memex@example.test"]);
    await runGit(repository, ["config", "user.name", "Memex Test"]);
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
      assert.ok(error instanceof MemexError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });

    await assert.rejects(collectGitContext(repository), (error) => {
      assert.ok(error instanceof MemexError);
      assert.equal(error.code, "GIT_FAILURE");
      assert.equal(error.message, "Unable to collect Git repository evidence.");
      assert.equal(error.message.includes(repository), false);
      return true;
    });
  });

  test("git-wiki: resolves a credential-free canonical repository scope across HTTPS and SSH origins", async () => {
    const repository = await makeTemporaryRoot("git-scope");
    await runGit(repository, ["init", "--initial-branch=main"]);
    await runGit(repository, ["remote", "add", "origin", "https://alice:top-secret@GitHub.COM/Org/Repo.git?access_token=query-secret"]);

    const httpsScope = await resolveRepositoryScope(repository);
    assert.equal(httpsScope, "git:github.com/Org/Repo");
    assert.equal(httpsScope.includes("alice"), false);
    assert.equal(httpsScope.includes("top-secret"), false);
    assert.equal(httpsScope.includes("query-secret"), false);

    await runGit(repository, ["remote", "set-url", "origin", "git@github.com:Org/Repo.git"]);
    assert.equal(await resolveRepositoryScope(repository), httpsScope, "HTTPS and SCP-style SSH origins must share one scope");

    await runGit(repository, ["remote", "set-url", "origin", "ssh://git@GITHUB.com/Org/Repo.git?ignored=ssh-secret"]);
    assert.equal(await resolveRepositoryScope(repository), httpsScope, "SSH URL origins must share the sanitized HTTPS scope");

    await runGit(repository, ["remote", "remove", "origin"]);
    assert.equal(await resolveRepositoryScope(repository), "memex:unscoped", "missing origin must not fall back to the workspace path");
  });

  test("git-wiki: succeeds with an explicit no-commits marker on an unborn-HEAD repository (DF-H1)", async () => {
    const repository = await makeTemporaryRoot("git-unborn");
    await runGit(repository, ["init", "--initial-branch=main"]);
    await runGit(repository, ["config", "user.email", "memex@example.test"]);
    await runGit(repository, ["config", "user.name", "Memex Test"]);
    await mkdir(path.join(repository, "src"));
    await writeFile(path.join(repository, "src", "app.ts"), "export const version = 1;\n");
    await runGit(repository, ["add", "src/app.ts"]);
    await writeFile(path.join(repository, "loose.txt"), "untracked\n");

    // No commit has been made: `git rev-parse HEAD` errors with an unborn-branch
    // failure. `context` must still succeed with machine-readable evidence of
    // the no-commits state instead of throwing GIT_FAILURE.
    const context = await collectGitContext(repository);
    assert.equal(context.hasCommits, false);
    assert.equal(Object.hasOwn(context, "head"), false);
    assert.equal(typeof context.noCommitsReason, "string");
    assert.match(context.noCommitsReason, /no commits/iu);
    assert.equal(context.branch, "main");
    assert.match(context.status, /src\/app\.ts/u);
    assert.match(context.status, /loose\.txt/u);
    // workingTreeChanges is diffed against the empty tree (no HEAD exists yet),
    // so it reports the staged file exactly like a real `diff --name-status HEAD`
    // would for a repository with commits (untracked, unstaged files never show
    // up in a diff — only in `status` — which mirrors existing behavior).
    assert.match(context.workingTreeChanges, /src\/app\.ts/u);
    assert.equal(context.workingTreeChanges.includes("loose.txt"), false);
    assert.deepEqual(context.changedPaths, []);
    assert.equal(context.recentCommits, "");
    assert.equal(context.commitsSincePreviousHead, "");

    // Once a commit exists, the normal (has-commits) evidence path resumes.
    const head = await commitAll(repository, "feat: initial commit");
    const afterCommit = await collectGitContext(repository);
    assert.equal(afterCommit.hasCommits, true);
    assert.equal(afterCommit.head, head);
    assert.equal(Object.hasOwn(afterCommit, "noCommitsReason"), false);
  });

  test("git-wiki: rejects a genuinely broken Git repository even with an unborn-HEAD-shaped root (DF-H1 boundary)", async () => {
    const notARepository = await makeTemporaryRoot("git-not-a-repo");
    await writeFile(path.join(notARepository, "file.txt"), "content\n");

    await assert.rejects(collectGitContext(notARepository), (error) => {
      assert.ok(error instanceof MemexError);
      assert.equal(error.code, "GIT_FAILURE");
      return true;
    });
  });
});
