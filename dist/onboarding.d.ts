/**
 * User-facing setup stages for the first-run journey:
 *   need-login → need-first-message → need-session → ready
 *
 * `expired` / `reconnecting` / `error` overlay the connection layer.
 */
export type SetupPhase = 'need-login' | 'need-first-message' | 'need-session' | 'ready' | 'expired' | 'reconnecting' | 'error' | 'starting' | 'stopped';
/** Connection-layer status; kept here as a string union to avoid cycles with channel.ts. */
export type ConnectionStatusLike = 'starting' | 'waiting-login' | 'connected' | 'reconnecting' | 'expired' | 'stopped' | 'error';
export interface SetupSnapshotInput {
    status: ConnectionStatusLike;
    hasCredentials: boolean;
    hasContextToken: boolean;
    hasOwner: boolean;
    hasActiveSession: boolean;
    lastInboundAt: number;
    windowHours: number;
    now: number;
    loginQrUrl?: string;
}
export interface SetupSnapshot {
    phase: SetupPhase;
    /** One-line label for /status and tools. */
    label: string;
    /** Concrete next action the operator/user should take. */
    nextAction: string;
    /** Remaining proactive-send window in ms; undefined when inactive. */
    windowRemainingMs?: number;
}
export declare function resolveSetupPhase(input: SetupSnapshotInput): SetupSnapshot;
/** Steps shown when a QR login starts. */
export declare function loginGuidanceMessage(qrUrl: string): string;
export declare function loginInProgressMessage(qrUrl: string): string;
export declare function alreadyLoggedInMessage(setup: SetupSnapshot): string;
/** Logged (and optionally echoed) right after a successful QR confirmation. */
export declare function postLoginNextStepsLog(): string;
export declare function welcomeAfterActivate(options: {
    sessionId: string;
    autoCreated: boolean;
    processingFirstText: boolean;
}): string;
export declare function unboundSessionHint(autoCreateEnabled: boolean): string;
/**
 * Best-effort terminal QR rendering. Missing `qrcode-terminal` is fine —
 * callers always still print the URL.
 */
export declare function printQrToTerminal(url: string, log: (line: string) => void): Promise<boolean>;
//# sourceMappingURL=onboarding.d.ts.map