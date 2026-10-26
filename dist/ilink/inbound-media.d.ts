export type InboundMediaKind = 'image' | 'voice' | 'file' | 'video';
export interface DownloadedInboundMedia {
    kind: InboundMediaKind;
    data: Uint8Array;
    /** Original filename when the protocol provides one (files). */
    fileName?: string;
}
export interface SavedInboundMedia {
    kind: InboundMediaKind;
    path: string;
    bytes: number;
    fileName: string;
    mediaType?: string;
}
/** Detect common image MIME types from magic bytes. */
export declare function sniffImageMediaType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined;
/**
 * Download decryptable media items from a WeChat inbound message's raw item_list.
 * Text/voice-STT-only items are skipped.
 */
export declare function downloadInboundMediaItems(rawItems: ReadonlyArray<unknown>, cdnBaseUrl: string): Promise<DownloadedInboundMedia[]>;
/** Persist downloaded media under `destDir` (created if needed). */
export declare function saveInboundMediaFiles(items: readonly DownloadedInboundMedia[], destDir: string, options?: {
    maxBytes: number;
}): Promise<SavedInboundMedia[]>;
export declare function describeSavedMedia(files: readonly SavedInboundMedia[]): string;
