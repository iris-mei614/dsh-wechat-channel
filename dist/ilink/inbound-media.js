import { boundedDownload } from './bounded-download.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, copyFile, constants } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { buildCdnDownloadUrl, MessageItemType } from 'wechat-ilink-client';
/** Detect common image MIME types from magic bytes. */
export function sniffImageMediaType(data) {
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
        return 'image/png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'image/jpeg';
    if (data.length >= 12 &&
        data[0] === 0x52 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x46 &&
        data[8] === 0x57 &&
        data[9] === 0x45 &&
        data[10] === 0x42 &&
        data[11] === 0x50) {
        return 'image/webp';
    }
    if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46)
        return 'image/gif';
    return undefined;
}
function defaultExtension(kind, mediaType) {
    if (mediaType === 'image/png')
        return '.png';
    if (mediaType === 'image/jpeg')
        return '.jpg';
    if (mediaType === 'image/webp')
        return '.webp';
    if (mediaType === 'image/gif')
        return '.gif';
    if (kind === 'image')
        return '.jpg';
    if (kind === 'video')
        return '.mp4';
    if (kind === 'voice')
        return '.silk';
    return '.bin';
}
function safeFileName(name, kind, mediaType) {
    const raw = typeof name === 'string' ? basename(name.trim()) : '';
    const cleaned = raw.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/, '');
    if (cleaned !== '' && cleaned !== '_' && cleaned.length <= 120) {
        if (extname(cleaned) === '')
            return `${cleaned}${defaultExtension(kind, mediaType)}`;
        return cleaned;
    }
    return `${kind}-${Date.now()}${defaultExtension(kind, mediaType)}`;
}
/**
 * Download decryptable media items from a WeChat inbound message's raw item_list.
 * Text/voice-STT-only items are skipped.
 */
export async function downloadInboundMediaItems(rawItems, cdnBaseUrl, maxBytes = 100 * 1024 * 1024, stageOnDisk = false, stagingRoot) {
    const out = [];
    const mediaItems = rawItems.filter((item) => item && [2, 3, 4, 5].includes(item.type) && item[['', '', 'image_item', 'voice_item', 'file_item', 'video_item'][item.type] ?? '']?.media?.encrypt_query_param);
    if (mediaItems.length > 20)
        throw new Error('单条消息附件过多（最多 20 项）');
    let total = 0;
    let mediaIndex = 0;
    const failures = [];
    for (const item of rawItems) {
        if (typeof item !== 'object' || item === null)
            continue;
        const typed = item;
        if (typed.type !== MessageItemType.IMAGE &&
            typed.type !== MessageItemType.FILE &&
            typed.type !== MessageItemType.VIDEO &&
            typed.type !== MessageItemType.VOICE) {
            continue;
        }
        mediaIndex += 1;
        try {
            const raw = item;
            const kind = typed.type === MessageItemType.IMAGE ? 'image' : typed.type === MessageItemType.FILE ? 'file'
                : typed.type === MessageItemType.VIDEO ? 'video' : 'voice';
            const payload = raw[`${kind}_item`];
            if (!payload?.media?.encrypt_query_param)
                continue;
            const key = kind === 'image' && payload.aeskey
                ? Buffer.from(payload.aeskey, 'hex').toString('base64') : payload.media.aes_key;
            if (kind !== 'image' && !key)
                throw new Error('附件解密失败：缺少密钥');
            const downloaded = await boundedDownload(buildCdnDownloadUrl(payload.media.encrypt_query_param, cdnBaseUrl), key, maxBytes - total, stagingRoot);
            total += downloaded.bytes;
            if (stageOnDisk) {
                out.push({ kind, tempPath: downloaded.path, cleanupDir: downloaded.cleanupDir, bytes: downloaded.bytes, fileName: payload.file_name });
            }
            else {
                try {
                    out.push({ kind, data: await readFile(downloaded.path), fileName: payload.file_name });
                }
                finally {
                    await rm(downloaded.cleanupDir, { recursive: true, force: true });
                }
            }
        }
        catch (error) {
            const reason = error instanceof Error && /大小上限|解密失败|HTTP/.test(error.message) ? error.message : '网络连接失败或下载超时';
            failures.push(`第 ${mediaIndex} 个：${reason}`);
        }
    }
    if (failures.length > 0) {
        for (const entry of out)
            if (entry.cleanupDir)
                await rm(entry.cleanupDir, { recursive: true, force: true });
        throw new Error(`附件下载失败：成功 ${out.length} 个，失败 ${failures.length} 个（${failures.join('；')}）。本批次未投递，请重新发送。`);
    }
    return out;
}
/** Persist downloaded media under `destDir` (created if needed). */
export async function saveInboundMediaFiles(items, destDir, options = { maxBytes: 100 * 1024 * 1024 }) {
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    const saved = [];
    for (const item of items) {
        const bytes = item.data?.byteLength ?? item.bytes ?? 0;
        if (bytes <= 0)
            continue;
        if (bytes > options.maxBytes) {
            throw new Error(`入站${item.kind}超过大小上限（${bytes} > ${options.maxBytes}）`);
        }
        let header = item.data;
        if (!header && item.tempPath) {
            const { open } = await import('node:fs/promises');
            const handle = await open(item.tempPath, 'r');
            try {
                header = Buffer.alloc(16);
                await handle.read(header, 0, 16, 0);
            }
            finally {
                await handle.close();
            }
        }
        const mediaType = item.kind === 'image' && header ? sniffImageMediaType(header) : undefined;
        const persist = async (target) => {
            if (item.tempPath)
                await copyFile(item.tempPath, target, constants.COPYFILE_EXCL);
            else if (item.data)
                await writeFile(target, item.data, { mode: 0o600, flag: 'wx' });
            else
                throw new Error('附件数据缺失');
        };
        const base = safeFileName(item.fileName, item.kind, mediaType);
        let unique = base;
        let path = join(destDir, unique);
        try {
            await persist(path);
        }
        catch (error) {
            if (error?.code !== 'EEXIST')
                throw error;
            unique = `${randomUUID()}-${base}`;
            path = join(destDir, unique);
            await persist(path);
        }
        saved.push({
            kind: item.kind,
            path,
            bytes: bytes,
            fileName: unique,
            ...(mediaType === undefined ? {} : { mediaType }),
        });
    }
    return saved;
}
export function describeSavedMedia(files) {
    if (files.length === 0)
        return '';
    const lines = ['用户通过微信发来了以下文件（已保存到会话工作区，可直接读取）：'];
    for (const file of files) {
        const label = file.kind === 'image' ? '图片' : file.kind === 'video' ? '视频' : file.kind === 'voice' ? '语音' : '文件';
        lines.push(`- [${label}] ${file.path}（${file.bytes} 字节）`);
    }
    return lines.join('\n');
}
