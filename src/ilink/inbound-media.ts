import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { downloadMediaFromItem, MessageItemType } from 'wechat-ilink-client';

export type InboundMediaKind = 'image' | 'voice' | 'file' | 'video';

export interface DownloadedInboundMedia {
  kind: InboundMediaKind;
  data: Uint8Array;
  /** Original filename when the protocol provides one (files). */
  fileName?: string;
}

export interface SavedInboundMedia {
  kind: InboundMediaKind;
  path: string;
  bytes: number;
  fileName: string;
  mediaType?: string;
}

/** Detect common image MIME types from magic bytes. */
export function sniffImageMediaType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  return undefined;
}

function defaultExtension(kind: InboundMediaKind, mediaType?: string): string {
  if (mediaType === 'image/png') return '.png';
  if (mediaType === 'image/jpeg') return '.jpg';
  if (mediaType === 'image/webp') return '.webp';
  if (mediaType === 'image/gif') return '.gif';
  if (kind === 'image') return '.jpg';
  if (kind === 'video') return '.mp4';
  if (kind === 'voice') return '.silk';
  return '.bin';
}

function safeFileName(name: string | undefined, kind: InboundMediaKind, mediaType?: string): string {
  const raw = typeof name === 'string' ? basename(name.trim()) : '';
  const cleaned = raw.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/, '');
  if (cleaned !== '' && cleaned !== '_' && cleaned.length <= 120) {
    if (extname(cleaned) === '') return `${cleaned}${defaultExtension(kind, mediaType)}`;
    return cleaned;
  }
  return `${kind}-${Date.now()}${defaultExtension(kind, mediaType)}`;
}

/**
 * Download decryptable media items from a WeChat inbound message's raw item_list.
 * Text/voice-STT-only items are skipped.
 */
export async function downloadInboundMediaItems(
  rawItems: ReadonlyArray<unknown>,
  cdnBaseUrl: string,
): Promise<DownloadedInboundMedia[]> {
  const out: DownloadedInboundMedia[] = [];
  for (const item of rawItems) {
    if (typeof item !== 'object' || item === null) continue;
    const typed = item as { type?: number };
    if (
      typed.type !== MessageItemType.IMAGE &&
      typed.type !== MessageItemType.FILE &&
      typed.type !== MessageItemType.VIDEO &&
      typed.type !== MessageItemType.VOICE
    ) {
      continue;
    }
    try {
      const downloaded = await downloadMediaFromItem(item as any, cdnBaseUrl);
      if (downloaded === null) continue;
      out.push({
        kind: downloaded.kind as InboundMediaKind,
        data: downloaded.data instanceof Uint8Array ? downloaded.data : new Uint8Array(downloaded.data),
        ...(typeof (downloaded as any).fileName === 'string' ? { fileName: (downloaded as any).fileName } : {}),
      });
    } catch {
      // Caller logs aggregate failures; keep going for remaining items.
    }
  }
  return out;
}

/** Persist downloaded media under `destDir` (created if needed). */
export async function saveInboundMediaFiles(
  items: readonly DownloadedInboundMedia[],
  destDir: string,
  options: { maxBytes: number } = { maxBytes: 100 * 1024 * 1024 },
): Promise<SavedInboundMedia[]> {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const saved: SavedInboundMedia[] = [];
  let index = 0;
  for (const item of items) {
    if (item.data.byteLength <= 0) continue;
    if (item.data.byteLength > options.maxBytes) {
      throw new Error(`入站${item.kind}超过大小上限（${item.data.byteLength} > ${options.maxBytes}）`);
    }
    const mediaType = item.kind === 'image' ? sniffImageMediaType(item.data) : undefined;
    const base = safeFileName(item.fileName, item.kind, mediaType);
    const unique = saved.some((entry) => entry.fileName === base) ? `${index}-${base}` : base;
    index += 1;
    const path = join(destDir, unique);
    await writeFile(path, item.data, { mode: 0o600 });
    saved.push({
      kind: item.kind,
      path,
      bytes: item.data.byteLength,
      fileName: unique,
      ...(mediaType === undefined ? {} : { mediaType }),
    });
  }
  return saved;
}

export function describeSavedMedia(files: readonly SavedInboundMedia[]): string {
  if (files.length === 0) return '';
  const lines = ['用户通过微信发来了以下文件（已保存到会话工作区，可直接读取）：'];
  for (const file of files) {
    const label =
      file.kind === 'image' ? '图片' : file.kind === 'video' ? '视频' : file.kind === 'voice' ? '语音' : '文件';
    lines.push(`- [${label}] ${file.path}（${file.bytes} 字节）`);
  }
  return lines.join('\n');
}
