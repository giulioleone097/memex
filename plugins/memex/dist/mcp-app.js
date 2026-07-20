import { readFileSync } from "node:fs";
export const MEMEX_DASHBOARD_RESOURCE_URI = "ui://memex/dashboard.html";
export const MEMEX_DASHBOARD_MIME_TYPE = "text/html;profile=mcp-app";
export const RENDER_MEMEX_DASHBOARD_TOOL = "render_memex_dashboard";
const shortText = { type: "string", minLength: 1, maxLength: 120 };
const count = { type: "integer", minimum: 0, maximum: 1_000_000_000 };
const dashboardViewModelSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        mode: { type: "string", enum: ["code", "personal"] },
        workspace: shortText,
        health: { type: "string", enum: ["healthy", "degraded", "error", "unknown"] },
        state: { type: "string", enum: ["ready", "stale", "uninitialized", "locked", "error"] },
        freshness: {
            type: "object",
            additionalProperties: false,
            properties: {
                status: { type: "string", enum: ["current", "stale", "unknown"] },
                updatedAt: {
                    type: "string",
                    format: "date-time",
                    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
                },
            },
            required: ["status"],
        },
        graph: {
            type: "object",
            additionalProperties: false,
            properties: {
                available: { type: "boolean" },
                files: count,
                nodes: count,
                edges: count,
                unresolvedEdges: count,
            },
            required: ["available", "files", "nodes", "edges", "unresolvedEdges"],
        },
        evidence: {
            type: "array",
            maxItems: 20,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    label: shortText,
                    reference: { type: "string", minLength: 1, maxLength: 500 },
                },
                required: ["label", "reference"],
            },
        },
        diagnostics: {
            type: "array",
            maxItems: 20,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    severity: { type: "string", enum: ["info", "warning", "error"] },
                    code: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Z0-9_]+$" },
                    message: { type: "string", minLength: 1, maxLength: 500 },
                },
                required: ["severity", "code", "message"],
            },
        },
        retrievalHealth: { type: "object", additionalProperties: true },
    },
    required: ["mode", "workspace", "health", "state", "freshness", "graph", "evidence", "diagnostics"],
};
export const MEMEX_DASHBOARD_INPUT_SCHEMA = dashboardViewModelSchema;
export const MEMEX_DASHBOARD_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: { viewModel: dashboardViewModelSchema },
    required: ["viewModel"],
};
export const MEMEX_DASHBOARD_TOOL_META = {
    ui: { resourceUri: MEMEX_DASHBOARD_RESOURCE_URI, visibility: ["model"] },
    "openai/outputTemplate": MEMEX_DASHBOARD_RESOURCE_URI,
    "openai/toolInvocation/invoking": "Preparing Memex dashboard",
    "openai/toolInvocation/invoked": "Memex dashboard ready",
};
const resourceMeta = {
    ui: {
        csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
        },
        prefersBorder: true,
    },
    "openai/widgetDescription": "Read-only Memex workspace health, graph, evidence, and diagnostics dashboard.",
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": {
        connect_domains: [],
        resource_domains: [],
    },
};
export const MEMEX_DASHBOARD_RESOURCE = {
    uri: MEMEX_DASHBOARD_RESOURCE_URI,
    name: "Memex dashboard",
    description: "Bundled read-only dashboard for prepared Memex status and evidence.",
    mimeType: MEMEX_DASHBOARD_MIME_TYPE,
    _meta: resourceMeta,
};
const dashboardHtml = readFileSync(new URL("./ui/memex-dashboard.html", import.meta.url), "utf8");
export function readMemexDashboardResource() {
    return {
        contents: [{
                uri: MEMEX_DASHBOARD_RESOURCE_URI,
                name: MEMEX_DASHBOARD_RESOURCE.name,
                description: MEMEX_DASHBOARD_RESOURCE.description,
                mimeType: MEMEX_DASHBOARD_MIME_TYPE,
                text: dashboardHtml,
                _meta: resourceMeta,
            }],
    };
}
export function parseDashboardViewModel(value) {
    if (!hasRequiredKeys(value, ["mode", "workspace", "health", "state", "freshness", "graph", "evidence", "diagnostics"], ["retrievalHealth"]))
        return undefined;
    if (!isOneOf(value.mode, ["code", "personal"]) || !isBoundedString(value.workspace, 1, 120))
        return undefined;
    if (!isOneOf(value.health, ["healthy", "degraded", "error", "unknown"]))
        return undefined;
    if (!isOneOf(value.state, ["ready", "stale", "uninitialized", "locked", "error"]))
        return undefined;
    if (!hasOnlyKeys(value.freshness, ["status", "updatedAt"]))
        return undefined;
    if (!isOneOf(value.freshness.status, ["current", "stale", "unknown"]))
        return undefined;
    if (value.freshness.updatedAt !== undefined && !isCanonicalTimestamp(value.freshness.updatedAt))
        return undefined;
    if (!hasExactKeys(value.graph, ["available", "files", "nodes", "edges", "unresolvedEdges"]))
        return undefined;
    if (typeof value.graph.available !== "boolean")
        return undefined;
    for (const key of ["files", "nodes", "edges", "unresolvedEdges"]) {
        if (!isCount(value.graph[key]))
            return undefined;
    }
    if (!Array.isArray(value.evidence) || value.evidence.length > 20 || !value.evidence.every(isEvidence))
        return undefined;
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 20 || !value.diagnostics.every(isDiagnostic))
        return undefined;
    if (value.retrievalHealth !== undefined && !isRecord(value.retrievalHealth))
        return undefined;
    return value;
}
function hasRequiredKeys(value, required, optional = []) {
    return isRecord(value)
        && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
        && required.every((key) => Object.hasOwn(value, key));
}
function hasOnlyKeys(value, allowed) {
    return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function hasExactKeys(value, expected) {
    return hasOnlyKeys(value, expected) && expected.every((key) => Object.hasOwn(value, key));
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isOneOf(value, options) {
    return typeof value === "string" && options.some((option) => option === value);
}
function isBoundedString(value, minimum, maximum) {
    return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function isCanonicalTimestamp(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
        return false;
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}
function isCount(value) {
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000;
}
function isEvidence(value) {
    return hasExactKeys(value, ["label", "reference"])
        && isBoundedString(value.label, 1, 120)
        && isBoundedString(value.reference, 1, 500);
}
function isDiagnostic(value) {
    return hasExactKeys(value, ["severity", "code", "message"])
        && isOneOf(value.severity, ["info", "warning", "error"])
        && isBoundedString(value.code, 1, 64)
        && /^[A-Z0-9_]+$/u.test(value.code)
        && isBoundedString(value.message, 1, 500);
}
