import type { DeliveredAttachment, PluginContextLike } from './types.js';
import type { SavedInboundMedia } from './ilink/inbound-media.js';
import type { SafeLogger } from './log.js';
/**
 * Promote saved inbound files into durable DSH attachment refs when the host
 * exposes `ctx.attachments`. Failures are non-fatal: the workspace path still
 * reaches the Agent via the text summary.
 */
export declare function attachSavedMediaToDsh(ctx: PluginContextLike, saved: readonly SavedInboundMedia[], logger: SafeLogger): Promise<DeliveredAttachment[]>;
