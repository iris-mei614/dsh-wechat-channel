export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
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
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly clock: Clock = realClock,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      const now = this.clock.now();
      while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      const wait = Math.max(1, this.windowMs - (now - this.stamps[0]!));
      await this.clock.sleep(wait, signal);
    }
  }

  get size(): number {
    return this.stamps.length;
  }
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
export class OutboundQueue {
  private readonly pending: Array<{
    job: OutboundJob;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
  }> = [];
  private running = false;
  private stopped = false;

  constructor(
    private readonly limiter: RateLimiter,
    private readonly options: {
      limit: number;
      signal?: AbortSignal;
      onError: (error: unknown, job: OutboundJob) => void;
    },
  ) {}

  enqueue(job: OutboundJob, signal?: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.reject(new AbortError());
    if (this.pending.length >= this.options.limit) {
      return Promise.reject(new Error(`outbound queue is full (${this.options.limit})`));
    }
    const effectiveSignal = signal ?? this.options.signal ?? new AbortController().signal;
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ job, resolve, reject, signal: effectiveSignal });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const entry = this.pending.shift();
        if (entry === undefined) break;
        if (entry.signal.aborted) {
          entry.reject(new AbortError());
          continue;
        }
        try {
          await this.limiter.acquire(entry.signal);
          await entry.job.run(entry.signal);
          entry.resolve();
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') entry.reject(error);
          else {
            entry.reject(error);
            try {
              this.options.onError(error, entry.job);
            } catch {
              // ignore logger failures
            }
          }
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.pending.length > 0) void this.drain();
    }
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.splice(0)) entry.reject(new AbortError());
  }

  get size(): number {
    return this.pending.length;
  }
}
