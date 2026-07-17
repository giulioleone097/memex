import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LADYBUG_SCHEMA_DDL, NODE_BY_ID_CYPHER, adjacencyCypher, allNodesCypher, ALL_EDGES_CYPHER,
  nodeInsertCypher, edgeInsertCypher, nodeRowsParam, edgeRowsParam, rowToNode, rowToEdge, isReadOnlyCypher,
} from "../../dist/ladybug-cypher.js";

test("schema declares Node and Edge tables with an id primary key", () => {
  const joined = LADYBUG_SCHEMA_DDL.join("\n");
  assert.match(joined, /CREATE NODE TABLE\s+IF NOT EXISTS\s+Node/i);
  assert.match(joined, /CREATE REL TABLE\s+IF NOT EXISTS\s+Edge/i);
  assert.match(joined, /id STRING PRIMARY KEY/i);
  assert.match(joined, /FROM Node TO Node/i);
});

test("adjacency cypher differs by direction and is parameterized", () => {
  assert.match(adjacencyCypher("outbound"), /\(n:Node \{id: \$id\}\)-\[e:Edge\]->\(m:Node\)/);
  assert.match(adjacencyCypher("inbound"), /\(m:Node\)-\[e:Edge\]->\(n:Node \{id: \$id\}\)/);
  assert.match(adjacencyCypher("outbound"), /LIMIT \$limit/);
});

test("node-by-id and all-edges queries are shaped for the mappers", () => {
  assert.match(NODE_BY_ID_CYPHER, /MATCH \(n:Node \{id: \$id\}\)/);
  assert.match(NODE_BY_ID_CYPHER, /n\.startLine AS startLine/);
  assert.match(ALL_EDGES_CYPHER, /MATCH \(a:Node\)-\[e:Edge\]->\(b:Node\)/);
  assert.match(ALL_EDGES_CYPHER, /a\.id AS `from`/);
});

test("allNodesCypher toggles the kind filter", () => {
  assert.doesNotMatch(allNodesCypher(false), /WHERE/);
  assert.match(allNodesCypher(true), /WHERE n\.kind = \$kind/);
});

test("insert cypher uses UNWIND $rows", () => {
  assert.match(nodeInsertCypher(), /UNWIND \$rows AS r CREATE \(n:Node/);
  assert.match(edgeInsertCypher(), /UNWIND \$rows AS r MATCH \(a:Node \{id: r\.from\}\), \(b:Node \{id: r\.to\}\)/);
});

test("rowToNode maps columns, drops empties, coerces boxed numbers", () => {
  const n = rowToNode({ id: "x", kind: "symbol", path: "a.ts", name: "foo", scope: "mod", symbolKind: "function", startLine: new Number(3), endLine: 9, summary: "" });
  assert.equal(n.id, "x");
  assert.equal(n.kind, "symbol");
  assert.equal(n.name, "foo");
  assert.equal(n.scope, "mod");
  assert.equal(n.symbolKind, "function");
  assert.equal(n.startLine, 3);
  assert.equal(n.endLine, 9);
  assert.equal("summary" in n, false, "empty summary is dropped");
});

test("rowToEdge maps endpoints and confidence", () => {
  const e = rowToEdge({ id: "e1", kind: "calls", from: "a", to: "b", confidence: "resolved" });
  assert.deepEqual(e, { id: "e1", kind: "calls", from: "a", to: "b", confidence: "resolved" });
});

test("nodeRowsParam yields one row object per node with all columns present", () => {
  const { rows } = nodeRowsParam([{ id: "a", kind: "file", path: "a.ts", name: "a.ts" }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["endLine", "id", "kind", "name", "path", "scope", "startLine", "summary", "symbolKind"]);
  assert.equal(rows[0].scope, "");
  assert.equal(rows[0].startLine, 0);
});

test("edgeRowsParam yields from/to/id/kind/confidence", () => {
  const { rows } = edgeRowsParam([{ id: "e", kind: "references", from: "a", to: "b", confidence: "exact" }]);
  assert.deepEqual(rows[0], { id: "e", from: "a", to: "b", kind: "references", confidence: "exact" });
});

test("isReadOnlyCypher allows reads, blocks mutations", () => {
  for (const ok of [
    "MATCH (n:Node) RETURN n",
    "match (n) return count(n)",
    "MATCH (n:Node) WHERE n.kind = 'symbol' RETURN n.name",
    "MATCH (n:Node) RETURN n.name AS set",           // alias named like a keyword
    "MATCH (n:Node) WHERE n.set = 1 RETURN n",        // property named like a keyword
    "MATCH (n:Node) RETURN n.name AS create",         // alias named exactly like a forbidden keyword
    "MATCH (n:Node) WHERE n.create = 1 RETURN n",      // property named exactly like a forbidden keyword
    "OPTIONAL MATCH (a)-[e:Edge]->(b) RETURN a, b",
    "MATCH (n:Node) WHERE n.summary = 'we CREATE things here' RETURN n", // keyword only inside a string literal
    "MATCH (n:Node) /* keep only calls */ WHERE n.kind = 'symbol' RETURN n", // real block comment
    "MATCH (n:Node) RETURN n.name AS c ; ",           // a lone trailing semicolon is fine
  ]) assert.equal(isReadOnlyCypher(ok), true, ok);

  for (const bad of [
    "CREATE (n:Node)",
    "MERGE (n)",
    "MATCH (n) SET n.x = 1",
    "MATCH (n) DELETE n",
    "MATCH (n) DETACH DELETE n",
    "DROP TABLE Node",
    "COPY Node FROM 'x.csv'",
    "COPY (MATCH (n) RETURN n) TO '/tmp/x.csv'",
    "ALTER TABLE Node ADD col STRING",
    "LOAD FROM '/etc/passwd' RETURN *",
    "CALL write_proc()",
    "INSTALL httpfs",
    "ATTACH '/tmp/other.db' AS other",
    // Proven guard-bypass attempts (security review): comment/string confusion.
    "RETURN '/*' AS a ; CREATE (:Node {id:'PWNED'}) ; RETURN '*/' AS b",
    "RETURN '/*' AS a ; COPY (LOAD FROM '/etc/passwd' RETURN column0) TO '/tmp/exfil.csv' ; RETURN '*/' AS b",
    "MATCH (n:Node) WITH '/*' AS c, n CREATE (m:Node {id:'NOSEMI2'}) RETURN '*/' AS z",
    // Multi-statement even without the comment trick.
    "MATCH (n) RETURN n ; DROP TABLE Node",
  ]) assert.equal(isReadOnlyCypher(bad), false, bad);
});
