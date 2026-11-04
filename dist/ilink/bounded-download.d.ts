/** Download/decrypt on disk; memory use is bounded by the stream chunks. */
export declare function boundedDownload(url: string, key: string | undefined, maxBytes: number, parent?: string): Promise<{
    path: string;
    bytes: number;
    cleanupDir: string;
}>;
