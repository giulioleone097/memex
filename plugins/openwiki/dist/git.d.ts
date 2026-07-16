export declare const GIT_COMMAND_TIMEOUT_MS = 15000;
export declare const GIT_OUTPUT_LIMIT_BYTES: number;
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
export declare function collectGitContext(root: string, previousHead?: string): Promise<GitContext>;
