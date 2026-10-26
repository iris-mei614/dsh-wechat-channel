import { formatDuration } from './text.js';
/**
 * Periodic “still working” pings for long WeChat-originated turns.
 * One tracker per session; a later deliver to the same session keeps the
 * original start time so elapsed time stays continuous.
 */
export class ProgressTracker {
    clock;
    onTick;
    entries = new Map();
    constructor(clock, onTick) {
        this.clock = clock;
        this.onTick = onTick;
    }
    start(sessionId, userId, intervalMs) {
        if (sessionId === '' || userId === '' || intervalMs <= 0)
            return;
        const existing = this.entries.get(sessionId);
        if (existing !== undefined) {
            existing.userId = userId;
            return;
        }
        const startedAt = this.clock.now();
        const entry = {
            userId,
            startedAt,
            activity: '',
            timer: setInterval(() => {
                const current = this.entries.get(sessionId);
                if (current === undefined)
                    return;
                const elapsedMs = Math.max(0, this.clock.now() - current.startedAt);
                const message = formatProgressMessage(elapsedMs, current.activity);
                void Promise.resolve(this.onTick({
                    sessionId,
                    userId: current.userId,
                    elapsedMs,
                    activity: current.activity,
                    message,
                })).catch(() => { });
            }, intervalMs),
        };
        // Do not keep the process alive solely for progress pings.
        if (typeof entry.timer === 'object' && entry.timer !== null && 'unref' in entry.timer && typeof entry.timer.unref === 'function') {
            entry.timer.unref();
        }
        this.entries.set(sessionId, entry);
    }
    /** Update the human-readable “current step” shown on the next progress ping. */
    setActivity(sessionId, activity) {
        const entry = this.entries.get(sessionId);
        if (entry === undefined)
            return;
        entry.activity = activity.trim();
    }
    stop(sessionId) {
        const entry = this.entries.get(sessionId);
        if (entry === undefined)
            return;
        clearInterval(entry.timer);
        this.entries.delete(sessionId);
    }
    stopAll() {
        for (const sessionId of [...this.entries.keys()])
            this.stop(sessionId);
    }
    isTracking(sessionId) {
        return this.entries.has(sessionId);
    }
    size() {
        return this.entries.size;
    }
}
export function formatProgressMessage(elapsedMs, activity = '') {
    const base = `仍在处理，已进行 ${formatDuration(elapsedMs)}…`;
    const step = activity.trim();
    if (step === '')
        return base;
    return `${base}\n当前：${step}`;
}
/** Map a raw tool / event name into a short Chinese activity line. */
export function describeToolActivity(toolName, detail = '') {
    const name = toolName.trim();
    const hint = detail.replace(/\s+/g, ' ').trim();
    const lower = name.toLowerCase();
    const withHint = (verb, fallback) => {
        if (hint === '')
            return fallback;
        return `${verb}${hint.length > 48 ? `${hint.slice(0, 47)}…` : hint}`;
    };
    if (lower === 'read' || lower === 'read_file' || lower === 'readfile') {
        return withHint('正在读文件 ', '正在读文件');
    }
    if (lower === 'write' || lower === 'write_file' || lower === 'edit' || lower === 'apply_patch' || lower === 'strreplace') {
        return withHint('正在写文件 ', '正在写文件');
    }
    if (lower === 'bash' || lower === 'shell' || lower === 'exec' || lower === 'run_terminal_cmd' || lower === 'terminal') {
        return withHint('正在跑命令 ', '正在跑命令');
    }
    if (lower === 'present' || lower === 'deliverables') {
        return withHint('正在准备交付 ', '正在准备交付文件');
    }
    if (lower === 'wechat_send')
        return '正在发回微信';
    if (lower.includes('search') || lower.includes('web')) {
        return withHint('正在搜索 ', '正在搜索');
    }
    if (lower.includes('browser') || lower.includes('navigate')) {
        return withHint('正在浏览 ', '正在使用浏览器');
    }
    if (name === '')
        return hint === '' ? '正在思考' : `正在处理：${hint.slice(0, 48)}`;
    return hint === '' ? `正在调用 ${name}` : `正在调用 ${name}（${hint.slice(0, 32)}）`;
}
