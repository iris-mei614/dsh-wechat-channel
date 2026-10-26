import Schema from 'schemastery';
/**
 * Plugin configuration accepted from cordis.yml / the DSH Plugins UI.
 * Exported both as a TypeScript interface and a Schemastery schema (same name)
 * so Cordis can validate and fill defaults before `apply` runs.
 */
export interface Config {
    defaultSessionId: string;
    botTokenRef: string;
    accountId: string;
    baseUrl: string;
    cdnBaseUrl: string;
    botType: string;
    stateDir: string;
    autoLogin: boolean;
    autoRelogin: boolean;
    ownerUserId: string;
    newSessionCwd: string;
    longPollTimeoutMs: number;
    windowHours: number;
    /** When remaining proactive window drops below this many hours, remind the user once. */
    windowWarnHours: number;
    rateLimitPerMinute: number;
    maxSendAttempts: number;
    notifyOnTurnEnd: boolean;
    notifyAllTurns: boolean;
    sendStartAck: boolean;
    sendProgressUpdates: boolean;
    progressIntervalMs: number;
    maxFileBytes: number;
    mediaRoots: string[];
    textChunkChars: number;
    queueLimit: number;
    logMessageContent: boolean;
    agentPreset: string;
    autoCreateSessionOnFirstMessage: boolean;
    sendWelcomeOnActivate: boolean;
    printQrInTerminal: boolean;
    enableLoginPage: boolean;
    loginPagePort: number;
    /** Download inbound WeChat images/files into the session workspace and hand them to DSH. */
    enableInboundMedia: boolean;
    /** Subdirectory under the session cwd for saved inbound media. */
    inboundMediaDir: string;
    /**
     * After a media-only WeChat message, wait this many ms for a caption text
     * (WeChat often sends image and text as two messages).
     */
    inboundMediaHoldMs: number;
    /** When holding media, ask the user in WeChat to send a caption. */
    askCaptionOnMediaOnly: boolean;
}
/** @deprecated Prefer {@link Config}; kept for call sites that pass partial YAML. */
export type RawConfig = Partial<Config>;
export type ResolvedConfig = Config;
export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export declare const DEFAULT_TOKEN_REF = "WECHAT_ILINK_BOT_TOKEN";
export declare const DEFAULT_MAX_FILE_BYTES: number;
export declare const DEFAULT_PROGRESS_INTERVAL_MS = 180000;
export declare const DEFAULT_INBOUND_MEDIA_HOLD_MS = 30000;
export declare const Config: Schema<Config>;
/** Resolve `$DSH_HOME` with the same precedence DSH itself uses. */
export declare function resolveDshHome(configured?: string): string;
/**
 * Normalize paths and clamp numeric ranges after Cordis/schema defaults.
 * Safe to call with raw YAML or an already-validated Config object.
 */
export declare function resolveConfig(raw: RawConfig | Config | undefined): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map