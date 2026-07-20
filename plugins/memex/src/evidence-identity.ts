import { createHash } from "node:crypto";

/**
 * The fields which identify one excerpt of one source.  `priorEvidenceId` is
 * deliberately not part of the identity tuple: it records lineage when the
 * source changes, while the current content still gets a new identity.
 */
export interface EvidenceIdentityInput {
  projectScope: string;
  sourceIdentity: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  priorEvidenceId?: string;
}

export interface EvidenceProvenance {
  projectScope: string;
  sourceIdentity: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  priorEvidenceId?: string;
}

export interface EvidenceIdentity {
  evidenceId: string;
  provenance: EvidenceProvenance;
}

export const UNSCOPED_PROJECT_SCOPE = "memex:unscoped";

/**
 * Create the stable public identity for a retrieved excerpt.
 *
 * The tuple is length-prefixed rather than joined with a delimiter so an
 * arbitrary path/source value cannot create an ambiguous identity.  The
 * `ev1:` prefix leaves room for a future identity contract without silently
 * changing the meaning of old IDs.
 */
export function createEvidenceIdentity(input: EvidenceIdentityInput): EvidenceIdentity {
  const projectScope = normalizeProjectScope(input.projectScope);
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity);
  const contentHash = normalizeContentHash(input.contentHash);
  const startLine = normalizeBoundary(input.startLine, "startLine");
  const endLine = normalizeBoundary(input.endLine, "endLine");
  if (endLine < startLine) throw new TypeError("Evidence endLine must be greater than or equal to startLine.");
  const priorEvidenceId = input.priorEvidenceId === undefined ? undefined : normalizePriorEvidenceId(input.priorEvidenceId);
  const tuple = ["ev1", projectScope, sourceIdentity, contentHash, String(startLine), String(endLine)];
  const encoded = tuple.map((part) => `${String(part.length)}:${part}`).join("");
  const evidenceId = `ev1:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
  return {
    evidenceId,
    provenance: {
      projectScope,
      sourceIdentity,
      contentHash,
      startLine,
      endLine,
      ...(priorEvidenceId === undefined ? {} : { priorEvidenceId }),
    },
  };
}

/**
 * Project scope is a logical workspace/repository identity.  Absolute paths
 * are rejected: hashing one would hide the leak while still making identity
 * machine-specific (`/Users/alice` and `/Users/bob` would hash differently).
 */
function normalizeProjectScope(value: string): string {
  const normalized = nonEmpty(value, "projectScope").replaceAll("\\", "/");
  if (isAbsolutePath(normalized)) throw new TypeError("Evidence projectScope must be a logical identity, not an absolute host path.");
  return normalized.replace(/^\.\//u, "");
}

/**
 * Source identities are normally source IDs (`git:<blob>`, `worktree:<hash>`)
 * or repository-relative paths.  Keep those values readable and deterministic
 * while protecting callers that accidentally pass an absolute host path.
 */
function normalizeSourceIdentity(value: string): string {
  const normalized = nonEmpty(value, "sourceIdentity").replaceAll("\\", "/");
  if (isAbsolutePath(normalized)) return `source-sha256:${sha256(normalized)}`;
  return normalized.replace(/^\.\//u, "");
}

function normalizeContentHash(value: string): string {
  const normalized = nonEmpty(value, "contentHash").toLowerCase();
  return normalized;
}

function normalizeBoundary(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Evidence ${field} must be a positive integer.`);
  return value;
}

function normalizePriorEvidenceId(value: string): string {
  const normalized = nonEmpty(value, "priorEvidenceId");
  if (!/^ev1:[a-f0-9]{64}$/u.test(normalized)) throw new TypeError("Evidence priorEvidenceId must be an ev1 SHA-256 identity.");
  return normalized;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`Evidence ${field} must be a non-empty string.`);
  if (value.includes("\0")) throw new TypeError(`Evidence ${field} must not contain NUL bytes.`);
  return value.trim();
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
