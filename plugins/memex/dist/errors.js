export const MEMEX_ERROR_CODES = [
    "INVALID_ARGUMENT",
    "INVALID_STATE",
    "PATH_OUTSIDE_ROOT",
    "SYMLINK_ESCAPE",
    "LOCKED",
    "NOT_INITIALIZED",
    "NOT_FOUND",
    "SOURCE_TOO_LARGE",
    "UNSUPPORTED_SOURCE",
    "MISSING_HOST_CAPABILITY",
    "GIT_FAILURE",
    "IO_FAILURE",
    "MODEL_ASSET_MISSING",
    "MODEL_ASSET_CORRUPT",
    "EMBEDDING_FAILURE",
    "INDEX_INCOMPATIBLE",
    "MIGRATION_CONFLICT",
    "GRAPH_CYPHER_READONLY",
    "GRAPH_CYPHER_UNAVAILABLE",
    "GRAPH_CYPHER_FAILED",
];
export class MemexError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "MemexError";
        this.code = code;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
        };
    }
}
