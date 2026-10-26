export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export declare function classifyMedia(filePath: string): MediaKind;
export interface ValidatedMedia {
    path: string;
    name: string;
    kind: MediaKind;
    size: number;
}
export declare class MediaValidationError extends Error {
    constructor(message: string);
}
export declare function isPathWithin(root: string, target: string): boolean;
export interface ValidateOptions {
    roots: readonly string[];
    baseDir: string;
    maxBytes: number;
}
/**
 * Resolve and validate a media path.
 *
 * - relative paths resolve against the session cwd (or process cwd)
 * - symlinks are resolved before the containment check
 * - the file must be a regular file within one of the configured roots
 * - the size cap defaults to the iLink 100 MiB ceiling
 */
export declare function validateMediaFile(filePath: string, options: ValidateOptions): Promise<ValidatedMedia>;
/** MIME type used by the iLink client's media routing. */
export declare function mimeOf(kind: MediaKind, filePath: string): string;
//# sourceMappingURL=media.d.ts.map