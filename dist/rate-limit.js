export const realClock = {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new AbortError());
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(0, ms));
        const onAbort = () => {
            clearTimeout(timer);
            reject(new AbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
export class AbortError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}
/**
 * Sliding-window rate limiter. The channel defaults to 10 messages per
 * rolling minute, well below anything that should trigger platform risk
 * controls, and the outbound queue is serialized behind this limiter.
 */
export class RateLimiter {
    limit;
    windowMs;
    clock;
    stamps = [];
    constructor(limit, windowMs = 60_000, clock = realClock) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.clock = clock;
    }
    async acquire(signal) {
        for (;;) {
            if (signal?.aborted)
                throw new AbortError();
            const now = this.clock.now();
            while (this.stamps.length > 0 && now - this.stamps[0] >= this.windowMs)
                this.stamps.shift();
            if (this.stamps.length < this.limit) {
                this.stamps.push(now);
                return;
            }
            const wait = Math.max(1, this.windowMs - (now - this.stamps[0]));
            await this.clock.sleep(wait, signal);
        }
    }
    get size() {
        return this.stamps.length;
    }
}
/**
 * Serialized outbound queue. Every externally visible message (replies,
 * completion notices, media) passes through it so a burst cannot exceed the
 * configured rate limit.
 */
export class OutboundQueue {
    limiter;
    options;
    pending = [];
    running = false;
    stopped = false;
    constructor(limiter, options) {
        this.limiter = limiter;
        this.options = options;
    }
    enqueue(job, signal) {
        if (this.stopped)
            return Promise.reject(new AbortError());
        if (this.pending.length >= this.options.limit) {
            return Promise.reject(new Error(`outbound queue is full (${this.options.limit})`));
        }
        const effectiveSignal = signal ?? this.options.signal ?? new AbortController().signal;
        return new Promise((resolve, reject) => {
            this.pending.push({ job, resolve, reject, signal: effectiveSignal });
            void this.drain();
        });
    }
    async drain() {
        if (this.running)
            return;
        this.running = true;
        try {
            while (!this.stopped) {
                const entry = this.pending.shift();
                if (entry === undefined)
                    break;
                if (entry.signal.aborted) {
                    entry.reject(new AbortError());
                    continue;
                }
                try {
                    await this.limiter.acquire(entry.signal);
                    await entry.job.run(entry.signal);
                    entry.resolve();
                }
                catch (error) {
                    if (error instanceof Error && error.name === 'AbortError')
                        entry.reject(error);
                    else {
                        entry.reject(error);
                        try {
                            this.options.onError(error, entry.job);
                        }
                        catch {
                            // ignore logger failures
                        }
                    }
                }
            }
        }
        finally {
            this.running = false;
            if (!this.stopped && this.pending.length > 0)
                void this.drain();
        }
    }
    stop() {
        this.stopped = true;
        for (const entry of this.pending.splice(0))
            entry.reject(new AbortError());
    }
    get size() {
        return this.pending.length;
    }
}
