export interface LoginPageSnapshot {
    status: string;
    connected: boolean;
    setupLabel: string;
    nextAction: string;
    health?: string;
    pollHealthy?: boolean;
    lastInboundAt?: number;
    lastPollAt?: number;
    pendingNotices?: number;
    queueSize?: number;
    windowRemainingMs?: number;
    qrUrl?: string;
    accountId?: string;
    lastError?: string;
}
/**
 * Tiny localhost page for QR login. Avoids a full DSH Web client slot package
 * while still giving operators a browser-scannable surface for demos.
 */
export declare class LoginPageServer {
    private readonly getSnapshot;
    private server;
    private port;
    private url;
    constructor(getSnapshot: () => LoginPageSnapshot);
    get address(): string;
    get running(): boolean;
    start(preferredPort: number): Promise<string>;
    stop(): Promise<void>;
    private handle;
    private json;
    private html;
}
export declare function renderLoginHtml(snapshot: LoginPageSnapshot): string;
