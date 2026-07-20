import { type WikiStateV1 } from "./contracts.js";
import type { WikiLocation } from "./paths.js";
export declare function readState(location: WikiLocation): Promise<WikiStateV1>;
/** Persist a legacy v1 state as portable v2 at an explicit locked mutation boundary. */
export declare function readStateForWrite(location: WikiLocation): Promise<WikiStateV1>;
export declare function writeState(location: WikiLocation, state: WikiStateV1): Promise<void>;
export declare function tryReadState(location: WikiLocation): Promise<WikiStateV1 | null>;
export declare function tryReadStateForWrite(location: WikiLocation): Promise<WikiStateV1 | null>;
