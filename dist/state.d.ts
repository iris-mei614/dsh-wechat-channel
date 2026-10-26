export interface ContextTokenRecord {
    token: string;
    updatedAt: number;
}
export interface PendingNotice {
    id: string;
    sessionId: string;
    text: string;
    files: Array<{
        path: string;
        description?: string;
    }>;
    createdAt: number;
}
export interface ListEntry {
    id: string;
    title: string;
}
export interface ChannelStateData {
    version: 1;
    syncBuf: string;
    activeSessionId: string;
    ownerUserId: string;
    accountId: string;
    baseUrl: string;
    lastInboundAt: number;
    contextTokens: Record<string, ContextTokenRecord>;
    pendingNotices: PendingNotice[];
    seenMessages: string[];
    listSnapshot: ListEntry[];
    counters: {
        inbound: number;
        outbound: number;
        errors: number;
    };
}
export declare function emptyState(): ChannelStateData;
/** Normalize an arbitrary parsed JSON document into the current state shape. */
export declare function normalizeState(input: unknown): ChannelStateData;
/**
 * Durable plugin state: sync cursor, active session, owner binding, cached
 * context tokens, pending completion notices and counters.
 *
 * Writes are serialized, coalesced, and atomic (temp file + rename, mode 0600).
 */
export declare class StateStore {
    private readonly stateDir;
    private data;
    private loaded;
    private dirty;
    private saving;
    private closed;
    private saveFailure;
    private readonly filePath;
    constructor(stateDir: string);
    get path(): string;
    load(): Promise<ChannelStateData>;
    get(): ChannelStateData;
    /** Mutate state and schedule a coalesced write. */
    update(mutator: (data: ChannelStateData) => void): ChannelStateData;
    cacheContextToken(userId: string, token: string): void;
    getContextToken(userId: string): ContextTokenRecord | undefined;
    markSeen(key: string): boolean;
    addPendingNotice(notice: Omit<PendingNotice, 'id' | 'createdAt'>): PendingNotice;
    removePendingNotices(ids: readonly string[]): void;
    takePendingNotices(limit: number): PendingNotice[];
    private scheduleSave;
    private write;
    /** Last background save failure, if any. State remains in memory. */
    get lastSaveFailure(): unknown;
    flush(): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=state.d.ts.map