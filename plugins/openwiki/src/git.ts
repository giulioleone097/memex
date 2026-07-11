import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

import { OpenWikiError } from "./errors.js";

export const GIT_COMMAND_TIMEOUT_MS = 15_000;
export const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface GitContext {
  root: string;
  branch: string;
  head: string;
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
    const status = await runGit(
      canonicalRoot,
      ["status", "--short", "--untracked-files=all"],
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
