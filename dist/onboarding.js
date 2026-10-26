import { formatDuration } from './text.js';
const PHASE_LABELS = {
    starting: '启动中',
    'need-login': '待扫码登录',
    'need-first-message': '待微信首条消息激活',
    'need-session': '待绑定 DSH 会话',
    ready: '已就绪',
    expired: '登录已过期',
    reconnecting: '重连中',
    error: '出错',
    stopped: '已停止',
};
export function resolveSetupPhase(input) {
    const { status, hasCredentials, hasContextToken, hasOwner, hasActiveSession, lastInboundAt, windowHours, now, loginQrUrl, } = input;
    if (status === 'starting') {
        return { phase: 'starting', label: PHASE_LABELS.starting, nextAction: '等待插件完成启动。' };
    }
    if (status === 'stopped') {
        return { phase: 'stopped', label: PHASE_LABELS.stopped, nextAction: '重新启动 DSH / 插件。' };
    }
    if (status === 'expired') {
        return {
            phase: 'expired',
            label: PHASE_LABELS.expired,
            nextAction: '调用 wechat_login（或开启 autoRelogin）重新扫码。',
        };
    }
    if (status === 'error' && !hasCredentials) {
        return {
            phase: 'error',
            label: PHASE_LABELS.error,
            nextAction: loginQrUrl
                ? `检查登录流程后重试；当前二维码：${loginQrUrl}`
                : '调用 wechat_login 重新获取二维码。',
        };
    }
    if (!hasCredentials) {
        return {
            phase: 'need-login',
            label: PHASE_LABELS['need-login'],
            nextAction: loginQrUrl
                ? `用微信扫描二维码：${loginQrUrl}`
                : '调用 wechat_login 获取扫码链接，或配置 botTokenRef / 环境变量。',
        };
    }
    if (status === 'reconnecting') {
        return {
            phase: 'reconnecting',
            label: PHASE_LABELS.reconnecting,
            nextAction: '等待网络恢复；长轮询会自动重试。',
        };
    }
    if (!hasContextToken || !hasOwner || lastInboundAt <= 0) {
        return {
            phase: 'need-first-message',
            label: PHASE_LABELS['need-first-message'],
            nextAction: '在微信里给 Bot 发任意一条消息（例如「你好」），以取得 context_token 并激活回复。',
        };
    }
    if (!hasActiveSession) {
        return {
            phase: 'need-session',
            label: PHASE_LABELS['need-session'],
            nextAction: '在微信发送 /new 新建会话，或 /bind <sessionId> 绑定已有会话。',
        };
    }
    const maxAge = windowHours * 3_600_000;
    const remaining = Math.max(0, lastInboundAt + maxAge - now);
    return {
        phase: 'ready',
        label: PHASE_LABELS.ready,
        nextAction: remaining > 0
            ? `直接发文字交给 Agent；主动推送窗口还剩 ${formatDuration(remaining)}。`
            : `主动推送窗口已过期；请先在微信发一条消息再触发推送。`,
        windowRemainingMs: remaining,
    };
}
/** Steps shown when a QR login starts. */
export function loginGuidanceMessage(qrUrl) {
    return [
        '请用微信扫描二维码完成 Bot 登录。',
        '',
        '接下来三步：',
        '1. 打开下方链接（或扫描 DSH 终端里的二维码）',
        '2. 在手机微信中确认登录',
        '3. 登录成功后，在微信里给 Bot 发任意一条消息以激活回复能力',
        '',
        `二维码：${qrUrl}`,
    ].join('\n');
}
export function loginInProgressMessage(qrUrl) {
    return [
        '扫码登录正在进行中，请使用当前二维码。',
        '',
        '确认登录后，请在微信里给 Bot 发任意一条消息以激活通道。',
        '',
        `二维码：${qrUrl}`,
    ].join('\n');
}
export function alreadyLoggedInMessage(setup) {
    if (setup.phase === 'ready')
        return `通道已登录且就绪。${setup.nextAction}`;
    return `通道已登录。下一步：${setup.nextAction}`;
}
/** Logged (and optionally echoed) right after a successful QR confirmation. */
export function postLoginNextStepsLog() {
    return [
        '微信扫码登录成功。',
        '下一步：在手机微信打开该 Bot，发送任意一条消息（例如「你好」）。',
        '收到首条消息后通道才会拿到 context_token，才能回复和主动推送。',
    ].join(' ');
}
export function welcomeAfterActivate(options) {
    const lines = [
        '欢迎使用 DSH 微信通道，通道已激活。',
        options.autoCreated
            ? `已自动新建并绑定会话：\n${options.sessionId}`
            : `当前绑定会话：\n${options.sessionId}`,
    ];
    if (options.processingFirstText) {
        lines.push('', '正在处理你的第一条消息…');
    }
    else {
        lines.push('', '直接发文字即可交给 Agent；发送 /help 查看命令。');
    }
    return lines.join('\n');
}
export function unboundSessionHint(autoCreateEnabled) {
    if (autoCreateEnabled) {
        return '尚未绑定 DSH 会话。发送任意文字将自动新建会话；也可 /bind <sessionId> 绑定已有会话。';
    }
    return '尚未绑定 DSH 会话。\n发送 /bind <sessionId> 绑定已有会话，或 /new 新建一个。';
}
/**
 * Best-effort terminal QR rendering. Missing `qrcode-terminal` is fine —
 * callers always still print the URL.
 */
export async function printQrToTerminal(url, log) {
    try {
        const mod = await import('qrcode-terminal');
        const api = mod?.default ?? mod;
        if (typeof api?.generate !== 'function')
            return false;
        await new Promise((resolve) => {
            api.generate(url, { small: true }, (output) => {
                for (const line of String(output).split('\n'))
                    log(line);
                resolve();
            });
        });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=onboarding.js.map