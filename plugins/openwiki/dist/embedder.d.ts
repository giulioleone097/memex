export interface Embedder {
    readonly modelId: string;
    readonly dims: number;
    embedQuery(text: string): Promise<Float32Array>;
    embedPassages(texts: readonly string[]): Promise<Float32Array[]>;
}
export interface VendorManifestPart {
    path: string;
    sha256: string;
    bytes: number;
}
export interface VendorManifestEntry {
    path: string;
    bytes: number;
    license: string;
    upstream: string;
    revision: string;
    sha256?: string;
    assembledSha256?: string;
    parts?: VendorManifestPart[];
}
export interface VendorManifest {
    assets: VendorManifestEntry[];
}
export declare function defaultVendorRoot(): string;
export declare function loadVendorManifest(vendorRoot: string): Promise<VendorManifest>;
export declare function verifyAllVendorAssets(vendorRoot: string): Promise<VendorManifest>;
export declare function loadModelBuffer(vendorRoot: string, manifest: VendorManifest, logicalPath: string): Promise<Uint8Array>;
export declare function loadEmbedder(vendorRoot: string): Promise<Embedder>;
export declare function resolveOrtEntryPath(vendorRoot: string): string;
