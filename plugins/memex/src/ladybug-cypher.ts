// Pure, WASM-free Cypher/DDL/parameter/row builders for the LadybugDB tier.
// No I/O, no engine dependency — unit-testable in isolation and reused by both
// the wasm and native connection adapters and by the equivalence oracle.
import type { GraphNodeV1, GraphEdgeV1, GraphNodeKind, GraphEdgeKind, GraphConfidence } from "./graph-contracts.js";
import type { CypherScalar } from "./graph-index.js";

/** Schema mirroring the CodeGraphV1 node/edge model (see design §5). */
export const LADYBUG_SCHEMA_DDL: readonly string[] = [
  "CREATE NODE TABLE IF NOT EXISTS Node("
    + "id STRING PRIMARY KEY, kind STRING, path STRING, name STRING, "
    + "scope STRING, symbolKind STRING, startLine INT64, endLine INT64, summary STRING)",
  "CREATE REL TABLE IF NOT EXISTS Edge(FROM Node TO Node, id STRING, kind STRING, confidence STRING)",
];

const NODE_RETURN =
  "n.id AS id, n.kind AS kind, n.path AS path, n.name AS name, n.scope AS scope, "
  + "n.symbolKind AS symbolKind, n.startLine AS startLine, n.endLine AS endLine, n.summary AS summary";

export const NODE_BY_ID_CYPHER = `MATCH (n:Node {id: $id}) RETURN ${NODE_RETURN}`;

export function adjacencyCypher(direction: "inbound" | "outbound"): string {
  const pattern = direction === "outbound"
    ? "(n:Node {id: $id})-[e:Edge]->(m:Node)"
    : "(m:Node)-[e:Edge]->(n:Node {id: $id})";
  return `MATCH ${pattern} RETURN e.id AS edgeId, e.kind AS kind, e.confidence AS confidence, m.id AS otherId LIMIT $limit`;
}

export function allNodesCypher(withKind: boolean): string {
  const where = withKind ? " WHERE n.kind = $kind" : "";
  return `MATCH (n:Node)${where} RETURN ${NODE_RETURN}`;
}

export const ALL_EDGES_CYPHER =
  "MATCH (a:Node)-[e:Edge]->(b:Node) RETURN e.id AS id, e.kind AS kind, e.confidence AS confidence, a.id AS `from`, b.id AS `to`";

export function nodeInsertCypher(): string {
  return "UNWIND $rows AS r CREATE (n:Node {"
    + "id: r.id, kind: r.kind, path: r.path, name: r.name, scope: r.scope, "
    + "symbolKind: r.symbolKind, startLine: r.startLine, endLine: r.endLine, summary: r.summary})";
}

export function edgeInsertCypher(): string {
  return "UNWIND $rows AS r MATCH (a:Node {id: r.from}), (b:Node {id: r.to}) "
    + "CREATE (a)-[:Edge {id: r.id, kind: r.kind, confidence: r.confidence}]->(b)";
}

const asString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  // Ladybug can return values as boxed primitive wrappers; unwrap before stringifying.
  const primitive: unknown = (value as { valueOf(): unknown }).valueOf();
  if (typeof primitive === "string") return primitive;
  if (typeof primitive === "number" || typeof primitive === "bigint" || typeof primitive === "boolean") return String(primitive);
  return "";
};
const asInt = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  const n = Number(value); // handles boxed Number and bigint-ish values Ladybug returns for INT64
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export function nodeRowsParam(nodes: readonly GraphNodeV1[]): { rows: Record<string, CypherScalar>[] } {
  return {
    rows: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      path: asString(node.path),
      name: asString(node.name),
      scope: asString(node.scope),
      symbolKind: asString(node.symbolKind),
      startLine: asInt(node.startLine),
      endLine: asInt(node.endLine),
      summary: asString(node.summary),
    })),
  };
}

export function edgeRowsParam(edges: readonly GraphEdgeV1[]): { rows: Record<string, CypherScalar>[] } {
  return {
    rows: edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      confidence: edge.confidence,
    })),
  };
}

export function rowToNode(row: Record<string, unknown>): GraphNodeV1 {
  const node: GraphNodeV1 = {
    id: String(row.id),
    kind: String(row.kind) as GraphNodeKind,
    path: asString(row.path),
    name: asString(row.name),
  };
  const scope = asString(row.scope);
  if (scope) node.scope = scope;
  const symbolKind = asString(row.symbolKind);
  if (symbolKind) node.symbolKind = symbolKind;
  const startLine = asInt(row.startLine);
  if (startLine) node.startLine = startLine;
  const endLine = asInt(row.endLine);
  if (endLine) node.endLine = endLine;
  const summary = asString(row.summary);
  if (summary) node.summary = summary;
  return node;
}

export function rowToEdge(row: Record<string, unknown>): GraphEdgeV1 {
  return {
    id: String(row.id),
    kind: String(row.kind) as GraphEdgeKind,
    from: String(row.from),
    to: String(row.to),
    confidence: String(row.confidence) as GraphConfidence,
  };
}

// Side-effecting / non-read Cypher keywords. Any of these appearing as a bare
// (unquoted, uncommented) clause token means the statement can mutate the graph,
// touch the host filesystem (LOAD FROM / COPY TO), or load native extensions
// (INSTALL / LOAD / ATTACH) — none permitted on the read-only public surface.
const FORBIDDEN_KEYWORDS = new Set<string>([
  "CREATE", "MERGE", "SET", "DELETE", "REMOVE", "DROP", "ALTER", "RENAME",
  "COPY", "LOAD", "INSTALL", "ATTACH", "DETACH", "EXPORT", "IMPORT", "USE",
  "CALL", "MACRO", "BEGIN", "COMMIT", "ROLLBACK", "CHECKPOINT", "TRANSACTION",
]);

interface CypherScan {
  bareWords: string[];
  multiStatement: boolean;
}

const isWordStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

// Single left-to-right pass that lexes the query exactly as the engine does:
// single/double-quoted string literals (with backslash escapes), backtick-quoted
// identifiers, double-slash line comments, and slash-star block comments. It
// returns the bare (code-level) identifier tokens plus whether a second
// statement follows a ";". Crucially, a comment marker or keyword that appears
// INSIDE a string literal is treated as data, never as a comment or clause: this
// closes the comment/string-confusion bypass a strip-based regex guard is
// vulnerable to. Identifiers immediately after "." (property access) or "AS"
// (alias) are skipped, since they name data, never a clause, so a read query
// with a property/alias named like a keyword is allowed without weakening the
// guard (a real clause keyword is always a separate token).
function scanCypher(query: string): CypherScan {
  const bareWords: string[] = [];
  let multiStatement = false;
  let sawTerminator = false;
  let skipNextIdentifier = false;
  let index = 0;
  const length = query.length;

  const noteBare = (word: string): void => {
    const upper = word.toUpperCase();
    if (sawTerminator) multiStatement = true;
    if (skipNextIdentifier) {
      skipNextIdentifier = false;
      return;
    }
    bareWords.push(upper);
    skipNextIdentifier = upper === "AS";
  };

  while (index < length) {
    const ch = query[index] ?? "";
    if (ch === "'" || ch === '"') {
      index += 1;
      while (index < length) {
        if (query[index] === "\\") { index += 2; continue; }
        if (query[index] === ch) { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (ch === "`") {
      index += 1;
      while (index < length && query[index] !== "`") index += 1;
      index += 1;
      // A backtick-quoted identifier names data (e.g. `MATCH (n:\`CREATE\`)`),
      // never a clause; treat it like a skipped identifier and honor AS-skip.
      if (skipNextIdentifier) skipNextIdentifier = false;
      continue;
    }
    if (ch === "/" && query[index + 1] === "/") {
      index += 2;
      while (index < length && query[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && query[index + 1] === "*") {
      index += 2;
      while (index < length && !(query[index] === "*" && query[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (ch === ";") {
      sawTerminator = true;
      index += 1;
      continue;
    }
    if (ch === ".") {
      // Property access: skip the following identifier so a property named like a
      // keyword is not scanned as a clause.
      skipNextIdentifier = true;
      index += 1;
      continue;
    }
    if (isWordStart(ch)) {
      let word = ch;
      index += 1;
      while (index < length) {
        const next = query[index] ?? "";
        if (!isWordChar(next)) break;
        word += next;
        index += 1;
      }
      noteBare(word);
      continue;
    }
    if (sawTerminator && !/\s/.test(ch)) multiStatement = true;
    index += 1;
  }
  return { bareWords, multiStatement };
}

/**
 * Read-only guard for the public `cypher()` surface. Rejects multi-statement
 * input and any statement containing a side-effecting keyword as a bare token,
 * using a context-aware lexer (see scanCypher) rather than string mangling.
 */
export function isReadOnlyCypher(query: string): boolean {
  const scan = scanCypher(query);
  if (scan.multiStatement) return false;
  for (const word of scan.bareWords) {
    if (FORBIDDEN_KEYWORDS.has(word)) return false;
  }
  return true;
}
