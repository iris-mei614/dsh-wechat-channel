import { truncate } from './text.js';
const TITLE_PREFIX = '[微信会话]';
const SUMMARY_MAX_CHARS = 28;
/** Collapse inbound text into a short title summary. */
export function summarizeForSessionTitle(text, maxChars = SUMMARY_MAX_CHARS) {
    const cleaned = text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        // Prefer the user's caption over the plugin's media path appendix.
        .filter((line) => !line.startsWith('用户通过微信发送了'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (cleaned === '')
        return '新会话';
    return truncate(cleaned, maxChars);
}
/** Final display title: `[微信会话] 首条消息摘要`. */
export function formatWechatSessionTitle(firstMessageOrSummary) {
    const summary = summarizeForSessionTitle(firstMessageOrSummary);
    return `${TITLE_PREFIX} ${summary}`;
}
//# sourceMappingURL=session-title.js.map