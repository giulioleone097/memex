export const OPENWIKI_ERROR_CODES = [
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
];
export class OpenWikiError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "OpenWikiError";
        this.code = code;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
        };
    }
}
