import { type WikiStateV1 } from "./contracts.js";
import type { WikiLocation } from "./paths.js";
export declare function readState(location: WikiLocation): Promise<WikiStateV1>;
export declare function writeState(location: WikiLocation, state: WikiStateV1): Promise<void>;
export declare function tryReadState(location: WikiLocation): Promise<WikiStateV1 | null>;
