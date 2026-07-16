import { readFile } from "node:fs/promises";

import { MemexError } from "./errors.js";

export interface Tokenizer { encode(text: string): Int32Array; }

const MAX_PIECE_LENGTH = 32;
const UNK_PENALTY = 10;

interface TokenizerConfig {
  vocab: Map<string, number>;
  scores: Float64Array;
  unkId: number;
  bosId: number;
  eosId: number;
  maxLength: number;
  addPrefixSpace: boolean;
}

export async function loadTokenizer(tokenizerJsonPath: string): Promise<Tokenizer> {
  let raw: string;
  try {
    raw = await readFile(tokenizerJsonPath, "utf8");
  } catch {
    throw new MemexError("MODEL_ASSET_MISSING", "Tokenizer asset is missing.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemexError("MODEL_ASSET_CORRUPT", "Tokenizer asset is not valid JSON.");
  }
  const config = parseTokenizerConfig(parsed);
  return { encode: (text: string): Int32Array => encodeWithConfig(config, text) };
}

function parseTokenizerConfig(value: unknown): TokenizerConfig {
  if (!isRecord(value) || !isRecord(value.model) || value.model.type !== "Unigram" || !Array.isArray(value.model.vocab)) {
    throw new MemexError("MODEL_ASSET_CORRUPT", "Tokenizer model type is not the expected SentencePiece Unigram format.");
  }
  const vocab = new Map<string, number>();
  const scores: number[] = [];
  value.model.vocab.forEach((entry: unknown, index: number) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number") {
      throw new MemexError("MODEL_ASSET_CORRUPT", "Tokenizer vocabulary entry is invalid.");
    }
    vocab.set(entry[0], index);
    scores.push(entry[1]);
  });
  const rawUnk = value.model.unkId ?? value.model.unk_id;
  const unkId = typeof rawUnk === "number" ? rawUnk : 0;
  const addedRaw = value.addedTokens ?? value.added_tokens;
  const added = Array.isArray(addedRaw) ? addedRaw : [];
  const findSpecial = (content: string, fallback: number): number => {
    for (const entry of added) {
      if (isRecord(entry) && entry.content === content && typeof entry.id === "number") return entry.id;
    }
    return vocab.get(content) ?? fallback;
  };
  const bosId = findSpecial("<s>", 0);
  const eosId = findSpecial("</s>", 2);
  const rawMaxLength = isRecord(value.truncation) ? value.truncation.max_length ?? value.truncation.maxLength : undefined;
  const maxLength = typeof rawMaxLength === "number" && rawMaxLength > 2 ? rawMaxLength : 512;
  return { vocab, scores: Float64Array.from(scores), unkId, bosId, eosId, maxLength, addPrefixSpace: true };
}

function encodeWithConfig(config: TokenizerConfig, text: string): Int32Array {
  const normalized = preTokenize(text, config.addPrefixSpace);
  const budget = Math.max(0, config.maxLength - 2);
  // Bound the Viterbi DP's input, not just its output: unigramSegment is
  // O(characters * MAX_PIECE_LENGTH), and without this bound it processes
  // the *entire* input before truncation ever applies — for a pathological
  // input (e.g. one long unbroken run of non-whitespace characters, which
  // chunk.ts's own token-count heuristic can undercount as a single
  // "token"), that made encode() cost effectively unbounded by the model's
  // max_length (empirically ~9s for a 2MB adversarial payload). This bound
  // is exact, not an approximation: the DP is strictly forward (a prefix's
  // segmentation never depends on characters beyond it) and every piece is
  // at most MAX_PIECE_LENGTH characters, so budget*MAX_PIECE_LENGTH
  // characters is always enough to yield at least `budget` output pieces
  // (worst case: every piece is maximal length) — truncating the DP's input
  // to that many characters produces byte-identical output to running it on
  // the full text and then slicing to `budget`.
  const bounded = normalized.length > budget * MAX_PIECE_LENGTH
    ? Array.from(normalized).slice(0, budget * MAX_PIECE_LENGTH).join("")
    : normalized;
  const pieces = unigramSegment(bounded, config.vocab, config.scores, config.unkId);
  const truncated = pieces.slice(0, budget);
  return Int32Array.from([config.bosId, ...truncated, config.eosId]);
}

function preTokenize(text: string, addPrefixSpace: boolean): string {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const withPrefix = addPrefixSpace && normalized.length > 0 ? ` ${normalized}` : normalized;
  return withPrefix.replace(/ /gu, "▁");
}

function unigramSegment(text: string, vocab: ReadonlyMap<string, number>, scores: Float64Array, unkId: number): number[] {
  const characters = Array.from(text);
  const length = characters.length;
  const bestScore = new Float64Array(length + 1).fill(Number.NEGATIVE_INFINITY);
  const backPointer = new Int32Array(length + 1).fill(-1);
  const backPiece = new Array<string | undefined>(length + 1).fill(undefined);
  bestScore[0] = 0;
  // Not Math.min(...scores): the real vendored vocabulary has ~250,002
  // entries, and spreading that many call arguments overflows V8's stack
  // (RangeError: Maximum call stack size exceeded) — only the ~20-entry
  // test fixture is small enough for the spread form to work, which let
  // this slip past the unit tests and only surface against the real asset.
  let minScore = 0;
  for (let index = 0; index < scores.length; index += 1) {
    const value = scores[index] ?? 0;
    if (index === 0 || value < minScore) minScore = value;
  }
  const unkScore = minScore - UNK_PENALTY;
  for (let end = 1; end <= length; end += 1) {
    const start = Math.max(0, end - MAX_PIECE_LENGTH);
    for (let begin = start; begin < end; begin += 1) {
      const candidate = characters.slice(begin, end).join("");
      const pieceId = vocab.get(candidate);
      if (pieceId === undefined) continue;
      const score = (bestScore[begin] ?? Number.NEGATIVE_INFINITY) + (scores[pieceId] ?? unkScore);
      if (score > (bestScore[end] ?? Number.NEGATIVE_INFINITY)) {
        bestScore[end] = score;
        backPointer[end] = begin;
        backPiece[end] = candidate;
      }
    }
    const unkBegin = end - 1;
    const unkTotal = (bestScore[unkBegin] ?? Number.NEGATIVE_INFINITY) + unkScore;
    if (unkTotal > (bestScore[end] ?? Number.NEGATIVE_INFINITY)) {
      bestScore[end] = unkTotal;
      backPointer[end] = unkBegin;
      backPiece[end] = undefined;
    }
  }
  const ids: number[] = [];
  let position = length;
  while (position > 0) {
    const piece = backPiece[position];
    const previous = backPointer[position] ?? 0;
    ids.push(piece === undefined ? unkId : (vocab.get(piece) ?? unkId));
    position = previous;
  }
  return ids.reverse();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
