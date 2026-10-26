import type { PluginContextLike, ToolDefinitionLike } from './types.js';
import type { WechatChannel } from './channel.js';
import type { SafeLogger } from './log.js';
import { describeError } from './log.js';

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }];
}

function objectArgs(value: unknown): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具参数必须是对象');
  return value as Record<string, any>;
}

/**
 * Register the host-facing WeChat tools:
 *   - `wechat_send`   deliver text/files from any DSH session
 *   - `wechat_status` inspect the channel
 *   - `wechat_login`  obtain a QR login URL
 */
export function registerTools(ctx: PluginContextLike, channel: WechatChannel, logger: SafeLogger): Array<() => void> {
  const disposers: Array<() => void> = [];

  const sendTool: ToolDefinitionLike = {
    name: 'wechat_send',
    description:
      '通过微信 iLink 通道向已绑定的微信用户发送文本和/或本地文件（图片、视频、音频、其他文件）。' +
      '需要用户此前在微信中给 Bot 发过消息以取得 context_token，且距最近一次入站不超过 24 小时（插件默认 20 小时安全窗口）。' +
      '文件路径必须位于调用方会话的工作区或配置的 mediaRoots 内。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要发送的文本；可单独使用，也可与 files 同时使用。' },
        files: {
          type: 'array',
          description: '要发送的本地文件绝对/相对路径。图片走图片消息，视频走视频消息，音频优先语音消息，其余为文件附件。',
          items: { type: 'string' },
        },
        caption: { type: 'string', description: '发送媒体时附带的说明文字。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          user: { type: 'string' },
          textParts: { type: 'integer' },
          files: { type: 'integer' },
        },
        required: ['ok', 'user', 'textParts', 'files'],
      },
      render(_args, value: any) {
        return text(`已发送到微信：文本 ${value.textParts} 段，文件 ${value.files} 个。`);
      },
    },
    async execute(rawArgs, exec) {
      const args = objectArgs(rawArgs);
      if (exec?.signal?.aborted) throw new Error('已取消');
      const files = Array.isArray(args.files)
        ? args.files
            .filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim() !== '')
            .map((entry: string) => ({ path: entry }))
        : [];
      const callingSessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined;
      const result = await channel.sendFromTool({
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
        ...(files.length > 0 ? { files } : {}),
        ...(typeof args.caption === 'string' ? { caption: args.caption } : {}),
        // File roots follow the CALLING session, not the WeChat-bound session.
        ...(callingSessionId === undefined ? {} : { sessionId: callingSessionId }),
      });
      return { ok: true, ...result };
    },
  };

  const statusTool: ToolDefinitionLike = {
    name: 'wechat_status',
    description:
      '查看微信 iLink 通道的就绪阶段与下一步操作，以及连接状态、活跃会话、24 小时窗口、待补发摘要与收发计数。' +
      '首次接入时优先看 setupPhase / nextAction：need-login → need-first-message → need-session → ready。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value: any) {
        return text(
          [
            `就绪阶段：${value.setupLabel || value.setupPhase || value.status}`,
            `下一步：${value.nextAction || '无'}`,
            `连接：${value.connected ? '已连接' : value.status}`,
            `回复凭证：${value.hasContextToken ? '已有' : '无（需微信先发一条消息）'}`,
            `活跃会话：${value.activeSessionId || '未绑定'}（${value.activeSessionStatus}）`,
            `待补发摘要：${value.pendingNotices}`,
            `计数：入站 ${value.counters?.inbound ?? 0} / 出站 ${value.counters?.outbound ?? 0}`,
            ...(value.loginQrUrl ? [`登录二维码：${value.loginQrUrl}`] : []),
            ...(value.loginPageUrl ? [`扫码页：${value.loginPageUrl}`] : []),
          ].join('\n'),
        );
      },
    },
    async execute() {
      return channel.getStatusSnapshot();
    },
  };

  const loginTool: ToolDefinitionLike = {
    name: 'wechat_login',
    description:
      '获取微信 iLink Bot 的扫码登录链接并说明激活步骤。已登录时返回当前就绪阶段与下一步；未登录时返回二维码 URL。' +
      '扫码确认后 Bot Token 会写入 DSH 凭据（botTokenRef）；二维码也会写入状态目录的 login-qr.txt，并尽量在终端渲染。' +
      '登录成功后仍需用户在微信里给 Bot 发任意一条消息，才能取得 context_token 并开始回复。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          status: { type: 'string' },
          message: { type: 'string' },
          qrUrl: { type: 'string' },
        },
        required: ['connected', 'status', 'message'],
      },
      render(_args, value: any) {
        return text(value.message);
      },
    },
    async execute() {
      return channel.beginLogin();
    },
  };

  for (const tool of [sendTool, statusTool, loginTool]) {
    try {
      disposers.push(ctx.tools.register(tool));
      logger.info('已注册工具 %s', tool.name);
    } catch (error) {
      logger.error('注册工具 %s 失败：%s', tool.name, describeError(error));
    }
  }
  return disposers;
}
