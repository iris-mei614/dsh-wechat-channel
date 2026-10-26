import {
  ApiClient,
  UploadMediaType,
  sendText as sendTextMessage,
} from 'wechat-ilink-client';
import type { IlinkCredentials, IlinkTransport, InboundMessage, LoginQr, PollResponse, QrStatus } from '../types.js';
import { classifyMedia } from '../media.js';
import { sendVoice } from './audio.js';
import { sendFileMessage, sendImageMessage, sendVideoMessage, uploadMedia } from './media.js';
import { downloadInboundMediaItems } from './inbound-media.js';

interface TransportOptions {
  baseUrl: string;
  cdnBaseUrl: string;
  log?: (message: string, ...params: unknown[]) => void;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function itemText(item: any): string | undefined {
  const text = item?.text_item?.text;
  if (typeof text === 'string' && text !== '') return text;
  // Voice items can carry server-side speech-to-text.
  const voiceText = item?.voice_item?.text;
  if (typeof voiceText === 'string' && voiceText !== '') return voiceText;
  return undefined;
}

/**
 * Real iLink transport. It is stateless with respect to persistence: the
 * channel owns the sync cursor, context tokens and retries.
 */
export class WechatIlinkTransport implements IlinkTransport {
  private api: ApiClient | undefined;
  private credentials: IlinkCredentials | undefined;
  private readonly options: TransportOptions;
  private readonly log: (message: string, ...params: unknown[]) => void;

  constructor(options: TransportOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  setCredentials(credentials: IlinkCredentials): void {
    this.credentials = { ...credentials };
    this.api = new ApiClient({
      baseUrl: credentials.baseUrl || this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
      token: credentials.token,
    });
  }

  getCredentials(): IlinkCredentials | undefined {
    return this.credentials === undefined ? undefined : { ...this.credentials };
  }

  private requireApi(): ApiClient {
    if (this.api === undefined) throw new Error('iLink 尚未登录：请先扫码登录，或配置 botTokenRef');
    return this.api;
  }

  async getUpdates(syncBuf: string, timeoutMs: number, signal?: AbortSignal): Promise<PollResponse> {
    const api = this.requireApi();
    const response = await abortable(api.getUpdates(syncBuf, timeoutMs), signal);
    return {
      ret: response.ret,
      errcode: response.errcode,
      errmsg: response.errmsg,
      get_updates_buf: response.get_updates_buf,
      longpolling_timeout_ms: response.longpolling_timeout_ms,
      msgs: (response.msgs ?? []).map((message): InboundMessage => ({
        from: message.from_user_id,
        to: message.to_user_id,
        groupId: message.group_id,
        messageType: message.message_type,
        messageId: message.message_id,
        clientId: message.client_id,
        contextToken: message.context_token,
        items: (message.item_list ?? []).map((item) => ({
          type: item.type,
          textItem: item.text_item === undefined ? undefined : { text: item.text_item.text },
          voiceItem: item.voice_item === undefined ? undefined : { text: item.voice_item.text },
          raw: item,
        })),
      })),
    };
  }

  async downloadInboundMedia(message: InboundMessage) {
    const rawItems = (message.items ?? [])
      .map((item) => item.raw)
      .filter((item): item is object => typeof item === 'object' && item !== null);
    if (rawItems.length === 0) return [];
    const cdnBaseUrl = this.credentials?.baseUrl
      ? this.options.cdnBaseUrl
      : this.options.cdnBaseUrl;
    return downloadInboundMediaItems(rawItems, cdnBaseUrl);
  }

  async sendText(to: string, text: string, contextToken: string): Promise<void> {
    await sendTextMessage(this.requireApi(), to, text, contextToken);
  }

  async sendMedia(to: string, filePath: string, caption: string | undefined, contextToken: string): Promise<void> {
    const api = this.requireApi();
    // Captions are a separate iLink text message. The channel normally sends
    // them through its own rate-limited queue and passes undefined here.
    if (caption !== undefined && caption !== '') {
      await sendTextMessage(api, to, caption, contextToken);
    }

    const kind = classifyMedia(filePath);
    const lower = filePath.toLowerCase();
    if (kind === 'audio' && (lower.endsWith('.mp3') || lower.endsWith('.wav'))) {
      try {
        await sendVoice(api, to, filePath, contextToken);
        return;
      } catch (error) {
        this.log('语音消息发送失败，降级为文件附件：%s', error instanceof Error ? error.message : String(error));
      }
      const uploaded = await uploadMedia(api, filePath, to, UploadMediaType.FILE);
      await sendFileMessage(api, to, filePath, uploaded, contextToken);
      return;
    }
    if (kind === 'image') {
      const uploaded = await uploadMedia(api, filePath, to, UploadMediaType.IMAGE);
      await sendImageMessage(api, to, uploaded, contextToken);
      return;
    }
    if (kind === 'video') {
      const uploaded = await uploadMedia(api, filePath, to, UploadMediaType.VIDEO);
      await sendVideoMessage(api, to, uploaded, contextToken);
      return;
    }
    const uploaded = await uploadMedia(api, filePath, to, UploadMediaType.FILE);
    await sendFileMessage(api, to, filePath, uploaded, contextToken);
  }

  async requestQrCode(botType: string): Promise<LoginQr> {
    const api = new ApiClient({
      baseUrl: this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
      token: this.credentials?.token,
    });
    const response = await api.getQRCode(botType);
    return { qrcode: response.qrcode, url: response.qrcode_img_content };
  }

  async pollQrStatus(qrcode: string): Promise<QrStatus> {
    const api = new ApiClient({
      baseUrl: this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
      token: this.credentials?.token,
    });
    const status = await api.pollQRCodeStatus(qrcode);
    return {
      status: status.status,
      botToken: status.bot_token,
      accountId: status.ilink_bot_id,
      baseUrl: status.baseurl,
      userId: status.ilink_user_id,
    };
  }

  async dispose(): Promise<void> {
    this.api = undefined;
    this.credentials = undefined;
  }
}

export function extractInboundText(message: InboundMessage): string {
  const parts: string[] = [];
  for (const item of message.items ?? []) {
    if (item.type === 1 || item.type === 3) {
      const text = item.textItem?.text ?? item.voiceItem?.text;
      if (typeof text === 'string' && text !== '') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}
