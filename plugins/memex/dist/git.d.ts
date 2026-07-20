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
/**
 * Resolve a host-independent logical repository scope from the canonical
 * origin remote.  Missing, local-path, or malformed remotes fail closed to an
 * explicit unscoped value; the absolute workspace path is never an identity
 * input or a returned value.
 */
export declare function resolveRepositoryScope(root: string): Promise<string>;
export declare function collectGitContext(root: string, previousHead?: string): Promise<GitContext>;
