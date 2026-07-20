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
export declare const UNSCOPED_PROJECT_SCOPE = "memex:unscoped";
/**
 * Create the stable public identity for a retrieved excerpt.
 *
 * The tuple is length-prefixed rather than joined with a delimiter so an
 * arbitrary path/source value cannot create an ambiguous identity.  The
 * `ev1:` prefix leaves room for a future identity contract without silently
 * changing the meaning of old IDs.
 */
export declare function createEvidenceIdentity(input: EvidenceIdentityInput): EvidenceIdentity;
