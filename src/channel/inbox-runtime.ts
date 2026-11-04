import type { StateStore } from '../state.js';
import type { InboundMessage } from '../types.js';

/** Keep poison messages out of the live queue after three failed attempts. */
export async function drainInbox(state: StateStore, handle: (message: InboundMessage) => Promise<void>, now: () => number, signal: AbortSignal, onError: (error: unknown) => void, describe: (error: unknown) => string = () => '入站处理失败，请查看脱敏日志'): Promise<void> {
  while (!signal.aborted && state.get().inboundQueue.length > 0) {
    const message = state.get().inboundQueue[0]!;
    const key = `${message.from}:${message.messageId ?? message.clientId ?? 'unknown'}`;
    try {
      await handle(message);
      state.update(data => { data.inboundQueue.shift(); delete data.inboundAttempts[key]; });
    } catch (error) {
      onError(error);
      state.update(data => {
        const attempts = (data.inboundAttempts[key] ?? 0) + 1;
        data.inboundAttempts[key] = attempts;
        if (attempts >= 3) {
          data.failedInbound.push({ message, attempts, failedAt: now(), reason: describe(error) });
          data.inboundQueue.shift();
          delete data.inboundAttempts[key];
        }
      });
      await state.flush();
      if (state.get().inboundQueue[0] === message) throw error;
    }
    await state.flush();
  }
}
