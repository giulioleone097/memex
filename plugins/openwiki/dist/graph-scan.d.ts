import type { GraphDiagnosticV1 } from "./graph-contracts.js";
export interface ScannedSymbol {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    exported: boolean;
}
export interface SourceScan {
    symbols: ScannedSymbol[];
    imports: string[];
    exports: string[];
    calls: string[];
    inherits: string[];
    implements: string[];
    references: string[];
    diagnostics: GraphDiagnosticV1[];
}
export interface ScanSourceFileOptions {
    path: string;
    language: string;
    content: string;
}
export declare function detectLanguage(filePath: string): string;
export declare function scanSourceFile(options: ScanSourceFileOptions): SourceScan;
export declare function stripCommentsAndLiterals(content: string, language: string): string;
