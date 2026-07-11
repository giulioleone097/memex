import type { GraphDiagnosticV1, GraphEdgeKind } from "./graph-contracts.js";

export interface ScannedSymbol { name: string; qualifiedName?: string; scope?: string; kind: string; startLine: number; endLine: number; exported: boolean; }
export interface ScannedRelation { kind: Extract<GraphEdgeKind, "calls" | "inherits" | "implements" | "references">; fromQualifiedName: string; target: string; line: number; confidence: "resolved" | "heuristic"; }
export interface SourceScan { symbols: ScannedSymbol[]; relations?: ScannedRelation[]; imports: string[]; exports: string[]; calls: string[]; inherits: string[]; implements: string[]; references: string[]; diagnostics: GraphDiagnosticV1[]; }
export interface ScanSourceFileOptions { path: string; language: string; content: string; }

const EXTENSIONS: Readonly<Record<string, string>> = { ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", cs: "csharp", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", rb: "ruby", php: "php", sh: "shell", bash: "shell", zsh: "shell", md: "markdown", mdx: "markdown", json: "json", yaml: "yaml", yml: "yaml", toml: "toml" };
const CALL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "def", "class", "return", "new", "typeof", "sizeof", "echo", "print", "import", "from", "extends", "implements"]);
const DECLARATION = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|fn|func|def)\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|struct|enum|trait|module)\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu;

export function detectLanguage(filePath: string): string { const leaf = filePath.split("/").at(-1) ?? ""; const extension = leaf.includes(".") ? leaf.split(".").at(-1)?.toLowerCase() : undefined; return extension === undefined ? "text" : (EXTENSIONS[extension] ?? "text"); }

export function scanSourceFile(options: ScanSourceFileOptions): SourceScan {
  const moduleSpecifiers = extractModuleSpecifiers(options.content);
  const sanitized = stripCommentsAndLiterals(options.content, options.language);
  const lines = sanitized.split(/\r?\n/u);
  const symbols: ScannedSymbol[] = [];
  const relations: ScannedRelation[] = [];
  const imports = new Set(moduleSpecifiers); const exports = new Set<string>(); const calls = new Set<string>(); const inherits = new Set<string>(); const implementations = new Set<string>(); const references = new Set<string>();
  const scopes: Array<{ symbol: ScannedSymbol; braceDepth: number; indent: number; python: boolean }> = [];
  let braceDepth = 0;
  const add = (name: string, kind: string, index: number, exported: boolean, scope = ""): ScannedSymbol => {
    const qualifiedName = scope.length === 0 ? name : `${scope}.${name}`;
    const existing = symbols.find((symbol) => symbol.qualifiedName === qualifiedName && symbol.kind === kind && symbol.startLine === index + 1);
    if (existing) return existing;
    const symbol = { name, qualifiedName, scope, kind, startLine: index + 1, endLine: index + 1, exported };
    symbols.push(symbol); if (exported) exports.add(name); return symbol;
  };
  const ownerAt = (): ScannedSymbol | undefined => scopes.at(-1)?.symbol;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (options.language === "python" && line.trim().length > 0) while (scopes.at(-1)?.python === true && indent <= (scopes.at(-1)?.indent ?? 0)) scopes.pop();
    let braceDelta = 0; for (const char of line) braceDelta += char === "{" ? 1 : char === "}" ? -1 : 0;
    const nextBraceDepth = braceDepth + braceDelta;
    const registerScope = (symbol: ScannedSymbol, opens: boolean): void => { if (!opens || !["function", "method", "type"].includes(symbol.kind) || scopes.some((scope) => scope.symbol === symbol)) return; scopes.push({ symbol, braceDepth: options.language === "python" ? braceDepth : nextBraceDepth > braceDepth ? nextBraceDepth : braceDepth + 1, indent, python: options.language === "python" }); };
    const classMatches = [...line.matchAll(/\b(?:class|interface|struct|trait)\s+([A-Za-z_$][\w$]*)/gu)];
    for (const match of line.matchAll(DECLARATION)) { const name = (match[1] ?? match[2] ?? match[3]) as string; const kind = match[1] ? "function" : match[2] ? "type" : "variable"; const symbol = add(name, kind, index, /\bexport\b/u.test(line), scopes.at(-1)?.symbol.qualifiedName ?? ""); registerScope(symbol, /[{:]/u.test(line.slice(match.index))); }
    const classScope = classMatches.at(-1)?.[1] ?? scopes.at(-1)?.symbol.qualifiedName ?? "";
    for (const match of line.matchAll(/\b(?:void|int|char|float|double|bool|auto|public|private|protected|static|final|fun)\s+([A-Za-z_$][\w$]*)\s*\(/gu)) { const symbol = add(match[1] as string, "method", index, false, classScope); registerScope(symbol, /[{:]/u.test(line.slice(match.index))); }
    if (options.language !== "text" && options.language !== "markdown" && options.language !== "json" && options.language !== "yaml" && options.language !== "toml") for (const match of line.matchAll(/(?:^\s*|[;{}]\s*)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|=>|:)/gu)) {
      const name = match[1] as string;
      if (!CALL_KEYWORDS.has(name) && !/\b(?:function|def|func|fn)\s*$/u.test(line.slice(0, match.index))) { const symbol = add(name, "method", index, false, classScope); registerScope(symbol, true); }
    }
    const classOwner = classMatches.length > 0 ? symbols.find((symbol) => symbol.name === classMatches.at(-1)?.[1] && symbol.startLine === lineNumber) : undefined;
    for (const match of line.matchAll(/\b(?:class|interface)\s+[A-Za-z_$][\w$]*(?:\s+extends\s+([A-Za-z_$][\w$.]*))?(?:\s+implements\s+([A-Za-z_$][\w$.,\s]*))?/gu)) {
      if (match[1]) { inherits.add(match[1]); addRelation(relations, "inherits", classOwner?.qualifiedName ?? "", match[1], lineNumber, "resolved"); }
      if (match[2]) for (const item of match[2].split(",").map((value) => value.trim()).filter(Boolean)) { implementations.add(item); addRelation(relations, "implements", classOwner?.qualifiedName ?? "", item, lineNumber, "resolved"); }
    }
    for (const match of line.matchAll(/\bclass\s+[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$.,\s]*)\s*\)/gu)) for (const item of (match[1] as string).split(",").map((value) => value.trim()).filter(Boolean)) { inherits.add(item); addRelation(relations, "inherits", classOwner?.qualifiedName ?? "", item, lineNumber, "heuristic"); }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) { const name = match[1] as string; const prefix = line.slice(0, match.index); const suffix = line.slice(match.index + match[0].length); const declaration = /\b(?:function|def|func|fn|class)\s*$/u.test(prefix) || /^\s*[^)]*\)\s*(?:\{|=>|:)/u.test(suffix); if (!CALL_KEYWORDS.has(name) && !declaration) { calls.add(name); const owner = ownerAt(); if (owner) addRelation(relations, "calls", owner.qualifiedName ?? owner.name, name, lineNumber, "resolved"); } }
    for (const match of line.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/gu)) { const name = match[1] as string; references.add(name); const owner = ownerAt(); if (owner && name !== owner.name) addRelation(relations, "references", owner.qualifiedName ?? owner.name, name, lineNumber, "heuristic"); }
    braceDepth = Math.max(0, nextBraceDepth); while (scopes.at(-1)?.python === false && (scopes.at(-1)?.braceDepth ?? 0) > braceDepth) scopes.pop();
  }
  const diagnostics: GraphDiagnosticV1[] = [];
  if (["markdown", "json", "yaml", "toml", "text"].includes(options.language)) diagnostics.push({ path: options.path, code: "LEXICAL_FILE_ONLY", message: "This language tier is file-only; semantic relations are not inferred." });
  return { symbols: symbols.sort(symbolOrder), relations: relations.sort(relationOrder), imports: [...imports].sort(), exports: [...exports].sort(), calls: [...calls].sort(), inherits: [...inherits].sort(), implements: [...implementations].sort(), references: [...references].filter((name) => !symbols.some((symbol) => symbol.name === name)).sort(), diagnostics };
}

function addRelation(relations: ScannedRelation[], kind: ScannedRelation["kind"], fromQualifiedName: string, target: string, line: number, confidence: ScannedRelation["confidence"]): void { if (fromQualifiedName.length > 0 && target.length > 0 && !relations.some((relation) => relation.kind === kind && relation.fromQualifiedName === fromQualifiedName && relation.target === target && relation.line === line)) relations.push({ kind, fromQualifiedName, target, line, confidence }); }
function extractModuleSpecifiers(content: string): string[] { const commentFree = stripCommentsAndLiterals(content, "text"); const result = new Set<string>(); for (const match of content.matchAll(/\bimport\s+(?:[^;\n]*?\s+from\s+)?["']([^"'\r\n]+)["']|\bexport\s+[^;\n]*?\s+from\s+["']([^"'\r\n]+)["']|\bfrom\s+([A-Za-z0-9_./-]+)\s+import\b|\brequire\(\s*["']([^"'\r\n]+)["']\s*\)/gu)) { const index = match.index; if (commentFree.slice(index, index + match[0].length).trim().length > 0) result.add((match[1] ?? match[2] ?? match[3] ?? match[4]) as string); } return [...result].sort(); }
export function stripCommentsAndLiterals(content: string, language: string): string { let output = ""; let quote: string | undefined; let lineComment = false; let blockComment = false; for (let index = 0; index < content.length; index += 1) { const char = content[index] as string; const next = content[index + 1] ?? ""; if (lineComment) { if (char === "\n") { lineComment = false; output += "\n"; } else output += " "; continue; } if (blockComment) { if (char === "*" && next === "/") { output += "  "; index += 1; blockComment = false; } else output += char === "\n" ? "\n" : " "; continue; } if (quote) { if (char === "\\") { output += " "; if (next) { output += next === "\n" ? "\n" : " "; index += 1; } continue; } if (char === quote) { output += " "; quote = undefined; } else output += char === "\n" ? "\n" : " "; continue; } if ((char === "/" && next === "/") || (char === "#" && language !== "csharp" && language !== "c" && language !== "cpp")) { output += "  "; index += 1; lineComment = true; continue; } if (char === "/" && next === "*") { output += "  "; index += 1; blockComment = true; continue; } if (char === "\"" || char === "'" || char === "`") { quote = char; output += " "; continue; } output += char; } return output; }
function symbolOrder(left: ScannedSymbol, right: ScannedSymbol): number { return left.startLine - right.startLine || (left.qualifiedName ?? left.name).localeCompare(right.qualifiedName ?? right.name) || left.kind.localeCompare(right.kind); }
function relationOrder(left: ScannedRelation, right: ScannedRelation): number { return left.line - right.line || left.fromQualifiedName.localeCompare(right.fromQualifiedName) || left.kind.localeCompare(right.kind) || left.target.localeCompare(right.target); }
