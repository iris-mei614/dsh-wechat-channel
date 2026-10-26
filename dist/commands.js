import { truncate } from './text.js';
const ALIASES = {
    // English
    help: 'help',
    new: 'new',
    list: 'list',
    switch: 'switch',
    status: 'status',
    stop: 'stop',
    bind: 'bind',
    steer: 'steer',
    clear: 'clear',
    model: 'model',
    retry: 'retry',
    // Chinese aliases
    帮助: 'help',
    新建: 'new',
    列表: 'list',
    切换: 'switch',
    状态: 'status',
    停止: 'stop',
    绑定: 'bind',
    介入: 'steer',
    清空: 'clear',
    新对话: 'clear',
    模型: 'model',
    重试: 'retry',
};
/**
 * Parse a plugin-local command. Returns `null` for ordinary text.
 * `/steer <text>` is deliberately a command so it can choose the steering
 * delivery mode; plain text always uses `followup`.
 *
 * Bare keywords like `重试` (no leading slash) are accepted for a few
 * high-frequency actions so WeChat users can tap-reply without typing `/`.
 */
export function parseCommand(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return null;
    if (!trimmed.startsWith('/')) {
        const bare = ALIASES[trimmed.toLowerCase()] ?? ALIASES[trimmed];
        if (bare === 'retry' || bare === 'help' || bare === 'status' || bare === 'clear' || bare === 'list') {
            return { name: bare, args: '' };
        }
        return null;
    }
    const match = /^\/([^\s/]+)(?:[\s\u3000]+([\s\S]*))?$/.exec(trimmed);
    if (match === null)
        return null;
    const rawName = match[1] ?? '';
    const name = ALIASES[rawName.toLowerCase()] ?? ALIASES[rawName] ?? 'unknown';
    return { name, args: (match[2] ?? '').trim() };
}
export const COMMAND_HELP = [
    'DSH 微信通道命令：',
    '/new — 开一个新会话并切过去',
    '/clear — 清空当前对话（开新会话，旧的还在）',
    '/list — 看看有哪些会话可以切换',
    '/switch <序号|ID> — 切到指定会话',
    '/bind <sessionId> — 绑定一个已有会话',
    '/status — 通道是否正常、会话与待补发',
    '/model — 查看当前模型；/model <名> 尝试切换',
    '/stop — 停下正在做的任务',
    '/steer <文本> — 给正在跑的任务补充一句',
    '/retry 或直接发「重试」— 再试上一次失败的投递',
    '/help — 显示本帮助',
    '',
    '首次使用：扫码登录 Bot → 在微信发任意消息激活 → 直接发文字交给 Agent。',
    '只发图片时，可在提示后补充文字；发「开始」可立刻分析。',
].join('\n');
function statusBadge(status) {
    if (status === 'running')
        return '忙碌中';
    if (status === 'idle')
        return '空闲';
    return '未打开';
}
/** Render `/list` output and keep the 1-based indices used by `/switch`. */
export function formatSessionList(sessions, activeSessionId) {
    if (sessions.length === 0) {
        return [
            '现在还没有可切换的会话。',
            '发 /new 开一个新的，或 /bind <sessionId> 绑一个已有的。',
        ].join('\n');
    }
    const lines = [
        '这些是可以切换的会话：',
        '回复 /switch 1（或对应序号）即可切过去。',
        '',
    ];
    sessions.slice(0, 30).forEach((session, index) => {
        const marker = session.id === activeSessionId ? ' ← 正在用这个' : '';
        const title = truncate(session.title || '(无标题)', 32);
        lines.push(`${index + 1}. ${title}（${statusBadge(session.status)}）${marker}`);
    });
    if (sessions.length > 30) {
        lines.push(`… 还有 ${sessions.length - 30} 个没列全，可用 /bind <完整ID> 直接绑定。`);
    }
    return lines.join('\n');
}
/** Resolve a `/switch` argument against the most recent `/list` snapshot. */
export function resolveSwitchArgument(argument, snapshot) {
    const value = argument.trim();
    if (value === '')
        return { error: '用法：/switch <序号或会话ID>。可先发 /list 看列表。' };
    if (/^\d+$/.test(value)) {
        const index = Number(value) - 1;
        if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.length) {
            return { error: `序号不对。请先发 /list，再选 1-${snapshot.length || 0} 之间的数字。` };
        }
        return { id: snapshot[index].id };
    }
    const exact = snapshot.find((entry) => entry.id === value);
    if (exact !== undefined)
        return { id: exact.id };
    const matches = snapshot.filter((entry) => entry.id.startsWith(value));
    if (matches.length === 1)
        return { id: matches[0].id };
    if (matches.length > 1)
        return { error: `「${value}」对上了多个会话，请把 ID 再写长一点。` };
    return { id: value };
}
//# sourceMappingURL=commands.js.map