import type { PendingNotice, StateStore } from '../state.js';
/** Checkpoint each text chunk and attachment independently. */
export declare function deliverNotice(state: StateStore, notice: PendingNotice, chunkChars: number, sendText: (text: string) => Promise<void>, sendFile: (file: {
    path: string;
    description?: string;
}) => Promise<void>): Promise<void>;
