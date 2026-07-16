import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

import { OpenWikiError } from "./errors.js";

export const GIT_COMMAND_TIMEOUT_MS = 15_000;
export const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

// The empty tree is a well-known, deterministic SHA-1 object ID present in every
// Git repository (the hash of an empty tree object). It stands in for "HEAD" when
// a repository has no commits yet, so working-tree changes can still be diffed
// against "nothing" instead of a commit that does not exist. Every commit hash
// this module accepts or produces elsewhere is likewise assumed to be SHA-1
// (see the `previousHead` format check below), so this constant does not need a
// SHA-256 repository variant.
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitContext {
  root: string;
  branch: string;
  /** Absent when the repository has no commits yet (see `hasCommits`). */
  head?: string;
  /** Machine-readable evidence of whether HEAD resolves to a commit. */
  hasCommits: boolean;
  /** Present only when `hasCommits` is false; explains why `head` is absent. */
  noCommitsReason?: string;
  status: string;
  recentCommits: string;
  workingTreeChanges: string;
  commitsSincePreviousHead: string;
  changedPaths: string[];
  previousHead?: string;
}

interface OutputBudget {
  used: number;
}

export async function collectGitContext(
  root: string,
  previousHead?: string,
): Promise<GitContext> {
  if (
    previousHead !== undefined &&
    !/^[a-f0-9]{40}$/iu.test(previousHead)
  ) {
    throw new OpenWikiError(
      "INVALID_ARGUMENT",
      "Previous Git HEAD must be a full commit hash.",
    );
  }

  try {
    const canonicalInput = await realpath(root);
    const budget: OutputBudget = { used: 0 };
    const discoveredRoot = await runGit(
      canonicalInput,
      ["rev-parse", "--show-toplevel"],
      budget,
    );
    const canonicalRoot = await realpath(discoveredRoot);
    const hasCommits = await hasResolvableHead(canonicalRoot, budget);
    const status = await runGit(
      canonicalRoot,
      ["status", "--short", "--untracked-files=all"],
      budget,
    );

    if (!hasCommits) {
      // Unborn HEAD: the repository exists and has a current branch, but no
      // commit has been made yet. `rev-parse HEAD`/`log`/`diff HEAD` all fail
      // in this state, so evidence is built from commands that do not require
      // a resolvable HEAD, and the absence of commits is reported explicitly
      // instead of surfacing those failures as GIT_FAILURE.
      const branch = await runGit(
        canonicalRoot,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        budget,
      ).catch(() => "");
      const workingTreeChanges = await runGit(
        canonicalRoot,
        ["diff", "--name-status", EMPTY_TREE_HASH],
        budget,
      );
      return {
        root: canonicalRoot,
        branch,
        hasCommits: false,
        noCommitsReason: "Repository has no commits yet (unborn HEAD).",
        status,
        recentCommits: "",
        workingTreeChanges,
        commitsSincePreviousHead: "",
        changedPaths: [],
        ...(previousHead === undefined ? {} : { previousHead }),
      };
    }

    const branch = await runGit(
      canonicalRoot,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      budget,
    );
    const head = await runGit(
      canonicalRoot,
      ["rev-parse", "HEAD"],
      budget,
    );
    const recentCommits = await runGit(
      canonicalRoot,
      [
        "log",
        "--max-count=20",
        "--name-status",
        "--format=%H%x09%cI%x09%s",
      ],
      budget,
    );
    const workingTreeChanges = await runGit(
      canonicalRoot,
      ["diff", "--name-status", "HEAD"],
      budget,
    );
    const commitsSincePreviousHead = previousHead
      ? await runGit(
          canonicalRoot,
          [
            "log",
            `${previousHead}..HEAD`,
            "--name-status",
            "--format=%H%x09%cI%x09%s",
          ],
          budget,
        )
      : recentCommits;
    const changedPathOutput = previousHead
      ? await runGit(
          canonicalRoot,
          ["diff", "--name-only", `${previousHead}..HEAD`],
          budget,
        )
      : await runGit(
          canonicalRoot,
          ["log", "--max-count=20", "--name-only", "--format="],
          budget,
        );
    const changedPaths = [
      ...new Set(
        changedPathOutput
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ].sort((left, right) => left.localeCompare(right));

    return {
      root: canonicalRoot,
      branch,
      head,
      hasCommits: true,
      status,
      recentCommits,
      workingTreeChanges,
      commitsSincePreviousHead,
      changedPaths,
      ...(previousHead === undefined ? {} : { previousHead }),
    };
  } catch (error) {
    if (error instanceof OpenWikiError && error.code === "INVALID_ARGUMENT") {
      throw error;
    }
    throw new OpenWikiError(
      "GIT_FAILURE",
      "Unable to collect Git repository evidence.",
    );
  }
}

/**
 * Resolves whether HEAD points at an existing commit, without throwing for the
 * legitimate "no commits yet" case. Uses `--quiet` so an unborn HEAD exits
 * non-zero silently (no stderr noise) rather than emitting a Git error.
 */
function hasResolvableHead(
  cwd: string,
  budget: OutputBudget,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let settled = false;

    const fail = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Git command failed."));
    };

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      budget.used += chunk.byteLength;
      if (budget.used > GIT_OUTPUT_LIMIT_BYTES) {
        fail();
      }
    });
    child.once("error", fail);

    const timeout = setTimeout(fail, GIT_COMMAND_TIMEOUT_MS);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve(code === 0);
    });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  budget: OutputBudget,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let settled = false;

    const fail = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Git command failed."));
    };

    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) {
        return;
      }
      budget.used += chunk.byteLength;
      if (budget.used > GIT_OUTPUT_LIMIT_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture([], chunk);
    });
    child.once("error", fail);

    const timeout = setTimeout(fail, GIT_COMMAND_TIMEOUT_MS);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (code !== 0) {
        reject(new Error("Git command failed."));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}
