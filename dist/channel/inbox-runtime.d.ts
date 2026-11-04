import type { StateStore } from '../state.js';
import type { InboundMessage } from '../types.js';
/** Keep poison messages out of the live queue after three failed attempts. */
export declare function drainInbox(state: StateStore, handle: (message: InboundMessage) => Promise<void>, now: () => number, signal: AbortSignal, onError: (error: unknown) => void, describe?: (error: unknown) => string): Promise<void>;
