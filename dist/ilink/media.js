import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { MessageItemType, MessageState, MessageType, aesEcbPaddedSize, buildCdnUploadUrl, encryptAesEcb, generateId, } from 'wechat-ilink-client';
function isLocalHost(hostname) {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}
/**
 * The server hands back a pre-signed CDN URL. It must be an official WeChat
 * host (or the configured CDN host) so a compromised/buggy response cannot
 * turn the plugin into an SSRF primitive.
 */
export function assertTrustedUploadUrl(raw, cdnBaseUrl) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error('getUploadUrl returned an invalid upload_full_url');
    }
    const host = url.hostname.toLowerCase();
    let cdnHost = '';
    try {
        cdnHost = new URL(cdnBaseUrl).hostname.toLowerCase();
    }
    catch {
        // ignore malformed configured CDN base
    }
    const official = host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com');
    const sameCdn = cdnHost !== '' && (host === cdnHost || host.endsWith(`.${cdnHost}`));
    const local = isLocalHost(host);
    if (!official && !sameCdn && !local) {
        throw new Error('getUploadUrl returned an untrusted upload host; refusing to upload media');
    }
    if (url.protocol !== 'https:' && !local) {
        throw new Error('getUploadUrl returned a non-HTTPS upload URL; refusing to upload media');
    }
    return url.toString();
}
async function postEncryptedCiphertext(url, ciphertext) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: new Uint8Array(ciphertext),
            });
            if (response.status >= 400 && response.status < 500) {
                throw new Error(`CDN upload client error ${response.status}`);
            }
            if (response.status !== 200) {
                throw new Error(`CDN upload server error ${response.status}`);
            }
            const downloadParam = response.headers.get('x-encrypted-param');
            if (downloadParam === null || downloadParam === '') {
                throw new Error('CDN upload response missing x-encrypted-param header');
            }
            return downloadParam;
        }
        catch (error) {
            lastError = error;
            if (error instanceof Error && error.message.includes('client error'))
                throw error;
            if (attempt < 3)
                await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
    throw lastError instanceof Error ? lastError : new Error('CDN upload failed');
}
/**
 * Upload one file to the iLink CDN.
 *
 * iLink used to return only `upload_param`; the live service now returns
 * `upload_full_url` (with the encrypted query already embedded). Both shapes
 * are accepted so the plugin survives either rollout.
 */
export async function uploadMedia(api, filePath, toUserId, mediaType) {
    const plaintext = await readFile(filePath);
    const rawsize = plaintext.length;
    if (rawsize === 0)
        throw new Error('media file is empty');
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    const response = (await api.getUploadUrl({
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
    }));
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const fullUrl = response.upload_full_url ?? response.uploadFullUrl;
    let downloadParam;
    let uploadMode;
    if (typeof fullUrl === 'string' && fullUrl !== '') {
        downloadParam = await postEncryptedCiphertext(assertTrustedUploadUrl(fullUrl, api.cdnBaseUrl), ciphertext);
        uploadMode = 'upload_full_url';
    }
    else if (typeof response.upload_param === 'string' && response.upload_param !== '') {
        const url = buildCdnUploadUrl({ cdnBaseUrl: api.cdnBaseUrl, uploadParam: response.upload_param, filekey });
        downloadParam = await postEncryptedCiphertext(url, ciphertext);
        uploadMode = 'upload_param';
    }
    else {
        // Never echo the response: it can contain a long-lived signed URL.
        throw new Error('getUploadUrl returned neither upload_full_url nor upload_param (iLink protocol changed?)');
    }
    return {
        filekey,
        downloadEncryptedQueryParam: downloadParam,
        aeskey: aeskey.toString('hex'),
        fileSize: rawsize,
        fileSizeCiphertext: filesize,
        uploadMode,
    };
}
function buildRequest(to, contextToken, item) {
    return {
        msg: {
            from_user_id: '',
            to_user_id: to,
            client_id: generateId('wechat-channel'),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [item],
            context_token: contextToken,
        },
    };
}
function mediaRef(uploaded) {
    // Mirrors wechat-ilink-client's outbound CDNMedia shape.
    return {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
        encrypt_type: 1,
    };
}
export async function sendImageMessage(api, to, uploaded, contextToken) {
    await api.sendMessage(buildRequest(to, contextToken, {
        type: MessageItemType.IMAGE,
        image_item: {
            media: mediaRef(uploaded),
            mid_size: uploaded.fileSizeCiphertext,
        },
    }));
}
export async function sendVideoMessage(api, to, uploaded, contextToken) {
    await api.sendMessage(buildRequest(to, contextToken, {
        type: MessageItemType.VIDEO,
        video_item: {
            media: mediaRef(uploaded),
            video_size: uploaded.fileSizeCiphertext,
        },
    }));
}
export async function sendFileMessage(api, to, filePath, uploaded, contextToken) {
    await api.sendMessage(buildRequest(to, contextToken, {
        type: MessageItemType.FILE,
        file_item: {
            media: mediaRef(uploaded),
            file_name: basename(filePath),
            len: String(uploaded.fileSize),
        },
    }));
}
