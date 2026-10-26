import { ApiClient } from 'wechat-ilink-client';
export interface UploadedMedia {
    filekey: string;
    /** CDN download parameter to place in CDNMedia.encrypt_query_param. */
    downloadEncryptedQueryParam: string;
    /** AES-128 key as 32 hex characters. */
    aeskey: string;
    fileSize: number;
    fileSizeCiphertext: number;
    uploadMode: 'upload_full_url' | 'upload_param';
}
/**
 * The server hands back a pre-signed CDN URL. It must be an official WeChat
 * host (or the configured CDN host) so a compromised/buggy response cannot
 * turn the plugin into an SSRF primitive.
 */
export declare function assertTrustedUploadUrl(raw: string, cdnBaseUrl: string): string;
/**
 * Upload one file to the iLink CDN.
 *
 * iLink used to return only `upload_param`; the live service now returns
 * `upload_full_url` (with the encrypted query already embedded). Both shapes
 * are accepted so the plugin survives either rollout.
 */
export declare function uploadMedia(api: ApiClient, filePath: string, toUserId: string, mediaType: number): Promise<UploadedMedia>;
export declare function sendImageMessage(api: ApiClient, to: string, uploaded: UploadedMedia, contextToken: string): Promise<void>;
export declare function sendVideoMessage(api: ApiClient, to: string, uploaded: UploadedMedia, contextToken: string): Promise<void>;
export declare function sendFileMessage(api: ApiClient, to: string, filePath: string, uploaded: UploadedMedia, contextToken: string): Promise<void>;
//# sourceMappingURL=media.d.ts.map