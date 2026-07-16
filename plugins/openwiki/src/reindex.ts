import path from "node:path";

import { chunkMarkdown, chunkSymbols, symbolChunkText, type ChunkRef } from "./chunk.js";
import { defaultVendorRoot, loadEmbedder, loadVendorManifest, type Embedder, type VendorManifest } from "./embedder.js";
import { OpenWikiError } from "./errors.js";
import type { GraphIndexPort } from "./graph-index.js";
import { openLexicalIndex } from "./lexical-index.js";
import { resolveWikiLocation, type WikiLocation } from "./paths.js";
import { markEmbeddingsUnavailable, openVectorStore, readVectorChunkDigest } from "./vector-store.js";

export interface ReindexResult { chunked: number; embedded: number; reusedVectors: number; reusedLexical: number; embeddingsAvailable: boolean; unavailableReason?: string; }
export interface ReindexPorts { vendorRoot?: string; loadEmbedder?: (vendorRoot: string) => Promise<Embedder>; }

const EMBEDDING_MODEL_ID = "multilingual-e5-small-int8";
const EMBEDDING_DIMS = 384;

export async function reindexWikiPage(location: WikiLocation, page: string, content: string, ports: ReindexPorts = {}): Promise<ReindexResult> {
  const lines = content.split(/\r?\n/u);
  const refs = chunkMarkdown(page, content).map((ref) => ({ ref, text: lines.slice(ref.startLine - 1, ref.endLine).join("\n") }));
  return reindexChunks(location.dataRoot, refs, ports);
}

export async function reindexCodeSymbols(root: string, index: GraphIndexPort, homeDir?: string, ports: ReindexPorts = {}): Promise<ReindexResult> {
  const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
  const symbols = await index.allNodes("symbol");
  const symbolsById = new Map(symbols.map((node) => [node.id, node]));
  const refs = chunkSymbols(symbols).map((ref) => {
    const node = ref.nodeId !== undefined ? symbolsById.get(ref.nodeId) : undefined;
    if (node === undefined) throw new OpenWikiError("INVALID_STATE", "Chunked symbol node disappeared during reindexing.");
    return { ref, text: symbolChunkText(node) };
  });
  return reindexChunks(location.dataRoot, refs, ports);
}

async function reindexChunks(dataRoot: string, refs: ReadonlyArray<{ ref: ChunkRef; text: string }>, ports: ReindexPorts): Promise<ReindexResult> {
  if (refs.length === 0) return { chunked: 0, embedded: 0, reusedVectors: 0, reusedLexical: 0, embeddingsAvailable: true };
  const lexicalIndex = await openLexicalIndex(path.join(dataRoot, "lexical"));
  await lexicalIndex.upsert(refs.map(({ ref, text }) => ({ ref, text })));

  const vectorsRoot = path.join(dataRoot, "vectors");
  const digest = await readVectorChunkDigest(vectorsRoot);
  const changed = refs.filter(({ ref }) => digest.get(ref.id) !== ref.contentHash);
  if (changed.length === 0) return { chunked: refs.length, embedded: 0, reusedVectors: refs.length, reusedLexical: refs.length, embeddingsAvailable: true };

  const vendorRoot = ports.vendorRoot ?? defaultVendorRoot();
  const load = ports.loadEmbedder ?? loadEmbedder;
  let manifest: VendorManifest;
  let embedder: Embedder;
  try {
    manifest = await loadVendorManifest(vendorRoot);
    embedder = await load(vendorRoot);
  } catch (error) {
    // Soft-degrade (TP.2 review C2 / orchestrator adjudication): the wiki
    // page / graph shard is already durably written above; only vector
    // embedding is skipped here, and only for these two specific codes —
    // "assets are absent/invalid," not a real bug. EMBEDDING_FAILURE and
    // INDEX_INCOMPATIBLE are not caught: those indicate an actual defect
    // (a broken model or a version mismatch), not "no vendor install," and
    // still hard-fail the write, exactly as before.
    if (error instanceof OpenWikiError && (error.code === "MODEL_ASSET_MISSING" || error.code === "MODEL_ASSET_CORRUPT")) {
      await markEmbeddingsUnavailable(vectorsRoot, { modelId: EMBEDDING_MODEL_ID, modelRevision: "unknown", dims: EMBEDDING_DIMS }, error.code);
      return {
        chunked: refs.length,
        embedded: 0,
        reusedVectors: refs.length - changed.length,
        reusedLexical: refs.length,
        embeddingsAvailable: false,
        unavailableReason: error.code,
      };
    }
    throw error;
  }
  const modelRevision = manifest.assets.find((asset) => asset.path.startsWith(`model/${EMBEDDING_MODEL_ID}/`))?.revision ?? "unknown";
  const vectors = await embedder.embedPassages(changed.map(({ text }) => text));
  const entries = changed.map(({ ref }, index) => {
    const vector = vectors[index];
    if (vector === undefined) throw new OpenWikiError("EMBEDDING_FAILURE", "Embedder returned fewer vectors than requested.");
    return { ref, vector };
  });
  const vectorStore = await openVectorStore(vectorsRoot, { modelId: EMBEDDING_MODEL_ID, modelRevision, dims: EMBEDDING_DIMS });
  const { written, reused } = await vectorStore.upsert(entries);
  return { chunked: refs.length, embedded: written, reusedVectors: reused + (refs.length - changed.length), reusedLexical: refs.length, embeddingsAvailable: true };
}
