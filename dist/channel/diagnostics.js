import { open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function inspectWorkspace(directory) {
    const probe = join(directory, `.wechat-probe-${randomUUID()}`);
    const lines = [];
    try {
        const handle = await open(probe, 'wx', 0o600);
        try {
            await handle.writeFile('probe');
        }
        finally {
            await handle.close();
        }
        lines.push('工作目录：可写');
    }
    catch {
        lines.push('工作目录：不可写或不存在，请检查会话目录与权限');
    }
    finally {
        await rm(probe, { force: true }).catch(() => { });
    }
    try {
        const disk = await statfs(directory);
        const mib = Math.floor(disk.bavail * disk.bsize / 1024 / 1024);
        lines.push(`可用空间：${mib} MiB${mib < 200 ? '（偏低，请清理磁盘）' : ''}`);
    }
    catch {
        lines.push('可用空间：无法读取');
    }
    const [major, minor] = process.versions.node.split('.').map(Number);
    const supported = major === 22 ? minor >= 19 : major === 24;
    lines.push(`Node.js：${process.versions.node}${supported ? '（受 CI 覆盖）' : '（未受 CI 覆盖，建议 Node 22.19+ 或 24）'}`);
    return lines;
}
