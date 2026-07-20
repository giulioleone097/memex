export declare const MEMEX_DASHBOARD_RESOURCE_URI = "ui://memex/dashboard.html";
export declare const MEMEX_DASHBOARD_MIME_TYPE = "text/html;profile=mcp-app";
export declare const RENDER_MEMEX_DASHBOARD_TOOL = "render_memex_dashboard";
type JsonRecord = Record<string, unknown>;
export interface DashboardViewModel {
    mode: "code" | "personal";
    workspace: string;
    health: "healthy" | "degraded" | "error" | "unknown";
    state: "ready" | "stale" | "uninitialized" | "locked" | "error";
    freshness: {
        status: "current" | "stale" | "unknown";
        updatedAt?: string;
    };
    graph: {
        available: boolean;
        files: number;
        nodes: number;
        edges: number;
        unresolvedEdges: number;
    };
    evidence: Array<{
        label: string;
        reference: string;
    }>;
    diagnostics: Array<{
        severity: "info" | "warning" | "error";
        code: string;
        message: string;
    }>;
    /** Optional additive detail; legacy dashboard summaries remain valid. */
    retrievalHealth?: JsonRecord;
}
export declare const MEMEX_DASHBOARD_INPUT_SCHEMA: JsonRecord;
export declare const MEMEX_DASHBOARD_OUTPUT_SCHEMA: JsonRecord;
export declare const MEMEX_DASHBOARD_TOOL_META: JsonRecord;
export declare const MEMEX_DASHBOARD_RESOURCE: {
    readonly uri: "ui://memex/dashboard.html";
    readonly name: "Memex dashboard";
    readonly description: "Bundled read-only dashboard for prepared Memex status and evidence.";
    readonly mimeType: "text/html;profile=mcp-app";
    readonly _meta: JsonRecord;
};
export declare function readMemexDashboardResource(): JsonRecord;
export declare function parseDashboardViewModel(value: unknown): DashboardViewModel | undefined;
export {};
