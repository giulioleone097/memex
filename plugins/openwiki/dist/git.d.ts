export declare const GIT_COMMAND_TIMEOUT_MS = 15000;
export declare const GIT_OUTPUT_LIMIT_BYTES: number;
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
export declare function collectGitContext(root: string, previousHead?: string): Promise<GitContext>;
