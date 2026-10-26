import { ApiClient } from 'wechat-ilink-client';
interface AudioMeta {
    encodeType: number;
    durationMs: number;
    sampleRate?: number;
    bitsPerSample?: number;
}
export declare function inspectWav(buffer: Buffer): {
    durationMs: number;
    sampleRate: number;
    bitsPerSample: number;
} | undefined;
export declare function audioMeta(filePath: string, buffer: Buffer): AudioMeta;
/**
 * iLink voice message upload/send. `wechat-ilink-client` 0.1.0 exposes
 * image/video/file sending but not voice, so this mirrors its outbound
 * `voice_item` shape while sharing the upload pipeline that understands both
 * `upload_full_url` and the legacy `upload_param`.
 */
export declare function sendVoice(api: ApiClient, to: string, filePath: string, contextToken: string): Promise<void>;
export {};
