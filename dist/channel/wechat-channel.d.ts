import type { InboundMessage } from '../types.js';
import { StateStore } from '../state.js';
import type { ChannelDeps, ChannelStatusSnapshot, LoginBeginResult } from './types.js';
export type { ChannelDeps, ChannelStatusSnapshot, ConnectionStatus, LoginBeginResult } from './types.js';
/**
 * The channel owns every policy decision the iLink client intentionally leaves
 * to its caller: login, cursor persistence, reconnect/backoff, the 24-hour
 * window, context-token caching, command handling, rate limiting, retries and
 * turn-completion notifications.
 */
export declare class WechatChannel {
    readonly state: StateStore;
    private readonly ctx;
    private readonly config;
    private readonly transport;
    private readonly bridge;
    private readonly logger;
    private readonly redactor;
    private readonly clock;
    private readonly queue;
    private abortController;
    private started;
    private stopped;
    private status;
    private credentials;
    private lastError;
    private lastPollAt;
    private pollTimeoutMs;
    private pollTask;
    private loginPoller;
    private loginStarting;
    private loginQr;
    private unsubscribeTurn;
    private unsubscribeActivity;
    private windowWarnedForInboundAt;
    /** Sessions created from WeChat that still need a first-message title. */
    private readonly pendingWechatTitles;
    private readonly lastRetryable;
    private readonly progress;
    private readonly loginPage;
    private readonly mediaHold;
    constructor(deps: ChannelDeps);
    get signal(): AbortSignal;
    /** Start login-resolution and the long-poll loop. Safe to call once. */
    start(): Promise<void>;
    stop(): Promise<void>;
    private resolveToken;
    private setCredentials;
    private pollLoop;
    private handleSessionExpired;
    private safeSleep;
    private isAllowedUser;
    private bindOwner;
    handleInbound(message: InboundMessage): Promise<void>;
    private flushHeldMedia;
    private ingestInboundMedia;
    /**
     * Ensure an active session exists for first-run UX. Returns whether a session
     * was auto-created, and whether a welcome was sent.
     */
    private ensureSessionForFirstMessage;
    private deliverText;
    private retryLastFailure;
    private maybeWarnWindowExpiry;
    private describePollHealth;
    private notifyDsh;
    private handleCommand;
    private createTrackedSession;
    /** Name a WeChat-created session from its first delivered followup text. */
    private maybeNameWechatSession;
    private setActiveSession;
    private formatStatus;
    private currentSetup;
    private onTurnComplete;
    private canProactivelySend;
    private sendProactive;
    private flushPendingNotices;
    private contextTokenFor;
    private sendReply;
    private sendTextWithRetry;
    private sendMediaWithRetry;
    private mediaRootsFor;
    private validateFiles;
    private sendFiles;
    /** Used by the `wechat_send` tool. */
    sendFromTool(input: {
        text?: string;
        files?: Array<{
            path: string;
            description?: string;
        }>;
        caption?: string;
        sessionId?: string;
    }): Promise<{
        user: string;
        textParts: number;
        files: number;
    }>;
    getStatusSnapshot(): Promise<ChannelStatusSnapshot>;
    private loginPageSnapshot;
    /**
     * Start (or re-use) the QR login flow and return the QR URL immediately.
     * The scan status is polled in the background; a successful confirmation is
     * written back into DSH credentials.
     */
    beginLogin(): Promise<LoginBeginResult>;
    private publishLoginQr;
    private pollLogin;
    private completeLogin;
    private noteError;
}
