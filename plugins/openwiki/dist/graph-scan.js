const EXTENSIONS = { ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", cs: "csharp", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", rb: "ruby", php: "php", sh: "shell", bash: "shell", zsh: "shell", md: "markdown", mdx: "markdown", json: "json", yaml: "yaml", yml: "yaml", toml: "toml" };
const CALL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "def", "class", "return", "new", "typeof", "sizeof", "echo", "print", "import", "from", "extends", "implements"]);
export function detectLanguage(filePath) { const leaf = filePath.split("/").at(-1) ?? ""; const extension = leaf.includes(".") ? leaf.split(".").at(-1)?.toLowerCase() : undefined; return extension === undefined ? "text" : (EXTENSIONS[extension] ?? "text"); }
export function scanSourceFile(options) {
    const moduleSpecifiers = extractModuleSpecifiers(options.content);
    const sanitized = stripCommentsAndLiterals(options.content, options.language);
    const lines = sanitized.split(/\r?\n/u);
    const symbols = [];
    const imports = new Set();
    const exports = new Set();
    const calls = new Set();
    const inherits = new Set();
    const implementations = new Set();
    const references = new Set();
    const add = (name, kind, index, exported) => { if (!symbols.some((symbol) => symbol.name === name && symbol.kind === kind && symbol.startLine === index + 1))
        symbols.push({ name, kind, startLine: index + 1, endLine: index + 1, exported }); if (exported)
        exports.add(name); };
    for (const specifier of moduleSpecifiers)
        imports.add(specifier);
    for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|fn|func|def)\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|struct|enum|trait|module)\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
            const name = (match[1] ?? match[2] ?? match[3]);
            const kind = match[1] ? "function" : match[2] ? "type" : "variable";
            add(name, kind, index, /\bexport\b/u.test(line));
        }
        if (options.language === "typescript" || options.language === "javascript")
            for (const match of line.matchAll(/(?:^|[;{}])\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu))
                add(match[1], "method", index, false);
        for (const match of line.matchAll(/\b(?:class|interface)\s+[A-Za-z_$][\w$]*(?:\s+extends\s+([A-Za-z_$][\w$.]*))?(?:\s+implements\s+([A-Za-z_$][\w$.,\s]*))?/gu)) {
            if (match[1])
                inherits.add(match[1]);
            if (match[2])
                for (const item of match[2].split(","))
                    implementations.add(item.trim());
        }
        for (const match of line.matchAll(/\bclass\s+[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$.,\s]*)\s*\)/gu))
            for (const item of match[1].split(","))
                inherits.add(item.trim());
        for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
            const name = match[1];
            const prefix = line.slice(0, match.index);
            const suffix = line.slice(match.index + match[0].length);
            const declaration = /\b(?:function|def|func|fn|class)\s*$/u.test(prefix) || /^\s*[^)]*\)\s*\{/u.test(suffix);
            if (!CALL_KEYWORDS.has(name) && !declaration)
                calls.add(name);
        }
        for (const match of line.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/gu))
            references.add(match[1]);
    }
    return { symbols: symbols.sort(symbolOrder), imports: [...imports].sort(), exports: [...exports].sort(), calls: [...calls].sort(), inherits: [...inherits].filter(Boolean).sort(), implements: [...implementations].filter(Boolean).sort(), references: [...references].filter((name) => !symbols.some((symbol) => symbol.name === name)).sort(), diagnostics: [] };
}
function extractModuleSpecifiers(content) {
    const commentFree = stripCommentsAndLiterals(content, "text");
    const result = new Set();
    for (const match of content.matchAll(/\bimport\s+(?:[^;\n]*?\s+from\s+)?["']([^"'\r\n]+)["']|\bexport\s+[^;\n]*?\s+from\s+["']([^"'\r\n]+)["']|\bfrom\s+([A-Za-z0-9_./-]+)\s+import\b|\brequire\(\s*["']([^"'\r\n]+)["']\s*\)/gu)) {
        const index = match.index;
        if (commentFree.slice(index, index + match[0].length).trim().length > 0)
            result.add((match[1] ?? match[2] ?? match[3] ?? match[4]));
    }
    return [...result].sort();
}
export function stripCommentsAndLiterals(content, language) {
    let output = "";
    let quote;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];
        const next = content[index + 1] ?? "";
        if (lineComment) {
            if (char === "\n") {
                lineComment = false;
                output += "\n";
            }
            else
                output += " ";
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                output += "  ";
                index += 1;
                blockComment = false;
            }
            else
                output += char === "\n" ? "\n" : " ";
            continue;
        }
        if (quote) {
            if (char === "\\") {
                output += " ";
                if (next) {
                    output += next === "\n" ? "\n" : " ";
                    index += 1;
                }
                continue;
            }
            if (char === quote) {
                output += " ";
                quote = undefined;
            }
            else
                output += char === "\n" ? "\n" : " ";
            continue;
        }
        if ((char === "/" && next === "/") || (char === "#" && language !== "csharp" && language !== "c" && language !== "cpp")) {
            output += "  ";
            index += 1;
            lineComment = true;
            continue;
        }
        if (char === "/" && next === "*") {
            output += "  ";
            index += 1;
            blockComment = true;
            continue;
        }
        if (char === "\"" || char === "'" || char === "`") {
            quote = char;
            output += " ";
            continue;
        }
        output += char;
    }
    return output;
}
function symbolOrder(left, right) { return left.startLine - right.startLine || left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind); }
