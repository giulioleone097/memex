import { createHash } from "node:crypto";
import { graphHash } from "./graph-contracts.js";
import { MemexError } from "./errors.js";
const MIN_CHUNK_TOKENS = 200;
const MAX_CHUNK_TOKENS = 400;
export function estimateTokens(text) {
    const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
    return Math.ceil(matches.length * 1.3);
}
export function chunkMarkdown(path, text) {
    const lines = text.split(/\r?\n/u);
    const blocks = splitIntoBlocks(lines);
    const chunks = [];
    let bufferLines = [];
    let bufferStart = 1;
    let bufferTokens = 0;
    const flush = (endLine) => {
        if (bufferLines.length === 0)
            return;
        chunks.push(makeChunk(path, "wiki", bufferStart, endLine, bufferLines.join("\n")));
        bufferLines = [];
        bufferTokens = 0;
    };
    for (const block of blocks) {
        const blockTokens = estimateTokens(block.lines.join("\n"));
        if (bufferLines.length > 0 && bufferTokens >= MIN_CHUNK_TOKENS && bufferTokens + blockTokens > MAX_CHUNK_TOKENS) {
            flush(block.startLine - 1);
            bufferStart = block.startLine;
        }
        if (bufferLines.length === 0)
            bufferStart = block.startLine;
        bufferLines.push(...block.lines);
        bufferTokens += blockTokens;
        if (bufferTokens >= MAX_CHUNK_TOKENS) {
            flush(block.endLine);
            bufferStart = block.endLine + 1;
        }
    }
    flush(lines.length);
    return chunks;
}
// Exported separately (not just inlined into chunkSymbols below) so callers
// that need the chunk's *text* — not just its ChunkRef — can regenerate the
// exact same string deterministically from the same node, instead of
// duplicating this formatting logic and risking silent drift from the text
// that actually produced ChunkRef.contentHash. Task 10's reindex.ts is the
// concrete consumer: it needs the text to feed both the lexical index and
// the embedder, but chunkSymbols itself only returns ChunkRef[] (binding).
export function symbolChunkText(node) {
    const scope = node.scope !== undefined && node.scope.length > 0 ? `${node.scope}.` : "";
    const kindLabel = node.symbolKind !== undefined ? ` (${node.symbolKind})` : "";
    const start = node.startLine ?? 1;
    const end = node.endLine ?? start;
    const lines = node.startLine !== undefined ? `:${String(start)}-${String(end)}` : "";
    return `${node.kind} ${scope}${node.name}${kindLabel} — ${node.path}${lines}`;
}
export function chunkSymbols(nodes) {
    return nodes
        .filter((node) => node.kind === "symbol")
        .map((node) => {
        const start = node.startLine ?? 1;
        const end = node.endLine ?? start;
        return makeChunk(node.path, "code", start, end, symbolChunkText(node), node.id);
    })
        .sort((left, right) => left.id.localeCompare(right.id));
}
export function parseChunkRef(value) {
    if (!isRecord(value) ||
        typeof value.id !== "string" || !/^[a-f0-9]{64}$/u.test(value.id) ||
        typeof value.path !== "string" || value.path.length === 0 ||
        !positiveLine(value.startLine) || !positiveLine(value.endLine) || value.endLine < value.startLine ||
        !isPlane(value.plane) ||
        typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
        (value.nodeId !== undefined && typeof value.nodeId !== "string")) {
        throw new MemexError("INVALID_STATE", "Chunk reference is invalid.");
    }
    return {
        id: value.id,
        path: value.path,
        startLine: value.startLine,
        endLine: value.endLine,
        plane: value.plane,
        contentHash: value.contentHash,
        ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
    };
}
function splitIntoBlocks(lines) {
    const blocks = [];
    let current = [];
    let currentStart = 1;
    const flush = (endLine) => {
        if (current.length === 0)
            return;
        blocks.push({ startLine: currentStart, endLine, lines: current });
        current = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const lineNumber = index + 1;
        const isHeading = /^#{1,6}\s+\S/u.test(line);
        const isBlank = line.trim().length === 0;
        if (isHeading && current.length > 0) {
            flush(lineNumber - 1);
            currentStart = lineNumber;
        }
        if (isBlank && !isHeading) {
            if (current.length > 0)
                flush(lineNumber - 1);
            currentStart = lineNumber + 1;
            continue;
        }
        if (current.length === 0)
            currentStart = lineNumber;
        current.push(line);
    }
    flush(lines.length);
    return blocks.filter((block) => block.lines.some((line) => line.trim().length > 0));
}
function makeChunk(path, plane, startLine, endLine, text, nodeId) {
    const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
    return {
        id: graphHash(["chunk", plane, path, String(startLine), String(endLine), contentHash]),
        path,
        startLine,
        endLine,
        plane,
        contentHash,
        ...(nodeId === undefined ? {} : { nodeId }),
    };
}
function isPlane(value) {
    return value === "code" || value === "concept" || value === "wiki";
}
function positiveLine(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
