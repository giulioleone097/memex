export declare function atomicWriteFile(filePath: string, content: string): Promise<void>;
export declare function withWikiLock<T>(root: string, operation: () => Promise<T>): Promise<T>;
