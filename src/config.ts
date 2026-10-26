import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import Schema from 'schemastery';

/**
 * Plugin configuration accepted from cordis.yml / the DSH Plugins UI.
 * Exported both as a TypeScript interface and a Schemastery schema (same name)
 * so Cordis can validate and fill defaults before `apply` runs.
 */
export interface Config {
  defaultSessionId: string;
  botTokenRef: string;
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  botType: string;
  stateDir: string;
  autoLogin: boolean;
  autoRelogin: boolean;
  ownerUserId: string;
  newSessionCwd: string;
  longPollTimeoutMs: number;
  windowHours: number;
  /** When remaining proactive window drops below this many hours, remind the user once. */
  windowWarnHours: number;
  rateLimitPerMinute: number;
  maxSendAttempts: number;
  notifyOnTurnEnd: boolean;
  notifyAllTurns: boolean;
  sendStartAck: boolean;
  sendProgressUpdates: boolean;
  progressIntervalMs: number;
  maxFileBytes: number;
  mediaRoots: string[];
  textChunkChars: number;
  queueLimit: number;
  logMessageContent: boolean;
  agentPreset: string;
  autoCreateSessionOnFirstMessage: boolean;
  sendWelcomeOnActivate: boolean;
  printQrInTerminal: boolean;
  enableLoginPage: boolean;
  loginPagePort: number;
  /** Download inbound WeChat images/files into the session workspace and hand them to DSH. */
  enableInboundMedia: boolean;
  /** Subdirectory under the session cwd for saved inbound media. */
  inboundMediaDir: string;
  /**
   * After a media-only WeChat message, wait this many ms for a caption text
   * (WeChat often sends image and text as two messages).
   */
  inboundMediaHoldMs: number;
  /** When holding media, ask the user in WeChat to send a caption. */
  askCaptionOnMediaOnly: boolean;
}

/** @deprecated Prefer {@link Config}; kept for call sites that pass partial YAML. */
export type RawConfig = Partial<Config>;

export type ResolvedConfig = Config;

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const DEFAULT_TOKEN_REF = 'WECHAT_ILINK_BOT_TOKEN';
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PROGRESS_INTERVAL_MS = 180_000;
export const DEFAULT_INBOUND_MEDIA_HOLD_MS = 30_000;

export const Config: Schema<Config> = Schema.object({
  defaultSessionId: Schema.string().default('').description('启动时绑定的已有 DSH 会话 ID；留空则首次文字可自动新建'),
  botTokenRef: Schema.string().default(DEFAULT_TOKEN_REF).description('DSH 凭据引用名（Bot Token）'),
  accountId: Schema.string().default('').description('可选 Bot 账号 ID；通常由扫码返回'),
  baseUrl: Schema.string().default(DEFAULT_BASE_URL).description('iLink API 根地址'),
  cdnBaseUrl: Schema.string().default(DEFAULT_CDN_BASE_URL).description('媒体 CDN 根地址'),
  botType: Schema.string().default('3').description('扫码登录 bot_type'),
  stateDir: Schema.string().default('').description('状态目录；留空为 $DSH_HOME/wechat-channel'),
  autoLogin: Schema.boolean().default(true).description('无 Token 时自动请求二维码'),
  autoRelogin: Schema.boolean().default(false).description('errcode -14 后自动重新请求二维码'),
  ownerUserId: Schema.string().default('').description('只接受该微信用户；留空则绑定首个发消息的人'),
  newSessionCwd: Schema.string().default('').description('/new 与自动建会话的工作目录'),
  longPollTimeoutMs: Schema.number().default(35_000).description('长轮询超时（毫秒）'),
  windowHours: Schema.number().default(20).description('主动推送安全窗口（小时，服务端硬限制 24）'),
  windowWarnHours: Schema.number().default(2).description('主动推送窗口剩余不足该小时数时提醒用户回消息'),
  rateLimitPerMinute: Schema.number().default(10).description('出站滑动窗口限速（条/分钟）'),
  maxSendAttempts: Schema.number().default(3).description('单条消息最大尝试次数'),
  notifyOnTurnEnd: Schema.boolean().default(true).description('任务结束时自动推送到微信'),
  notifyAllTurns: Schema.boolean().default(false).description('非微信触发的 turn 也推送'),
  sendStartAck: Schema.boolean().default(true).description('投递成功后向微信回「正在处理」'),
  sendProgressUpdates: Schema.boolean().default(true).description('长任务期间定期向微信发送进度'),
  progressIntervalMs: Schema.number().default(DEFAULT_PROGRESS_INTERVAL_MS).description('进度推送间隔（毫秒，默认 3 分钟）'),
  maxFileBytes: Schema.number().default(DEFAULT_MAX_FILE_BYTES).description('单文件上限（字节）'),
  mediaRoots: Schema.array(String).default([]).description('额外允许发送的媒体根目录'),
  textChunkChars: Schema.number().default(1_800).description('单条文本切分长度'),
  queueLimit: Schema.number().default(100).description('出站队列上限'),
  logMessageContent: Schema.boolean().default(false).description('是否在日志中打印消息预览'),
  agentPreset: Schema.string().default('').description('新建/恢复会话使用的 Agent preset'),
  autoCreateSessionOnFirstMessage: Schema.boolean().default(true).description('无绑定会话时首条文字自动新建会话'),
  sendWelcomeOnActivate: Schema.boolean().default(true).description('首次激活时发送欢迎语'),
  printQrInTerminal: Schema.boolean().default(true).description('尝试在终端渲染登录二维码'),
  enableLoginPage: Schema.boolean().default(true).description('启动本地 Web 扫码页（127.0.0.1）'),
  loginPagePort: Schema.number().default(19_876).description('扫码页端口；0 表示系统分配'),
  enableInboundMedia: Schema.boolean().default(true).description('下载微信入站图片/文件并交给 DSH'),
  inboundMediaDir: Schema.string().default('wechat-inbox').description('入站媒体保存在会话 cwd 下的子目录名'),
  inboundMediaHoldMs: Schema.number()
    .default(DEFAULT_INBOUND_MEDIA_HOLD_MS)
    .description('纯媒体消息等待配文的毫秒数（微信常把图和字分成两条）'),
  askCaptionOnMediaOnly: Schema.boolean().default(true).description('收到纯媒体时提示用户补充文字说明'),
});

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < minimum) return fallback;
  return Math.min(rounded, maximum);
}

/** Resolve `$DSH_HOME` with the same precedence DSH itself uses. */
export function resolveDshHome(configured?: string): string {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(configured.trim());
  }
  const envHome = process.env.DSH_HOME;
  if (typeof envHome === 'string' && envHome.trim() !== '') {
    return resolve(envHome.trim());
  }
  return resolve(homedir(), '.dsh');
}

function defaultStateDir(): string {
  return resolve(resolveDshHome(), 'wechat-channel');
}

function normalizePath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

/**
 * Normalize paths and clamp numeric ranges after Cordis/schema defaults.
 * Safe to call with raw YAML or an already-validated Config object.
 */
export function resolveConfig(raw: RawConfig | Config | undefined): ResolvedConfig {
  const input = (raw ?? {}) as RawConfig;
  const maxFileBytes = integerValue(input.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1, DEFAULT_MAX_FILE_BYTES);
  const mediaRoots = Array.isArray(input.mediaRoots)
    ? input.mediaRoots
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => normalizePath(entry))
    : [];

  return {
    defaultSessionId: stringValue(input.defaultSessionId, ''),
    botTokenRef: stringValue(input.botTokenRef, DEFAULT_TOKEN_REF) || DEFAULT_TOKEN_REF,
    accountId: stringValue(input.accountId, ''),
    baseUrl: stringValue(input.baseUrl, DEFAULT_BASE_URL) || DEFAULT_BASE_URL,
    cdnBaseUrl: stringValue(input.cdnBaseUrl, DEFAULT_CDN_BASE_URL) || DEFAULT_CDN_BASE_URL,
    botType: stringValue(input.botType, '3') || '3',
    stateDir: input.stateDir ? normalizePath(input.stateDir) : defaultStateDir(),
    autoLogin: booleanValue(input.autoLogin, true),
    autoRelogin: booleanValue(input.autoRelogin, false),
    ownerUserId: stringValue(input.ownerUserId, ''),
    newSessionCwd: input.newSessionCwd ? normalizePath(input.newSessionCwd) : '',
    longPollTimeoutMs: integerValue(input.longPollTimeoutMs, 35_000, 1_000, 120_000),
    windowHours: integerValue(input.windowHours, 20, 1, 24),
    windowWarnHours: integerValue(input.windowWarnHours, 2, 0, 12),
    rateLimitPerMinute: integerValue(input.rateLimitPerMinute, 10, 1, 60),
    maxSendAttempts: integerValue(input.maxSendAttempts, 3, 1, 5),
    notifyOnTurnEnd: booleanValue(input.notifyOnTurnEnd, true),
    notifyAllTurns: booleanValue(input.notifyAllTurns, false),
    sendStartAck: booleanValue(input.sendStartAck, true),
    sendProgressUpdates: booleanValue(input.sendProgressUpdates, true),
    // Clamp (do not fall back) so tests can use a short interval and invalid
    // small values become the 1s floor instead of silently jumping to 3 minutes.
    progressIntervalMs: Math.min(
      3_600_000,
      Math.max(
        1_000,
        typeof input.progressIntervalMs === 'number' && Number.isFinite(input.progressIntervalMs)
          ? Math.floor(input.progressIntervalMs)
          : DEFAULT_PROGRESS_INTERVAL_MS,
      ),
    ),
    maxFileBytes,
    mediaRoots,
    textChunkChars: integerValue(input.textChunkChars, 1_800, 100, 8_000),
    queueLimit: integerValue(input.queueLimit, 100, 1, 10_000),
    logMessageContent: booleanValue(input.logMessageContent, false),
    agentPreset: stringValue(input.agentPreset, ''),
    autoCreateSessionOnFirstMessage: booleanValue(input.autoCreateSessionOnFirstMessage, true),
    sendWelcomeOnActivate: booleanValue(input.sendWelcomeOnActivate, true),
    printQrInTerminal: booleanValue(input.printQrInTerminal, true),
    enableLoginPage: booleanValue(input.enableLoginPage, true),
    loginPagePort: integerValue(input.loginPagePort, 19_876, 0, 65_535),
    enableInboundMedia: booleanValue(input.enableInboundMedia, true),
    inboundMediaDir: stringValue(input.inboundMediaDir, 'wechat-inbox') || 'wechat-inbox',
    inboundMediaHoldMs: Math.min(
      120_000,
      Math.max(
        0,
        typeof input.inboundMediaHoldMs === 'number' && Number.isFinite(input.inboundMediaHoldMs)
          ? Math.floor(input.inboundMediaHoldMs)
          : DEFAULT_INBOUND_MEDIA_HOLD_MS,
      ),
    ),
    askCaptionOnMediaOnly: booleanValue(input.askCaptionOnMediaOnly, true),
  };
}
