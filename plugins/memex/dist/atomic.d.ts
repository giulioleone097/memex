export declare function atomicWriteFile(filePath: string, content: string): Promise<void>;
export declare function withWikiLock<T>(root: string, operation: () => Promise<T>): Promise<T>;
export interface FileWriteLockOptions {
    waitMs?: number;
    staleMs?: number;
}
export declare function withFileWriteLock<T>(lockPath: string, operation: () => Promise<T>, options?: FileWriteLockOptions): Promise<T>;
export declare function atomicWriteBinaryFile(filePath: string, content: Buffer): Promise<void>;
