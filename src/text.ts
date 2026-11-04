/**
 * Make single line breaks visible on desktop WeChat.
 *
 * Phone WeChat draws iLink bot text as plain text, so `\n` is a line break.
 * Desktop WeChat draws the same payload as Markdown: a lone `\n` is a soft
 * break and shows up as a space, and trailing spaces are discarded, so a
 * Markdown hard break does not survive. A blank line (`\n\n`) is a paragraph
 * and renders on both clients. Fenced code and Markdown tables stay intact.
 */
export function hardenWechatLineBreaks(text: string): string {
  const source = text.replace(/\r\n/g, '\n');
  let result = '';
  let index = 0;
  while (index < source.length) {
    const fence = source.indexOf('```', index);
    const plainEnd = fence === -1 ? source.length : fence;
    result += hardenPlainLineBreaks(source.slice(index, plainEnd));
    if (fence === -1) break;
    const close = source.indexOf('```', fence + 3);
    if (close === -1) {
      result += source.slice(fence);
      break;
    }
    result += source.slice(fence, close + 3);
    index = close + 3;
  }
  return result;
}

function hardenPlainLineBreaks(text: string): string {
  return text.replace(/([^\n])\n(?!\n)/g, (match, prev, offset, whole) => {
    const lineStart = whole.lastIndexOf('\n', offset - 1) + 1;
    const line = whole.slice(lineStart, offset + 1);
    const nextStart = offset + 2;
    const nextBreak = whole.indexOf('\n', nextStart);
    const nextLine = whole.slice(nextStart, nextBreak === -1 ? whole.length : nextBreak);
    if (line.trimStart().startsWith('|') && nextLine.trimStart().startsWith('|')) return match;
    return `${prev}\n\n`;
  });
}

/** Split text into WeChat-sized chunks without cutting UTF-16 surrogate pairs. */
export function splitText(text: string, maxChars: number): string[] {
  const source = text.replace(/\r\n/g, '\n').trimEnd();
  if (source.length === 0) return [];
  if (source.length <= maxChars) return [source];

  const parts: string[] = [];
  let rest = source;

  while (rest.length > maxChars) {
    let cut = -1;
    const window = rest.slice(0, maxChars + 1);
    const newline = window.lastIndexOf('\n');
    if (newline >= Math.floor(maxChars * 0.5)) cut = newline;
    if (cut < 0) {
      const boundary = /[。！？!?；;，,\s]/g;
      let match: RegExpExecArray | null;
      while ((match = boundary.exec(window)) !== null) cut = match.index + 1;
      if (cut < Math.floor(maxChars * 0.5)) cut = -1;
    }
    if (cut < 0) cut = maxChars;
    // Never split a surrogate pair.
    if (cut > 0 && cut < rest.length) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    if (cut <= 0) cut = Math.max(1, maxChars);
    const piece = rest.slice(0, cut).trimEnd();
    if (piece.length > 0) parts.push(piece);
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim().length > 0) parts.push(rest.trimEnd());
  return parts;
}

/** Truncate a label for command output. */
export function truncate(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Format a compact duration such as `3m12s` / `2h05m` for status output. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${String(rest).padStart(2, '0')}m`;
}

/** Render an ISO timestamp in the host's local timezone. */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '无';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}
