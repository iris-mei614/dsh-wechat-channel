import { describeError } from './log.js';
import { readFile } from 'node:fs/promises';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/**
 * Promote saved inbound files into durable DSH attachment refs when the host
 * exposes `ctx.attachments`. Failures are non-fatal: the workspace path still
 * reaches the Agent via the text summary.
 */
export async function attachSavedMediaToDsh(ctx, saved, logger) {
    const attachments = ctx.get?.('attachments');
    const results = [];
    for (const file of saved) {
        const base = {
            path: file.path,
            kind: file.kind,
            fileName: file.fileName,
            bytes: file.bytes,
            ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
        };
        if (attachments === undefined) {
            results.push(base);
            continue;
        }
        try {
            if (file.kind === 'image' && typeof attachments.saveImage === 'function') {
                const data = new Uint8Array(await readFile(file.path));
                const mediaType = file.mediaType && IMAGE_TYPES.has(file.mediaType) ? file.mediaType : undefined;
                if (mediaType !== undefined) {
                    const ref = await attachments.saveImage({ data, mediaType, name: file.fileName });
                    results.push({ ...base, attachment: { type: 'image', ref: { ...ref } } });
                    continue;
                }
            }
            if (typeof attachments.saveFile === 'function') {
                const data = new Uint8Array(await readFile(file.path));
                const ref = await attachments.saveFile({ data, name: file.fileName });
                results.push({ ...base, attachment: { type: 'file', ref: { ...ref } } });
                continue;
            }
        }
        catch (error) {
            logger.warn('写入 DSH attachments 失败，仍保留工作区文件 %s：%s', file.path, describeError(error));
        }
        results.push(base);
    }
    return results;
}
