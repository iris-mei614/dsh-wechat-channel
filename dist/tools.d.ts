import type { PluginContextLike } from './types.js';
import type { WechatChannel } from './channel.js';
import type { SafeLogger } from './log.js';
/**
 * Register the host-facing WeChat tools:
 *   - `wechat_send`   deliver text/files from any DSH session
 *   - `wechat_status` inspect the channel
 *   - `wechat_login`  obtain a QR login URL
 */
export declare function registerTools(ctx: PluginContextLike, channel: WechatChannel, logger: SafeLogger): Array<() => void>;
