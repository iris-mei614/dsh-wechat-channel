import { randomUUID } from 'node:crypto';
import { COMMAND_HELP, formatSessionList, resolveSwitchArgument } from '../commands.js';
/** Local WeChat slash-commands; kept out of WechatChannel to shrink the orchestrator. */
export async function runWechatCommand(deps, userId, name, args) {
    try {
        switch (name) {
            case 'help': {
                await deps.sendReply(userId, COMMAND_HELP);
                return;
            }
            case 'bind': {
                if (args === '') {
                    await deps.sendReply(userId, '用法：/bind <sessionId>\n不知道 ID 的话，先发 /list 看看。');
                    return;
                }
                const resolved = await deps.bridge.resolveSession(args);
                if (resolved === undefined) {
                    await deps.sendReply(userId, `找不到这个会话：${args}\n发 /list 看看有哪些。`);
                    return;
                }
                deps.setActiveSession(resolved);
                const status = await deps.bridge.sessionStatus(resolved);
                await deps.sendReply(userId, [
                    '好，已绑到这个会话：',
                    resolved,
                    `状态：${status.status === 'running' ? '忙碌中' : status.status === 'idle' ? '空闲' : status.status}`,
                    ...(status.title ? [`标题：${status.title}`] : []),
                ].join('\n'));
                return;
            }
            case 'new': {
                const current = deps.state.get().activeSessionId;
                const cwd = deps.config.newSessionCwd || (current === '' ? undefined : await deps.bridge.sessionCwd(current));
                const created = await deps.bridge.createSession(cwd);
                deps.noteUntitledSession(created);
                deps.setActiveSession(created);
                await deps.sendReply(userId, [
                    '已开好新会话并切过去了。',
                    created,
                    `工作目录：${cwd ?? process.cwd()}`,
                    '下一条消息会用来命名：[微信会话] + 内容摘要。',
                ].join('\n'));
                return;
            }
            case 'clear': {
                const current = deps.state.get().activeSessionId;
                if (typeof deps.bridge.clearSession !== 'function') {
                    await deps.sendReply(userId, '当前环境不支持 /clear，可改用 /new 开新会话。');
                    return;
                }
                const created = await deps.bridge.clearSession(current);
                deps.noteUntitledSession(created);
                deps.setActiveSession(created);
                await deps.sendReply(userId, [
                    '已清空对话上下文（开了新会话）。',
                    `现在用：${created}`,
                    '下一条消息会用来命名：[微信会话] + 内容摘要。',
                    current === '' ? undefined : '原来的会话还在，发 /list 可以切回去。',
                ]
                    .filter((line) => typeof line === 'string')
                    .join('\n'));
                return;
            }
            case 'list': {
                const sessions = await deps.bridge.listSessions();
                deps.state.update((data) => {
                    data.listSnapshot = sessions.slice(0, 30).map((session) => ({ id: session.id, title: session.title }));
                });
                await deps.sendReply(userId, formatSessionList(sessions, deps.state.get().activeSessionId));
                return;
            }
            case 'switch': {
                let snapshot = deps.state.get().listSnapshot;
                if (snapshot.length === 0) {
                    const sessions = await deps.bridge.listSessions();
                    snapshot = sessions.slice(0, 30).map((session) => ({ id: session.id, title: session.title }));
                    deps.state.update((data) => {
                        data.listSnapshot = snapshot;
                    });
                }
                const resolved = resolveSwitchArgument(args, snapshot);
                if (resolved.error !== undefined) {
                    await deps.sendReply(userId, resolved.error);
                    return;
                }
                const id = resolved.id;
                const verified = await deps.bridge.resolveSession(id);
                if (verified === undefined) {
                    await deps.sendReply(userId, `找不到这个会话：${id}\n发 /list 再选一次吧。`);
                    return;
                }
                deps.setActiveSession(verified, false);
                await deps.sendReply(userId, `已切过去：\n${verified}`);
                return;
            }
            case 'status': {
                await deps.sendReply(userId, await deps.formatStatus());
                return;
            }
            case 'model': {
                const current = typeof deps.bridge.currentModelLabel === 'function' ? deps.bridge.currentModelLabel() : '';
                if (args === '') {
                    const listed = typeof deps.bridge.listModels === 'function' ? await deps.bridge.listModels() : [];
                    const lines = [
                        current === '' ? '当前默认模型：未知（可在 DSH 界面查看）' : `当前默认模型：${current}`,
                    ];
                    if (listed.length > 0) {
                        lines.push('', '可尝试切换（示例）：');
                        for (const label of listed.slice(0, 12))
                            lines.push(`· /model ${label}`);
                    }
                    else {
                        lines.push('', '切换：/model <provider/model>，若宿主不支持会提示去 DSH 界面改。');
                    }
                    await deps.sendReply(userId, lines.join('\n'));
                    return;
                }
                if (typeof deps.bridge.selectModel !== 'function') {
                    await deps.sendReply(userId, '当前环境不能通过微信切模型，请在 DSH 界面修改。');
                    return;
                }
                const result = await deps.bridge.selectModel(args);
                await deps.sendReply(userId, result.message);
                return;
            }
            case 'retry': {
                const ok = await deps.retryLastFailure(userId);
                if (!ok) {
                    await deps.sendReply(userId, '没有可重试的失败投递。直接发消息即可。');
                }
                return;
            }
            case 'stop': {
                const activeSessionId = deps.state.get().activeSessionId;
                if (activeSessionId === '') {
                    await deps.sendReply(userId, '还没绑定会话呢。发点文字，或 /new 开一个。');
                    return;
                }
                const cancelled = await deps.bridge.cancelSession(activeSessionId);
                await deps.sendReply(userId, cancelled ? '已让当前任务停下来。' : '现在没有正在跑的任务，不用停。');
                return;
            }
            case 'steer': {
                if (args === '') {
                    await deps.sendReply(userId, '用法：/steer <要补充的内容>\n例如：/steer 先别改代码，只分析。');
                    return;
                }
                const activeSessionId = deps.state.get().activeSessionId;
                if (activeSessionId === '') {
                    await deps.sendReply(userId, '还没绑定会话呢。');
                    return;
                }
                const status = await deps.bridge.sessionStatus(activeSessionId);
                if (status.status !== 'running') {
                    await deps.sendReply(userId, `现在没有正在跑的任务（状态：${status.status}），直接发普通文字就行。`);
                    return;
                }
                await deps.deliverText(userId, args, 'steer', `steer-${randomUUID()}`);
                await deps.sendReply(userId, '已把这句补充进当前任务。');
                return;
            }
            default: {
                await deps.sendReply(userId, `没认出这个命令。\n\n${COMMAND_HELP}`);
            }
        }
    }
    catch (error) {
        deps.noteError(error);
        deps.logError('命令 /%s 执行失败：%s', name, deps.describeError(error));
        await deps.sendReply(userId, `命令没成功：${deps.describeError(error)}\n可以发「重试」再试一次。`).catch(() => { });
    }
}
