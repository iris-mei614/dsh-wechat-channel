/** Words that flush a held media batch immediately (no extra caption). */
const FLUSH_KEYWORDS = new Set([
    '开始',
    '分析',
    '继续',
    '好',
    '好的',
    'ok',
    'OK',
    'go',
    'start',
    'analyze',
]);
export function isMediaFlushKeyword(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return false;
    if (FLUSH_KEYWORDS.has(trimmed))
        return true;
    return /^(开始|分析|继续)([!！。.~]*)$/.test(trimmed);
}
/**
 * Holds media-only inbound messages briefly so a following WeChat text caption
 * can be merged into one DSH turn (WeChat often sends image and text separately).
 */
export class MediaHoldBuffer {
    options;
    pending = new Map();
    constructor(options) {
        this.options = options;
    }
    has(userId) {
        return this.pending.has(userId);
    }
    get(userId) {
        const entry = this.pending.get(userId);
        if (entry === undefined)
            return undefined;
        const { timer: _timer, ...batch } = entry;
        return batch;
    }
    /** Store or append media and (re)start the hold timer. */
    hold(batch) {
        const existing = this.pending.get(batch.userId);
        if (existing !== undefined)
            clearTimeout(existing.timer);
        const merged = {
            userId: batch.userId,
            attachments: [...(existing?.attachments ?? []), ...batch.attachments],
            mediaText: [existing?.mediaText, batch.mediaText].filter((part) => part && part.trim() !== '').join('\n'),
            wasFirstInbound: existing?.wasFirstInbound === true || batch.wasFirstInbound,
            sourceMessageId: batch.sourceMessageId,
            createdAt: existing?.createdAt ?? batch.createdAt ?? this.options.clock.now(),
        };
        const timer = setTimeout(() => {
            this.pending.delete(batch.userId);
            void Promise.resolve(this.options.onTimeout(merged)).catch(() => { });
        }, Math.max(0, this.options.holdMs));
        if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
            timer.unref();
        }
        this.pending.set(batch.userId, { ...merged, timer });
    }
    /** Take and clear a held batch (e.g. when caption text arrives). */
    take(userId) {
        const entry = this.pending.get(userId);
        if (entry === undefined)
            return undefined;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        const { timer: _timer, ...batch } = entry;
        return batch;
    }
    clear(userId) {
        this.take(userId);
    }
    clearAll() {
        for (const userId of [...this.pending.keys()])
            this.clear(userId);
    }
    size() {
        return this.pending.size;
    }
}
export function formatMediaHoldPrompt(fileCount, holdMs) {
    const seconds = Math.max(1, Math.round(holdMs / 1000));
    const what = fileCount <= 1 ? '文件' : `${fileCount} 个文件`;
    return [
        `已收到${what}，暂未开始分析。`,
        `请补充文字说明（会和文件一起交给 DSH）。`,
        `不输入文字说明将在 ${seconds} 秒后开始工作。`,
        `也可发送「开始」立即分析。`,
    ].join('\n');
}
//# sourceMappingURL=media-hold.js.map