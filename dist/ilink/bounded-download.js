import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, stat, mkdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseAesKey } from 'wechat-ilink-client';
/** Download/decrypt on disk; memory use is bounded by the stream chunks. */
export async function boundedDownload(url, key, maxBytes, parent) {
    if (parent)
        await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(parent ?? tmpdir(), 'dsh-wechat-'));
    const encrypted = join(dir, `${randomUUID()}.download`);
    const path = key ? join(dir, `${randomUUID()}.media`) : encrypted;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok || !response.body)
            throw new Error(`网络错误（HTTP ${response.status}）`);
        const reader = response.body.getReader();
        const handle = await open(encrypted, 'wx', 0o600);
        let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                bytes += value.byteLength;
                if (bytes > maxBytes + (key ? 16 : 0))
                    throw new Error('附件超过消息大小上限');
                await handle.writeFile(value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
            await handle.close();
        }
        if (key) {
            try {
                await pipeline(createReadStream(encrypted), createDecipheriv('aes-128-ecb', parseAesKey(key), null), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
            }
            catch {
                throw new Error('附件解密失败');
            }
            await rm(encrypted);
        }
        const size = (await stat(path)).size;
        if (size > maxBytes)
            throw new Error('附件超过消息大小上限');
        return { path, bytes: size, cleanupDir: dir };
    }
    catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
    }
}
