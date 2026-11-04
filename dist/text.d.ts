/**
 * Make single line breaks visible on desktop WeChat.
 *
 * Phone WeChat draws iLink bot text as plain text, so `\n` is a line break.
 * Desktop WeChat draws the same payload as Markdown: a lone `\n` is a soft
 * break and shows up as a space, and trailing spaces are discarded, so a
 * Markdown hard break does not survive. A blank line (`\n\n`) is a paragraph
 * and renders on both clients. Fenced code and Markdown tables stay intact.
 */
export declare function hardenWechatLineBreaks(text: string): string;
/** Split text into WeChat-sized chunks without cutting UTF-16 surrogate pairs. */
export declare function splitText(text: string, maxChars: number): string[];
/** Truncate a label for command output. */
export declare function truncate(value: string, maxChars: number): string;
/** Format a compact duration such as `3m12s` / `2h05m` for status output. */
export declare function formatDuration(ms: number): string;
/** Render an ISO timestamp in the host's local timezone. */
export declare function formatTimestamp(ms: number): string;
