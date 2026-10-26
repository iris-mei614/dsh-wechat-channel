import { readFile } from 'node:fs/promises';
import { MessageItemType, MessageState, MessageType, UploadMediaType, generateId, } from 'wechat-ilink-client';
import { uploadMedia } from './media.js';
export function inspectWav(buffer) {
    if (buffer.length < 44)
        return undefined;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
        return undefined;
    let offset = 12;
    let byteRate = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (chunkId === 'fmt ' && chunkSize >= 16 && body + 16 <= buffer.length) {
            sampleRate = buffer.readUInt32LE(body + 4);
            byteRate = buffer.readUInt32LE(body + 8);
            bitsPerSample = buffer.readUInt16LE(body + 14);
        }
        if (chunkId === 'data' && byteRate > 0) {
            const durationMs = Math.round((chunkSize / byteRate) * 1000);
            return { durationMs, sampleRate, bitsPerSample };
        }
        offset = body + chunkSize + (chunkSize % 2);
    }
    return undefined;
}
export function audioMeta(filePath, buffer) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.wav')) {
        const wav = inspectWav(buffer);
        if (wav !== undefined) {
            return {
                encodeType: 1,
                durationMs: Math.max(0, wav.durationMs),
                sampleRate: wav.sampleRate,
                bitsPerSample: wav.bitsPerSample,
            };
        }
        return { encodeType: 1, durationMs: 0 };
    }
    if (lower.endsWith('.ogg')) {
        return { encodeType: 8, durationMs: 0 };
    }
    // MP3, M4A and AAC are most reliable as MP3-labelled voice payloads.
    // 128 kbps is only used to seed a display duration; playback follows the file.
    return { encodeType: 7, durationMs: Math.round((buffer.length * 8) / 128_000 * 1000) };
}
/**
 * iLink voice message upload/send. `wechat-ilink-client` 0.1.0 exposes
 * image/video/file sending but not voice, so this mirrors its outbound
 * `voice_item` shape while sharing the upload pipeline that understands both
 * `upload_full_url` and the legacy `upload_param`.
 */
export async function sendVoice(api, to, filePath, contextToken) {
    const uploaded = await uploadMedia(api, filePath, to, UploadMediaType.VOICE);
    const plaintext = await readFile(filePath);
    const meta = audioMeta(filePath, plaintext);
    await api.sendMessage({
        msg: {
            from_user_id: '',
            to_user_id: to,
            client_id: generateId('wechat-channel'),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: [
                {
                    type: MessageItemType.VOICE,
                    voice_item: {
                        media: {
                            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                            aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
                            encrypt_type: 1,
                        },
                        encode_type: meta.encodeType,
                        playtime: meta.durationMs,
                        ...(meta.sampleRate === undefined ? {} : { sample_rate: meta.sampleRate }),
                        ...(meta.bitsPerSample === undefined ? {} : { bits_per_sample: meta.bitsPerSample }),
                    },
                },
            ],
        },
    });
}
//# sourceMappingURL=audio.js.map