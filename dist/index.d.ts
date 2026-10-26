import { Config, type RawConfig, type ResolvedConfig } from './config.js';
import { Redactor, type SafeLogger } from './log.js';
import { StateStore } from './state.js';
import { DshAgentBridge } from './agent/bridge.js';
import { WechatChannel } from './channel.js';
import type { PluginContextLike } from './types.js';
/** Stable Loader identity. */
export declare const name = "wechat-channel";
/**
 * Cordis / DSH Plugins UI schema. Same name as the Config interface so the
 * host can validate cordis.yml and render editable fields.
 */
export { Config };
/**
 * Required host services. `sessionQuery` is needed for `/list`, `/bind` and
 * cold-session resume; `agents` and `tools` are the public plugin seams.
 */
export declare const inject: string[];
export interface PluginApi {
    channel: WechatChannel;
    config: ResolvedConfig;
    bridge: DshAgentBridge;
    state: StateStore;
    logger: SafeLogger;
    redactor: Redactor;
}
/**
 * Mount the WeChat iLink channel.
 *
 * The plugin is intentionally usable without a DSH UI contribution: it logs a
 * QR URL, persists the cursor and active-session binding, and exposes
 * `wechat_send` / `wechat_status` / `wechat_login` tools to every Agent.
 */
export declare function apply(ctx: PluginContextLike, rawConfig?: RawConfig | Config): void;
/** Retrieve the plugin API from a context that mounted it (tests / sibling plugins). */
export declare function getPluginApi(ctx: object): PluginApi | undefined;
export { WechatChannel } from './channel.js';
export { DshAgentBridge, createWechatUserMessage, createChannelNoticeMessage } from './agent/bridge.js';
export { StateStore, emptyState, normalizeState } from './state.js';
export { resolveConfig, DEFAULT_TOKEN_REF } from './config.js';
export { splitText } from './text.js';
export { parseCommand } from './commands.js';
export { resolveSetupPhase, loginGuidanceMessage, welcomeAfterActivate, type SetupPhase, } from './onboarding.js';
