import type { Clock } from './rate-limit.js';
export interface ProgressTick {
    sessionId: string;
    userId: string;
    elapsedMs: number;
    activity: string;
    message: string;
}
/**
 * Periodic “still working” pings for long WeChat-originated turns.
 * One tracker per session; a later deliver to the same session keeps the
 * original start time so elapsed time stays continuous.
 */
export declare class ProgressTracker {
    private readonly clock;
    private readonly onTick;
    private readonly entries;
    constructor(clock: Clock, onTick: (tick: ProgressTick) => void | Promise<void>);
    start(sessionId: string, userId: string, intervalMs: number): void;
    /** Update the human-readable “current step” shown on the next progress ping. */
    setActivity(sessionId: string, activity: string): void;
    stop(sessionId: string): void;
    stopAll(): void;
    isTracking(sessionId: string): boolean;
    size(): number;
}
export declare function formatProgressMessage(elapsedMs: number, activity?: string): string;
/** Map a raw tool / event name into a short Chinese activity line. */
export declare function describeToolActivity(toolName: string, detail?: string): string;
