export declare const OPENWIKI_ERROR_CODES: readonly ["INVALID_ARGUMENT", "INVALID_STATE", "PATH_OUTSIDE_ROOT", "SYMLINK_ESCAPE", "LOCKED", "NOT_INITIALIZED", "NOT_FOUND", "SOURCE_TOO_LARGE", "UNSUPPORTED_SOURCE", "MISSING_HOST_CAPABILITY", "GIT_FAILURE", "IO_FAILURE"];
export type OpenWikiErrorCode = (typeof OPENWIKI_ERROR_CODES)[number];
export type OpenWikiErrorJson = Readonly<{
    code: OpenWikiErrorCode;
    message: string;
}>;
export type OpenWikiJsonSuccess<T> = Readonly<{
    ok: true;
    data: T;
}>;
export type OpenWikiJsonFailure = Readonly<{
    ok: false;
    error: OpenWikiErrorJson;
}>;
export type OpenWikiJsonResult<T> = OpenWikiJsonSuccess<T> | OpenWikiJsonFailure;
export declare class OpenWikiError extends Error {
    readonly code: OpenWikiErrorCode;
    constructor(code: OpenWikiErrorCode, message: string);
    toJSON(): OpenWikiErrorJson;
}
