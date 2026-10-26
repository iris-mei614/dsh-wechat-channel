import { Config, resolveConfig, type RawConfig, type ResolvedConfig } from './config.js';
import { Redactor, createSafeLogger, describeError, type SafeLogger } from './log.js';
import { StateStore } from './state.js';
import { WechatIlinkTransport } from './ilink/transport.js';
import { DshAgentBridge } from './agent/bridge.js';
import { WechatChannel } from './channel.js';
import { registerTools } from './tools.js';
import type { PluginContextLike } from './types.js';

/** Stable Loader identity. */
export const name = 'wechat-channel';

/**
 * Cordis / DSH Plugins UI schema. Same name as the Config interface so the
 * host can validate cordis.yml and render editable fields.
 */
export { Config };

/**
 * Required host services. `sessionQuery` is needed for `/list`, `/bind` and
 * cold-session resume; `agents` and `tools` are the public plugin seams.
 */
export const inject = ['agents', 'tools', 'sessionQuery', 'credentials'];

export interface PluginApi {
  channel: WechatChannel;
  config: ResolvedConfig;
  bridge: DshAgentBridge;
  state: StateStore;
  logger: SafeLogger;
  redactor: Redactor;
}

const APIs = new WeakMap<object, PluginApi>();

/**
 * Mount the WeChat iLink channel.
 *
 * The plugin is intentionally usable without a DSH UI contribution: it logs a
 * QR URL, persists the cursor and active-session binding, and exposes
 * `wechat_send` / `wechat_status` / `wechat_login` tools to every Agent.
 */
export function apply(ctx: PluginContextLike, rawConfig?: RawConfig | Config): void {
  const config = resolveConfig(rawConfig);
  // Prefer the host's resolved $DSH_HOME over the process environment when
  // the profile was launched with a custom home.
  if (rawConfig?.stateDir === undefined || rawConfig.stateDir.trim() === '') {
    const dshHomePath = ctx.get('dshHomePath');
    if (typeof dshHomePath === 'function') {
      try {
        config.stateDir = dshHomePath('wechat-channel');
      } catch {
        // fall back to the environment-derived default
      }
    }
  }
  const redactor = new Redactor();
  const logger = createSafeLogger(ctx.logger('wechat-channel'), redactor);
  const state = new StateStore(config.stateDir);
  const bridge = new DshAgentBridge(ctx, config, logger);
  const transport = new WechatIlinkTransport({
    baseUrl: config.baseUrl,
    cdnBaseUrl: config.cdnBaseUrl,
    log: (message, ...params) => logger.warn(message, ...params),
  });
  const channel = new WechatChannel({ ctx, config, state, transport, bridge, logger, redactor });

  const api: PluginApi = { channel, config, bridge, state, logger, redactor };
  APIs.set(ctx as object, api);
  if (typeof (ctx as any).provide === 'function') {
    try {
      (ctx as any).provide('wechatChannel', api);
    } catch {
      // Providing a service is a convenience, not a requirement.
    }
  }

  registerTools(ctx, channel, logger);

  ctx.effect(async () => {
    try {
      await channel.start();
    } catch (error) {
      logger.error('微信通道启动失败：%s', describeError(error));
      await channel.stop().catch(() => {});
      await bridge.dispose().catch(() => {});
      await state.close().catch(() => {});
      throw error;
    }
    return async () => {
      try {
        await channel.stop();
      } catch (error) {
        logger.warn('停止微信通道时出错：%s', describeError(error));
      }
      try {
        await bridge.dispose();
      } catch (error) {
        logger.warn('释放会话句柄时出错：%s', describeError(error));
      }
      try {
        await state.close();
      } catch (error) {
        logger.warn('保存通道状态时出错：%s', describeError(error));
      }
    };
  }, 'wechat-channel: channel lifecycle');
}

/** Retrieve the plugin API from a context that mounted it (tests / sibling plugins). */
export function getPluginApi(ctx: object): PluginApi | undefined {
  return APIs.get(ctx);
}

export { WechatChannel } from './channel.js';
export { DshAgentBridge, createWechatUserMessage, createChannelNoticeMessage } from './agent/bridge.js';
export { StateStore, emptyState, normalizeState } from './state.js';
export { resolveConfig, DEFAULT_TOKEN_REF } from './config.js';
export { splitText } from './text.js';
export { parseCommand } from './commands.js';
export {
  resolveSetupPhase,
  loginGuidanceMessage,
  welcomeAfterActivate,
  type SetupPhase,
} from './onboarding.js';
