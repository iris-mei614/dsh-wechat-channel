import type { IlinkCredentials, IlinkTransport, InboundMessage, LoginQr, PollResponse, QrStatus } from '../types.js';
interface TransportOptions {
    baseUrl: string;
    cdnBaseUrl: string;
    log?: (message: string, ...params: unknown[]) => void;
}
/**
 * Real iLink transport. It is stateless with respect to persistence: the
 * channel owns the sync cursor, context tokens and retries.
 */
export declare class WechatIlinkTransport implements IlinkTransport {
    private api;
    private credentials;
    private readonly options;
    private readonly log;
    constructor(options: TransportOptions);
    setCredentials(credentials: IlinkCredentials): void;
    getCredentials(): IlinkCredentials | undefined;
    private requireApi;
    getUpdates(syncBuf: string, timeoutMs: number, signal?: AbortSignal): Promise<PollResponse>;
    downloadInboundMedia(message: InboundMessage): Promise<import("./inbound-media.js").DownloadedInboundMedia[]>;
    sendText(to: string, text: string, contextToken: string): Promise<void>;
    sendMedia(to: string, filePath: string, caption: string | undefined, contextToken: string): Promise<void>;
    requestQrCode(botType: string): Promise<LoginQr>;
    pollQrStatus(qrcode: string): Promise<QrStatus>;
    dispose(): Promise<void>;
}
export declare function extractInboundText(message: InboundMessage): string;
export {};
//# sourceMappingURL=transport.d.ts.map