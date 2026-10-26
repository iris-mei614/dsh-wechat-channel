import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describeToolActivity } from '../progress.js';
const WECHAT_SOURCE = 'wechat-channel';
/** Notices posted back into DSH when WeChat outbound fails; never marks turns as fromWechat. */
const WECHAT_NOTICE_SOURCE = 'wechat-channel-notice';
const MAX_TURN_STATES = 512;
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
/** Build a native frozen DSH user message without importing the host package. */
export function createWechatUserMessage(text, userId, messageId, attachments = []) {
    const content = [];
    if (text.trim() !== '')
        content.push({ type: 'text', text });
    for (const file of attachments) {
        if (file.attachment?.type === 'image') {
            content.push({ type: 'image', attachment: file.attachment.ref });
            continue;
        }
        if (file.attachment?.type === 'file') {
            content.push({ type: 'file', attachment: file.attachment.ref });
            continue;
        }
        // Fallback when attachments service is unavailable: keep a path hint in text only.
    }
    if (content.length === 0)
        content.push({ type: 'text', text: text || '(空消息)' });
    return deepFreeze({
        id: randomUUID(),
        role: 'user',
        content,
        source: {
            kind: WECHAT_SOURCE,
            userId,
            messageId,
        },
    });
}
/** Operator-facing notice that must not be treated as a WeChat-originated turn. */
export function createChannelNoticeMessage(text) {
    return deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
            kind: WECHAT_NOTICE_SOURCE,
        },
    });
}
function assistantText(event) {
    const content = event.data?.message?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            parts.push(block.text);
        }
    }
    return parts.join('\n').trim();
}
function detailFromInput(input) {
    if (typeof input === 'string')
        return input;
    if (typeof input !== 'object' || input === null)
        return '';
    const record = input;
    for (const key of ['path', 'file', 'file_path', 'filePath', 'command', 'cmd', 'query', 'url', 'target']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return '';
}
/** Best-effort activity line from session events / assistant content blocks. */
function activityFromEvent(event) {
    const data = event.data ?? {};
    const toolObj = typeof data.tool === 'object' && data.tool !== null ? data.tool : undefined;
    const directName = (typeof data.name === 'string' && data.name) ||
        (typeof data.toolName === 'string' && data.toolName) ||
        (typeof data.tool === 'string' && data.tool) ||
        (typeof toolObj?.name === 'string' && toolObj.name) ||
        '';
    if (directName !== '') {
        return describeToolActivity(directName, detailFromInput(data.input ?? data.args ?? data.arguments ?? toolObj?.input));
    }
    if (typeof event.type === 'string' && (event.type.startsWith('tool/') || event.type.includes('tool'))) {
        const suffix = event.type.split('/').pop() ?? event.type;
        if (suffix !== '' && suffix !== 'tool') {
            return describeToolActivity(suffix, detailFromInput(data.input ?? data.args ?? data.path ?? data.command));
        }
    }
    const content = data.message?.content;
    if (!Array.isArray(content))
        return undefined;
    for (const block of content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const type = String(block.type ?? '');
        if (type === 'tool_use' ||
            type === 'tool_call' ||
            type === 'function_call' ||
            type === 'tool-call' ||
            type === 'functionCall') {
            const name = String(block.name ?? block.toolName ?? block.function?.name ?? '');
            const detail = detailFromInput(block.input ?? block.arguments ?? block.args ?? block.function?.arguments);
            return describeToolActivity(name, detail);
        }
    }
    return undefined;
}
function turnKey(sessionId, turn) {
    return `${sessionId}#${turn}`;
}
function truncateNotice(value, max = 160) {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (clean.length <= max)
        return clean;
    return `${clean.slice(0, Math.max(1, max - 1))}…`;
}
function outcomeOf(reason) {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown';
    const known = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'];
    const normalized = (known.includes(kind) ? kind : 'unknown');
    let error;
    if (normalized === 'error') {
        error = reason?.error?.message ?? reason?.message ?? '未知错误';
    }
    else if (normalized === 'aborted') {
        const cause = reason?.reason?.kind;
        error = typeof cause === 'string' ? `已取消（${cause}）` : '已取消';
    }
    else if (normalized === 'blocked') {
        error = '任务被阻止';
    }
    return { kind: normalized, ...(error === undefined ? {} : { error }) };
}
/**
 * DSH host adapter.
 *
 * Delivery uses the same public primitives as `dsh-agent-message` in DSH
 * 0.1.x: `agents.followup/steer/inject` for live sessions and
 * `agents.resume` for offline ones, composed with the same Agent preset
 * (`agentPresets.mount`) so resumed sessions keep their tools.
 */
export class DshAgentBridge {
    ctx;
    config;
    log;
    handles = new Map();
    resumes = new Map();
    turnStates = new Map();
    turnListeners = new Set();
    activityListeners = new Set();
    disposers = [];
    disposed = false;
    constructor(ctx, config, log) {
        this.ctx = ctx;
        this.config = config;
        this.log = log;
        const onClaimed = (payload) => this.onInboxClaimed(payload);
        const onSessionEvent = (session, event) => this.onSessionEvent(session, event);
        this.disposers.push(ctx.on('agent/inbox/claimed', onClaimed));
        this.disposers.push(ctx.on('session/event', onSessionEvent));
        this.disposers.push(ctx.on('agent/disposed', (payload) => {
            const id = payload?.agent?.id;
            if (typeof id === 'string') {
                const pending = this.handles.get(id);
                if (pending !== undefined) {
                    void pending.then((handle) => {
                        if (handle.agent === payload.agent)
                            this.handles.delete(id);
                    }, () => { });
                }
            }
        }));
    }
    get agents() {
        const service = this.ctx.get('agents');
        if (service === undefined)
            throw new Error('DSH 缺少 agents 服务');
        return service;
    }
    get query() {
        return this.ctx.get('sessionQuery');
    }
    liveAgent(sessionId) {
        try {
            return this.agents.get(sessionId);
        }
        catch {
            return undefined;
        }
    }
    isArchived(sessionId) {
        const workspace = this.ctx.get('workspaceRegistry');
        if (workspace === undefined || !Array.isArray(workspace.archivedSessionIds))
            return false;
        return workspace.archivedSessionIds.some((id) => String(id) === sessionId);
    }
    assertPeer(sessionId, header) {
        if (this.isArchived(sessionId))
            throw new Error('目标会话已归档，无法通过微信通道投递（请先取消归档）');
        const origin = header?.origin ?? this.liveAgent(sessionId)?.session?.header?.origin;
        if (origin === 'subagent')
            throw new Error('目标是子代理，不能通过微信通道投递');
    }
    defaultAgentOptions() {
        const service = this.ctx.get('agentDefaultModel');
        if (service === undefined)
            return {};
        try {
            const selection = service.currentSelection();
            return {
                provider: selection?.provider ?? '',
                model: selection?.model ?? '',
                ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            };
        }
        catch {
            return {};
        }
    }
    async inspectSession(sessionId) {
        const query = this.query;
        if (query === undefined)
            return undefined;
        try {
            return await query.readSession(sessionId);
        }
        catch (error) {
            if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
                return undefined;
            this.log.debug('读取会话失败：%s', error instanceof Error ? error.message : String(error));
            return undefined;
        }
    }
    async compose(presetHint) {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined)
            return {};
        const requested = this.config.agentPreset || presetHint || presets.defaultId;
        try {
            const resolved = await presets.resolve(requested);
            return {
                agentPreset: resolved.id,
                setup: async (agentCtx) => {
                    await presets.mount(agentCtx, resolved.id);
                },
            };
        }
        catch (error) {
            this.log.warn('解析 Agent preset 失败，将使用宿主默认组合：%s', error instanceof Error ? error.message : String(error));
            return {};
        }
    }
    async deliver(sessionId, text, mode, source, attachments = []) {
        this.assertPeer(sessionId);
        if (mode === 'steer' || mode === 'inject') {
            const live = this.liveAgent(sessionId);
            if (live === undefined || live.status !== 'running') {
                throw new Error(`${mode} 仅用于正在运行的会话；当前状态：${live?.status ?? 'offline'}`);
            }
        }
        const agent = (await this.ensureLive(sessionId));
        const message = createWechatUserMessage(text, source.userId, source.messageId, attachments);
        if (mode === 'steer')
            agent.steer(message);
        else if (mode === 'inject')
            agent.inject(message);
        else
            agent.followup(message);
        return { messageId: String(message.id) };
    }
    /**
     * Push a short operator notice into a *live* session without resuming offline
     * ones and without marking the turn as WeChat-originated.
     */
    async notifySession(sessionId, text) {
        const trimmed = text.trim();
        if (sessionId === '' || trimmed === '')
            return false;
        const live = this.liveAgent(sessionId);
        if (live === undefined) {
            this.log.warn('微信通道通知未送达 DSH（会话离线）：%s', truncateNotice(trimmed));
            return false;
        }
        const message = createChannelNoticeMessage(`[微信通道] ${trimmed}`);
        try {
            // Prefer inject so we do not start a billed followup turn just for a notice.
            if (typeof live.inject === 'function') {
                live.inject(message);
                return true;
            }
            if (typeof live.followup === 'function') {
                live.followup(message);
                return true;
            }
        }
        catch (error) {
            this.log.warn('向 DSH 会话写入微信通道通知失败：%s', error instanceof Error ? error.message : String(error));
            return false;
        }
        return false;
    }
    async ensureLive(sessionId) {
        const live = this.liveAgent(sessionId);
        if (live !== undefined)
            return live;
        const pending = this.resumes.get(sessionId);
        if (pending !== undefined)
            return pending;
        const promise = (async () => {
            const inspected = await this.inspectSession(sessionId);
            if (inspected === undefined && this.query !== undefined) {
                throw new Error(`会话不存在：${sessionId}`);
            }
            const header = inspected?.session ?? {};
            this.assertPeer(sessionId, header);
            const composition = await this.compose(header.agentPreset);
            let handle;
            try {
                handle = await this.agents.resume({
                    resumeSessionId: sessionId,
                    agentOptions: this.defaultAgentOptions(),
                    ...(composition.setup === undefined ? {} : { setup: composition.setup }),
                });
            }
            catch (error) {
                const concurrent = this.liveAgent(sessionId);
                if (concurrent !== undefined)
                    return concurrent;
                throw error;
            }
            this.handles.set(sessionId, Promise.resolve(handle));
            return handle.agent;
        })();
        this.resumes.set(sessionId, promise);
        try {
            return await promise;
        }
        finally {
            this.resumes.delete(sessionId);
        }
    }
    async createSession(cwd) {
        if (typeof this.agents.create !== 'function')
            throw new Error('DSH 缺少 agents.create，无法新建会话');
        const directory = resolve(cwd || this.config.newSessionCwd || process.cwd());
        await mkdir(directory, { recursive: true });
        const composition = await this.compose();
        const sessionId = `session-${randomUUID()}`;
        const handle = await this.agents.create({
            sessionId,
            agentOptions: this.defaultAgentOptions(),
            meta: {
                cwd: directory,
                ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
            },
            ...(composition.setup === undefined ? {} : { setup: composition.setup }),
        });
        this.handles.set(sessionId, Promise.resolve(handle));
        return sessionId;
    }
    /**
     * Pin a WeChat-originated display title through DSH `sessionTitle.rename`.
     * Uses the live session object; resumes offline sessions when needed.
     */
    async setSessionTitle(sessionId, title) {
        const trimmed = title.trim();
        if (sessionId === '' || trimmed === '')
            return false;
        const service = this.ctx.get('sessionTitle');
        if (service === undefined || typeof service.rename !== 'function') {
            this.log.debug('DSH 无 sessionTitle 服务，跳过会话命名');
            return false;
        }
        try {
            const agent = await this.ensureLive(sessionId);
            service.rename(agent.session, trimmed);
            this.log.info('已将会话 %s 命名为：%s', sessionId, trimmed);
            return true;
        }
        catch (error) {
            this.log.warn('设置会话标题失败：%s', error instanceof Error ? error.message : String(error));
            return false;
        }
    }
    async listSessions() {
        const archived = new Set();
        const workspace = this.ctx.get('workspaceRegistry');
        if (workspace !== undefined && Array.isArray(workspace.archivedSessionIds)) {
            for (const id of workspace.archivedSessionIds)
                archived.add(String(id));
        }
        const rows = [];
        const query = this.query;
        if (query !== undefined && typeof query.listSessions === 'function') {
            let records = [];
            try {
                records = await query.listSessions();
            }
            catch (error) {
                this.log.warn('列出持久化会话失败：%s', error instanceof Error ? error.message : String(error));
            }
            for (const record of records) {
                const header = record?.header;
                const id = header?.id;
                if (typeof id !== 'string')
                    continue;
                if (archived.has(id) || header.origin === 'subagent')
                    continue;
                const live = this.liveAgent(id);
                rows.push({
                    id,
                    title: '',
                    cwd: typeof header.cwd === 'string' ? header.cwd : '',
                    status: live === undefined ? 'offline' : live.status,
                });
            }
        }
        else {
            for (const live of this.agents.list()) {
                const id = String(live.id);
                if (archived.has(id) || live.session?.header?.origin === 'subagent')
                    continue;
                rows.push({
                    id,
                    title: '',
                    cwd: typeof live.session?.header?.cwd === 'string' ? live.session.header.cwd : '',
                    status: live.status,
                });
            }
        }
        if (query !== undefined && typeof query.readTitleSnapshots === 'function' && rows.length > 0) {
            try {
                const snapshots = await query.readTitleSnapshots(rows.map((row) => row.id));
                const titles = new Map();
                for (const snapshot of snapshots) {
                    if (snapshot?.status === 'fulfilled' && typeof snapshot.value?.title?.title === 'string') {
                        titles.set(String(snapshot.sessionId), snapshot.value.title.title);
                    }
                }
                for (const row of rows)
                    row.title = titles.get(row.id) ?? '';
            }
            catch (error) {
                this.log.debug('读取会话标题失败：%s', error instanceof Error ? error.message : String(error));
            }
        }
        const rank = (status) => (status === 'running' ? 0 : status === 'idle' ? 1 : 2);
        rows.sort((a, b) => {
            const diff = rank(a.status) - rank(b.status);
            if (diff !== 0)
                return diff;
            return (a.title || '~').localeCompare(b.title || '~', 'zh-CN');
        });
        return rows.map((row) => ({
            ...row,
            live: row.status !== 'offline',
            title: row.title || `(无标题 · ${row.id.replace(/^session-/, '').slice(0, 8)})`,
        }));
    }
    async sessionStatus(sessionId) {
        const live = this.liveAgent(sessionId);
        const inspected = live === undefined ? await this.inspectSession(sessionId) : undefined;
        const header = live?.session?.header ?? inspected?.session;
        if (live === undefined && inspected === undefined) {
            return { id: sessionId, title: '', status: 'offline', exists: false };
        }
        let title = '';
        const query = this.query;
        if (query !== undefined && typeof query.readTitle === 'function') {
            try {
                const snapshot = await query.readTitle(sessionId);
                if (typeof snapshot?.title === 'string')
                    title = snapshot.title;
            }
            catch {
                // ignore
            }
        }
        return {
            id: sessionId,
            title,
            status: live === undefined ? 'offline' : live.status,
            exists: true,
            ...(typeof header?.cwd === 'string' ? { cwd: header.cwd } : {}),
        };
    }
    async cancelSession(sessionId) {
        const live = this.liveAgent(sessionId);
        if (live === undefined)
            return false;
        live.cancel({ kind: 'user' });
        return true;
    }
    async resolveSession(idOrPrefix) {
        const value = idOrPrefix.trim();
        if (value === '')
            return undefined;
        const sessions = await this.listSessions();
        const exact = sessions.find((session) => session.id === value);
        if (exact !== undefined)
            return exact.id;
        const matches = sessions.filter((session) => session.id.startsWith(value));
        if (matches.length === 1)
            return matches[0].id;
        const inspected = await this.inspectSession(value);
        if (inspected === undefined)
            return undefined;
        const header = inspected?.session;
        if (this.isArchived(value) || header?.origin === 'subagent')
            return undefined;
        return value;
    }
    async sessionCwd(sessionId) {
        const live = this.liveAgent(sessionId);
        if (typeof live?.session?.header?.cwd === 'string')
            return live.session.header.cwd;
        const inspected = await this.inspectSession(sessionId);
        return typeof inspected?.session?.cwd === 'string' ? inspected.session.cwd : undefined;
    }
    onTurnComplete(listener) {
        this.turnListeners.add(listener);
        return () => this.turnListeners.delete(listener);
    }
    onTurnActivity(listener) {
        this.activityListeners.add(listener);
        return () => this.activityListeners.delete(listener);
    }
    emitActivity(sessionId, activity) {
        const trimmed = activity.trim();
        if (sessionId === '' || trimmed === '')
            return;
        for (const listener of this.activityListeners) {
            try {
                listener({ sessionId, activity: trimmed });
            }
            catch (error) {
                this.log.warn('turn 活动回调失败：%s', error instanceof Error ? error.message : String(error));
            }
        }
    }
    currentModelLabel() {
        const service = this.ctx.get('agentDefaultModel');
        if (service === undefined || typeof service.currentSelection !== 'function')
            return '';
        try {
            const selection = service.currentSelection();
            const provider = typeof selection?.provider === 'string' ? selection.provider : '';
            const model = typeof selection?.model === 'string' ? selection.model : '';
            if (provider !== '' && model !== '')
                return `${provider}/${model}`;
            return model || provider;
        }
        catch {
            return '';
        }
    }
    async listModels() {
        const service = this.ctx.get('agentDefaultModel');
        if (service === undefined)
            return [];
        const candidates = [service.list, service.listModels, service.available, service.options].filter((value) => typeof value === 'function');
        for (const method of candidates) {
            try {
                const raw = await method.call(service);
                if (!Array.isArray(raw))
                    continue;
                const labels = [];
                for (const entry of raw) {
                    if (typeof entry === 'string' && entry.trim() !== '') {
                        labels.push(entry.trim());
                        continue;
                    }
                    if (typeof entry !== 'object' || entry === null)
                        continue;
                    const provider = typeof entry.provider === 'string' ? entry.provider : '';
                    const model = typeof entry.model === 'string' ? entry.model : '';
                    const id = typeof entry.id === 'string' ? entry.id : '';
                    const label = provider !== '' && model !== '' ? `${provider}/${model}` : model || id || provider;
                    if (label !== '')
                        labels.push(label);
                }
                if (labels.length > 0)
                    return [...new Set(labels)].slice(0, 40);
            }
            catch {
                // try next shape
            }
        }
        return [];
    }
    async selectModel(spec) {
        const value = spec.trim();
        if (value === '')
            return { ok: false, message: '用法：/model <模型名>' };
        const service = this.ctx.get('agentDefaultModel');
        if (service === undefined) {
            return { ok: false, message: '当前 DSH 未暴露模型切换接口，请在 DSH 界面里改默认模型。' };
        }
        let provider = '';
        let model = value;
        const slash = value.indexOf('/');
        if (slash > 0) {
            provider = value.slice(0, slash).trim();
            model = value.slice(slash + 1).trim();
        }
        const payloads = [
            { provider, model },
            { provider: provider || undefined, model },
            value,
            { id: value },
        ];
        const methods = ['select', 'set', 'setSelection', 'choose'].filter((name) => typeof service[name] === 'function');
        for (const name of methods) {
            for (const payload of payloads) {
                try {
                    await service[name](payload);
                    const current = this.currentModelLabel();
                    return {
                        ok: true,
                        message: current === '' ? `已请求切换模型：${value}` : `已切换默认模型：${current}`,
                    };
                }
                catch {
                    // try next
                }
            }
        }
        return {
            ok: false,
            message: `无法通过微信切换模型「${value}」。请在 DSH 界面修改默认模型；发送 /model 可查看当前模型。`,
        };
    }
    async clearSession(sessionId) {
        if (sessionId !== '') {
            try {
                await this.cancelSession(sessionId);
            }
            catch {
                // ignore
            }
        }
        const cwd = sessionId === '' ? undefined : await this.sessionCwd(sessionId).catch(() => undefined);
        return this.createSession(cwd);
    }
    onInboxClaimed(payload) {
        const source = payload?.message?.source;
        if (source?.kind !== WECHAT_SOURCE)
            return;
        const sessionId = String(payload?.agent?.id ?? '');
        const turn = Number(payload?.turn);
        if (sessionId === '' || !Number.isSafeInteger(turn))
            return;
        const key = turnKey(sessionId, turn);
        let state = this.turnStates.get(key);
        if (state === undefined) {
            state = { sessionId, turn, fromWechat: true, text: '', files: [], createdAt: Date.now() };
            this.turnStates.set(key, state);
        }
        else {
            state.fromWechat = true;
        }
        this.pruneTurns();
    }
    onSessionEvent(session, event) {
        const sessionId = String(session?.id ?? '');
        if (sessionId === '' || event === undefined)
            return;
        const turn = Number(event.data?.turn);
        if (!Number.isSafeInteger(turn))
            return;
        const key = turnKey(sessionId, turn);
        if (event.type === 'turn/start') {
            const existing = this.turnStates.get(key);
            if (existing === undefined) {
                this.turnStates.set(key, {
                    sessionId,
                    turn,
                    fromWechat: false,
                    text: '',
                    files: [],
                    createdAt: Date.now(),
                });
            }
            this.pruneTurns();
            return;
        }
        if (event.type === 'assistant/message') {
            const state = this.turnStates.get(key);
            if (state === undefined)
                return;
            const text = assistantText(event);
            if (text !== '')
                state.text = text;
            const activity = activityFromEvent(event);
            if (activity !== undefined)
                this.emitActivity(sessionId, activity);
            return;
        }
        if (event.type === 'deliverables/presented') {
            const state = this.turnStates.get(key);
            if (state === undefined)
                return;
            const files = event.data?.files;
            if (!Array.isArray(files))
                return;
            for (const file of files) {
                if (typeof file?.path !== 'string' || file.path === '')
                    continue;
                if (state.files.some((entry) => entry.path === file.path))
                    continue;
                state.files.push({
                    path: file.path,
                    ...(typeof file.description === 'string' ? { description: file.description } : {}),
                });
            }
            this.emitActivity(sessionId, describeToolActivity('present'));
            return;
        }
        const toolActivity = activityFromEvent(event);
        if (toolActivity !== undefined && event.type !== 'turn/end') {
            this.emitActivity(sessionId, toolActivity);
            if (event.type.startsWith('tool/') || event.type.includes('tool'))
                return;
        }
        if (event.type !== 'turn/end')
            return;
        const state = this.turnStates.get(key);
        this.turnStates.delete(key);
        if (state === undefined)
            return;
        if (!state.fromWechat && !this.config.notifyAllTurns)
            return;
        const outcome = outcomeOf(event.data?.reason);
        const result = {
            sessionId,
            turn,
            kind: outcome.kind,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
            text: state.text,
            files: state.files,
            fromWechat: state.fromWechat,
        };
        for (const listener of this.turnListeners) {
            try {
                listener(result);
            }
            catch (error) {
                this.log.warn('turn 完成回调失败：%s', error instanceof Error ? error.message : String(error));
            }
        }
    }
    pruneTurns() {
        if (this.turnStates.size <= MAX_TURN_STATES)
            return;
        const entries = [...this.turnStates.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (let index = 0; index < entries.length - MAX_TURN_STATES; index += 1) {
            this.turnStates.delete(entries[index][0]);
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const dispose of this.disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // ignore
            }
        }
        const handles = [...this.handles.values()];
        this.handles.clear();
        const settled = await Promise.allSettled(handles.map(async (pending) => {
            const handle = await pending;
            await handle.dispose();
        }));
        for (const result of settled) {
            if (result.status === 'rejected') {
                this.log.warn('释放会话句柄失败：%s', result.reason instanceof Error ? result.reason.message : String(result.reason));
            }
        }
    }
}
