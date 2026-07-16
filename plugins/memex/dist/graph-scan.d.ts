import type { GraphDiagnosticV1, GraphEdgeKind } from "./graph-contracts.js";
export interface ScannedSymbol {
    name: string;
    qualifiedName?: string;
    scope?: string;
    kind: string;
    startLine: number;
    endLine: number;
    exported: boolean;
}
export interface ScannedRelation {
    kind: Extract<GraphEdgeKind, "calls" | "inherits" | "implements" | "references">;
    fromQualifiedName: string;
    target: string;
    line: number;
    confidence: "resolved" | "heuristic";
}
export interface SourceScan {
    symbols: ScannedSymbol[];
    relations?: ScannedRelation[];
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
