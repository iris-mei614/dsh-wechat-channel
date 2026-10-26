import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep, basename } from 'node:path';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.amr', '.silk']);

export function classifyMedia(filePath: string): MediaKind {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'file';
}

export interface ValidatedMedia {
  path: string;
  name: string;
  kind: MediaKind;
  size: number;
}

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export function isPathWithin(root: string, target: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(normalizedRoot);
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export interface ValidateOptions {
  roots: readonly string[];
  baseDir: string;
  maxBytes: number;
}

/**
 * Resolve and validate a media path.
 *
 * - relative paths resolve against the session cwd (or process cwd)
 * - symlinks are resolved before the containment check
 * - the file must be a regular file within one of the configured roots
 * - the size cap defaults to the iLink 100 MiB ceiling
 */
export async function validateMediaFile(filePath: string, options: ValidateOptions): Promise<ValidatedMedia> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new MediaValidationError('文件路径为空');
  }
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(options.baseDir, filePath);
  const resolved = (await canonical(absolute)) ?? absolute;

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new MediaValidationError(`文件不存在：${filePath}`);
  }

  const roots = options.roots.length > 0 ? options.roots : [resolve(options.baseDir)];
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    const real = (await canonical(root)) ?? resolve(root);
    canonicalRoots.push(real);
  }
  if (!canonicalRoots.some((root) => isPathWithin(root, resolved))) {
    throw new MediaValidationError(
      `拒绝发送工作区外的文件：${filePath}。可在插件配置 mediaRoots 中添加允许的根目录。`,
    );
  }

  if (!info.isFile()) throw new MediaValidationError(`不是普通文件：${filePath}`);
  if (info.size <= 0) throw new MediaValidationError(`文件为空：${filePath}`);
  if (info.size > options.maxBytes) {
    throw new MediaValidationError(
      `文件过大：${(info.size / 1024 / 1024).toFixed(1)} MiB，上限 ${(options.maxBytes / 1024 / 1024).toFixed(1)} MiB`,
    );
  }

  return { path: resolved, name: basename(resolved), kind: classifyMedia(resolved), size: info.size };
}

/** MIME type used by the iLink client's media routing. */
export function mimeOf(kind: MediaKind, filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (kind) {
    case 'image':
      return ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    case 'video':
      return ext === '.webm' ? 'video/webm' : 'video/mp4';
    case 'audio':
      return ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}
