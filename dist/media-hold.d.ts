import type { DeliveredAttachment } from './types.js';
import type { Clock } from './rate-limit.js';
export interface HeldMediaBatch {
    userId: string;
    attachments: DeliveredAttachment[];
    mediaText: string;
    wasFirstInbound: boolean;
    sourceMessageId: string;
    createdAt: number;
}
export interface MediaHoldOptions {
    holdMs: number;
    clock: Clock;
    onTimeout: (batch: HeldMediaBatch) => void | Promise<void>;
}
export declare function isMediaFlushKeyword(text: string): boolean;
/**
 * Holds media-only inbound messages briefly so a following WeChat text caption
 * can be merged into one DSH turn (WeChat often sends image and text separately).
 */
export declare class MediaHoldBuffer {
    private readonly options;
    private readonly pending;
    constructor(options: MediaHoldOptions);
    has(userId: string): boolean;
    get(userId: string): HeldMediaBatch | undefined;
    /** Store or append media and (re)start the hold timer. */
    hold(batch: Omit<HeldMediaBatch, 'createdAt'> & {
        createdAt?: number;
    }): void;
    /** Take and clear a held batch (e.g. when caption text arrives). */
    take(userId: string): HeldMediaBatch | undefined;
    clear(userId: string): void;
    clearAll(): void;
    size(): number;
}
export declare function formatMediaHoldPrompt(fileCount: number, holdMs: number): string;
//# sourceMappingURL=media-hold.d.ts.map