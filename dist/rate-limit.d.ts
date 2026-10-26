export interface Clock {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export declare const realClock: Clock;
export declare class AbortError extends Error {
    constructor();
}
/**
 * Sliding-window rate limiter. The channel defaults to 10 messages per
 * rolling minute, well below anything that should trigger platform risk
 * controls, and the outbound queue is serialized behind this limiter.
 */
export declare class RateLimiter {
    private readonly limit;
    private readonly windowMs;
    private readonly clock;
    private readonly stamps;
    constructor(limit: number, windowMs?: number, clock?: Clock);
    acquire(signal?: AbortSignal): Promise<void>;
    get size(): number;
}
export interface OutboundJob {
    readonly id: string;
    readonly user: string;
    run(signal: AbortSignal): Promise<void>;
}
/**
 * Serialized outbound queue. Every externally visible message (replies,
 * completion notices, media) passes through it so a burst cannot exceed the
 * configured rate limit.
 */
export declare class OutboundQueue {
    private readonly limiter;
    private readonly options;
    private readonly pending;
    private running;
    private stopped;
    constructor(limiter: RateLimiter, options: {
        limit: number;
        signal?: AbortSignal;
        onError: (error: unknown, job: OutboundJob) => void;
    });
    enqueue(job: OutboundJob, signal?: AbortSignal): Promise<void>;
    private drain;
    stop(): void;
    get size(): number;
}
//# sourceMappingURL=rate-limit.d.ts.map