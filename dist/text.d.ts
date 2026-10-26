/** Split text into WeChat-sized chunks without cutting UTF-16 surrogate pairs. */
export declare function splitText(text: string, maxChars: number): string[];
/** Truncate a label for command output. */
export declare function truncate(value: string, maxChars: number): string;
/** Format a compact duration such as `3m12s` / `2h05m` for status output. */
export declare function formatDuration(ms: number): string;
/** Render an ISO timestamp in the host's local timezone. */
export declare function formatTimestamp(ms: number): string;
