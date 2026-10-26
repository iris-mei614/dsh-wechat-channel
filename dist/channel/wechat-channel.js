import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from '../log.js';
import { OutboundQueue, RateLimiter, realClock } from '../rate-limit.js';
import { splitText, truncate, formatTimestamp, formatDuration } from '../text.js';
import { extractInboundText } from '../ilink/transport.js';
import { parseCommand } from '../commands.js';
import { MediaValidationError, validateMediaFile } from '../media.js';
import { alreadyLoggedInMessage, loginGuidanceMessage, loginInProgressMessage, postLoginNextStepsLog, printQrToTerminal, resolveSetupPhase, unboundSessionHint, welcomeAfterActivate, } from '../onboarding.js';
import { ProgressTracker } from '../progress.js';
import { LoginPageServer } from '../login-page.js';
import { runWechatCommand } from './command-runtime.js';
import { describeSavedMedia, saveInboundMediaFiles } from '../ilink/inbound-media.js';
import { attachSavedMediaToDsh } from '../attachments.js';
import { MediaHoldBuffer, formatMediaHoldPrompt, isMediaFlushKeyword, } from '../media-hold.js';
import { formatWechatSessionTitle } from '../session-title.js';
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const MAX_QR_REFRESHES = 3;
function isAbortError(error) {
    return error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted');
}
function sleep(ms, signal) {
    return realClock.sleep(ms, signal);
}
/**
 * The channel owns every policy decision the iLink client intentionally leaves
 * to its caller: login, cursor persistence, reconnect/backoff, the 24-hour
 * window, context-token caching, command handling, rate limiting, retries and
 * turn-completion notifications.
 */
export class WechatChannel {
    state;
    ctx;
    config;
    transport;
    bridge;
    logger;
    redactor;
    clock;
    queue;
    abortController;
    started = false;
    stopped = false;
    status = 'starting';
    credentials;
    lastError = '';
    lastPollAt = 0;
    pollTimeoutMs;
    pollTask;
    loginPoller;
    loginStarting;
    loginQr;
    unsubscribeTurn;
    unsubscribeActivity;
    windowWarnedForInboundAt = 0;
    /** Sessions created from WeChat that still need a first-message title. */
    pendingWechatTitles = new Set();
    lastRetryable = new Map();
    progress;
    loginPage;
    mediaHold;
    constructor(deps) {
        this.ctx = deps.ctx;
        this.config = deps.config;
        this.state = deps.state;
        this.transport = deps.transport;
        this.bridge = deps.bridge;
        this.logger = deps.logger;
        this.redactor = deps.redactor;
        this.clock = deps.clock ?? realClock;
        this.pollTimeoutMs = deps.config.longPollTimeoutMs;
        this.queue = new OutboundQueue(new RateLimiter(deps.config.rateLimitPerMinute, 60_000, this.clock), {
            limit: deps.config.queueLimit,
            onError: (error) => {
                this.noteError(error);
                this.logger.error('出站队列任务失败：%s', describeError(error));
            },
        });
        this.progress = new ProgressTracker(this.clock, async (tick) => {
            try {
                await this.sendReply(tick.userId, tick.message);
                this.logger.info('已向微信发送进度：会话 %s，%s', tick.sessionId, tick.message);
            }
            catch (error) {
                this.logger.warn('进度推送失败：%s', describeError(error));
            }
        });
        this.loginPage = new LoginPageServer(() => this.loginPageSnapshot());
        this.mediaHold = new MediaHoldBuffer({
            holdMs: deps.config.inboundMediaHoldMs,
            clock: this.clock,
            onTimeout: (batch) => this.flushHeldMedia(batch, '请分析用户通过微信发来的媒体。'),
        });
    }
    get signal() {
        if (this.abortController === undefined)
            throw new Error('channel not started');
        return this.abortController.signal;
    }
    /** Start login-resolution and the long-poll loop. Safe to call once. */
    async start() {
        if (this.started)
            return;
        this.started = true;
        this.abortController = new AbortController();
        await this.state.load();
        if (this.config.defaultSessionId !== '' && this.state.get().activeSessionId === '') {
            this.state.update((data) => {
                data.activeSessionId = this.config.defaultSessionId;
            });
        }
        if (this.config.ownerUserId !== '' && this.state.get().ownerUserId === '') {
            this.state.update((data) => {
                data.ownerUserId = this.config.ownerUserId;
            });
        }
        this.unsubscribeTurn = this.bridge.onTurnComplete((result) => {
            void this.onTurnComplete(result);
        });
        if (typeof this.bridge.onTurnActivity === 'function') {
            this.unsubscribeActivity = this.bridge.onTurnActivity((info) => {
                this.progress.setActivity(info.sessionId, info.activity);
            });
        }
        this.logger.info('通道启动，状态文件：%s', this.state.path);
        await this.resolveToken();
        if (this.credentials === undefined) {
            // DSH's credential provider may finish loading slightly after the
            // channel fiber activates. Re-resolve briefly before falling back to a
            // fresh QR login; a token already on disk should not trigger a rescan.
            const deadline = Date.now() + 5_000;
            while (!this.signal.aborted && Date.now() < deadline) {
                await this.safeSleep(250, this.signal);
                await this.resolveToken();
                if (this.credentials !== undefined)
                    break;
            }
        }
        this.pollTask = this.pollLoop();
        if (this.credentials === undefined) {
            this.status = 'waiting-login';
            if (this.config.autoLogin) {
                void this.beginLogin().catch((error) => {
                    this.noteError(error);
                    this.logger.error('自动登录失败：%s', describeError(error));
                });
            }
            else {
                this.logger.warn('尚未配置 Bot Token，且 autoLogin=false；请在微信中重新扫码或设置 %s', this.config.botTokenRef);
            }
        }
    }
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.status = 'stopped';
        this.unsubscribeTurn?.();
        this.unsubscribeTurn = undefined;
        this.unsubscribeActivity?.();
        this.unsubscribeActivity = undefined;
        this.progress.stopAll();
        this.mediaHold.clearAll();
        this.lastRetryable.clear();
        this.pendingWechatTitles.clear();
        await this.loginPage.stop().catch(() => { });
        this.abortController?.abort();
        this.queue.stop();
        try {
            await this.pollTask;
        }
        catch (error) {
            if (!isAbortError(error))
                this.logger.debug('停止轮询时出错：%s', describeError(error));
        }
        if (this.loginPoller !== undefined) {
            // A QR-status request has its own HTTP timeout; do not block unload for
            // the whole timeout when the channel is being stopped.
            await Promise.race([
                this.loginPoller.catch(() => { }),
                new Promise((resolve) => setTimeout(resolve, 1_000)),
            ]);
        }
        await this.transport.dispose();
        await this.state.close();
    }
    async resolveToken() {
        let token;
        const credentials = this.ctx.get('credentials');
        if (credentials !== undefined && typeof credentials.resolve === 'function') {
            try {
                const resolved = await credentials.resolve(this.config.botTokenRef);
                if (typeof resolved?.value === 'string' && resolved.value !== '')
                    token = resolved.value;
            }
            catch (error) {
                this.logger.warn('从 DSH 凭据读取 Bot Token 失败：%s', describeError(error));
            }
        }
        if (token === undefined) {
            const env = process.env[this.config.botTokenRef];
            if (typeof env === 'string' && env.trim() !== '')
                token = env.trim();
        }
        if (token === undefined)
            return;
        const data = this.state.get();
        this.setCredentials({
            token,
            accountId: data.accountId || this.config.accountId || undefined,
            baseUrl: data.baseUrl || this.config.baseUrl,
        });
        this.logger.info('已加载 Bot 凭据（account=%s）', this.credentials?.accountId ?? 'unknown');
    }
    setCredentials(credentials) {
        this.credentials = { ...credentials };
        this.redactor.add(credentials.token);
        this.transport.setCredentials(this.credentials);
    }
    async pollLoop() {
        let backoff = 1_000;
        const signal = this.signal;
        while (!signal.aborted) {
            if (this.credentials === undefined) {
                this.status = this.status === 'expired' ? 'expired' : 'waiting-login';
                await this.safeSleep(1_000, signal);
                continue;
            }
            this.status = 'connected';
            try {
                const response = await this.transport.getUpdates(this.state.get().syncBuf, this.pollTimeoutMs, signal);
                this.lastPollAt = this.clock.now();
                await this.maybeWarnWindowExpiry().catch(() => { });
                if (typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
                    this.pollTimeoutMs = Math.min(Math.max(response.longpolling_timeout_ms, 5_000), 120_000);
                }
                if (response.errcode === -14) {
                    this.handleSessionExpired();
                    continue;
                }
                if (typeof response.errcode === 'number' && response.errcode !== 0) {
                    throw new Error(`getupdates errcode=${response.errcode} ${response.errmsg ?? ''}`.trim());
                }
                const messages = Array.isArray(response.msgs) ? response.msgs : [];
                for (const message of messages) {
                    try {
                        await this.handleInbound(message);
                    }
                    catch (error) {
                        this.noteError(error);
                        this.logger.error('处理入站消息失败：%s', describeError(error));
                    }
                }
                if (typeof response.get_updates_buf === 'string') {
                    this.state.update((data) => {
                        data.syncBuf = response.get_updates_buf;
                    });
                }
                await this.state.flush();
                if (this.state.lastSaveFailure !== undefined) {
                    this.logger.warn('状态落盘失败（内存状态继续使用）：%s', describeError(this.state.lastSaveFailure));
                }
                backoff = 1_000;
            }
            catch (error) {
                if (signal.aborted || isAbortError(error))
                    break;
                this.noteError(error);
                this.status = 'reconnecting';
                this.logger.warn('长轮询失败，%sms 后重连：%s', backoff, describeError(error));
                await this.safeSleep(backoff, signal);
                backoff = Math.min(backoff * 2, 30_000);
            }
        }
    }
    handleSessionExpired() {
        this.logger.warn('iLink 会话已过期（errcode -14），停止轮询，等待重新扫码登录。');
        this.credentials = undefined;
        this.status = 'expired';
        this.lastError = 'iLink session expired (-14)';
        // The cursor and context tokens belong to the expired bot session. Drop
        // them so a re-scan starts a clean long-poll instead of replaying an
        // invalid cursor.
        this.state.update((data) => {
            data.syncBuf = '';
            data.contextTokens = {};
        });
        if (this.config.autoRelogin && !this.stopped) {
            void this.beginLogin().catch((error) => {
                this.noteError(error);
                this.logger.error('自动重新登录失败：%s', describeError(error));
            });
        }
    }
    async safeSleep(ms, signal) {
        try {
            await sleep(ms, signal);
        }
        catch (error) {
            if (!isAbortError(error))
                throw error;
        }
    }
    isAllowedUser(userId) {
        const configured = this.config.ownerUserId || this.state.get().ownerUserId;
        if (configured === '')
            return true;
        return configured === userId;
    }
    bindOwner(userId) {
        if (this.state.get().ownerUserId === '') {
            this.state.update((data) => {
                data.ownerUserId = userId;
            });
            this.logger.info('首次入站，已绑定微信用户 %s', userId);
        }
    }
    async handleInbound(message) {
        if (message.messageType !== 1)
            return;
        if (typeof message.groupId === 'string' && message.groupId !== '') {
            this.logger.debug('忽略群聊消息（协议仅支持单聊）');
            return;
        }
        const userId = message.from;
        if (typeof userId !== 'string' || userId === '')
            return;
        const seenKey = message.messageId !== undefined
            ? `mid:${userId}:${message.messageId}`
            : message.clientId !== undefined
                ? `cid:${userId}:${message.clientId}`
                : '';
        if (seenKey !== '' && !this.state.markSeen(seenKey))
            return;
        if (!this.isAllowedUser(userId)) {
            this.logger.warn('忽略未授权微信用户 %s 的消息', userId);
            return;
        }
        const wasFirstInbound = this.state.get().lastInboundAt <= 0;
        this.bindOwner(userId);
        this.state.update((data) => {
            data.lastInboundAt = this.clock.now();
        });
        if (typeof message.contextToken === 'string' && message.contextToken !== '') {
            this.redactor.add(message.contextToken);
            this.state.cacheContextToken(userId, message.contextToken);
        }
        else {
            this.logger.warn('入站消息没有 context_token，无法回复；仍尝试投递给 DSH 会话。');
        }
        if (wasFirstInbound) {
            this.logger.info('已收到微信首条消息，通道激活（已缓存 context_token）。');
        }
        await this.flushPendingNotices(userId);
        const text = extractInboundText(message);
        const hasMediaItems = (message.items ?? []).some((item) => item.type === 2 || item.type === 4 || item.type === 5 || (item.type === 3 && item.raw !== undefined));
        if (text === '' && !hasMediaItems) {
            if (wasFirstInbound && this.config.sendWelcomeOnActivate) {
                await this.ensureSessionForFirstMessage(userId, { welcomeOnly: true });
            }
            else {
                await this.sendReply(userId, '目前支持文本、语音转写，以及图片/视频/文件附件。').catch(() => { });
            }
            return;
        }
        if (this.config.logMessageContent)
            this.logger.info('收到消息（预览）：%s', truncate(text || '(媒体)', 120));
        else
            this.logger.info('收到消息：%s 字符%s', text.length, hasMediaItems ? '（含媒体）' : '');
        const command = text === '' ? null : parseCommand(text);
        if (command !== null && !hasMediaItems) {
            // Keep held media unless the command is clearly unrelated session control;
            // /help /status /list should not discard a pending caption wait.
            if (command.name === 'new' ||
                command.name === 'bind' ||
                command.name === 'switch' ||
                command.name === 'stop' ||
                command.name === 'clear' ||
                command.name === 'retry') {
                this.mediaHold.clear(userId);
            }
            if (wasFirstInbound && this.config.sendWelcomeOnActivate && command.name === 'help') {
                await this.handleCommand(userId, command.name, command.args);
                return;
            }
            if (wasFirstInbound &&
                this.config.sendWelcomeOnActivate &&
                this.state.get().activeSessionId === '' &&
                command.name !== 'new' &&
                command.name !== 'bind') {
                await this.ensureSessionForFirstMessage(userId, { welcomeOnly: true });
            }
            await this.handleCommand(userId, command.name, command.args);
            return;
        }
        // Caption / flush keyword for a previously held media-only message.
        if (!hasMediaItems && text !== '' && this.mediaHold.has(userId)) {
            const held = this.mediaHold.take(userId);
            const caption = isMediaFlushKeyword(text) ? '请分析用户通过微信发来的媒体。' : text;
            const deliveryText = [caption, held.mediaText].filter((part) => part.trim() !== '').join('\n\n');
            this.logger.info('已将配文与暂存媒体合并投递（%d 个文件）', held.attachments.length);
            await this.deliverText(userId, deliveryText, 'followup', held.sourceMessageId, {
                isFirstInbound: held.wasFirstInbound,
                attachments: held.attachments,
            });
            return;
        }
        let attachments = [];
        let mediaText = '';
        if (this.config.enableInboundMedia && hasMediaItems) {
            try {
                attachments = await this.ingestInboundMedia(message);
                mediaText = describeSavedMedia(attachments);
                this.logger.info('已保存 %d 个入站媒体文件', attachments.length);
            }
            catch (error) {
                this.noteError(error);
                const reason = describeError(error);
                this.logger.error('入站媒体处理失败：%s', reason);
                await this.sendReply(userId, `收到媒体，但保存失败：${reason}`).catch(() => { });
                if (text === '')
                    return;
            }
        }
        // Media-only: hold briefly so the user can send a caption as the next WeChat message.
        if (text === '' &&
            attachments.length > 0 &&
            this.config.inboundMediaHoldMs > 0) {
            const sourceMessageId = String(message.messageId ?? message.clientId ?? randomUUID());
            this.mediaHold.hold({
                userId,
                attachments,
                mediaText,
                wasFirstInbound,
                sourceMessageId,
            });
            if (this.config.askCaptionOnMediaOnly) {
                await this.sendReply(userId, formatMediaHoldPrompt(attachments.length, this.config.inboundMediaHoldMs)).catch(() => { });
            }
            this.logger.info('纯媒体入站已暂存，等待配文最多 %d ms（用户 %s）', this.config.inboundMediaHoldMs, userId);
            return;
        }
        const deliveryText = [text, mediaText].filter((part) => part.trim() !== '').join('\n\n');
        if (deliveryText.trim() === '' && attachments.length === 0) {
            await this.sendReply(userId, '收到消息，但没有可处理的文本或媒体。').catch(() => { });
            return;
        }
        await this.deliverText(userId, deliveryText || '（用户发送了媒体文件）', 'followup', String(message.messageId ?? message.clientId ?? randomUUID()), { isFirstInbound: wasFirstInbound, attachments });
    }
    async flushHeldMedia(batch, caption) {
        const deliveryText = [caption, batch.mediaText].filter((part) => part.trim() !== '').join('\n\n');
        this.logger.info('媒体配文等待超时，按默认说明投递（%d 个文件）', batch.attachments.length);
        try {
            await this.deliverText(batch.userId, deliveryText, 'followup', batch.sourceMessageId, {
                isFirstInbound: batch.wasFirstInbound,
                attachments: batch.attachments,
            });
        }
        catch (error) {
            this.noteError(error);
            this.logger.error('超时投递暂存媒体失败：%s', describeError(error));
        }
    }
    async ingestInboundMedia(message) {
        if (typeof this.transport.downloadInboundMedia !== 'function')
            return [];
        const downloaded = await this.transport.downloadInboundMedia(message);
        if (downloaded.length === 0)
            return [];
        // Ensure a session exists so we have a cwd to write into.
        let sessionId = this.state.get().activeSessionId;
        if (sessionId === '') {
            if (!this.config.autoCreateSessionOnFirstMessage) {
                throw new Error('尚未绑定 DSH 会话，无法保存入站媒体；请先 /new 或 /bind');
            }
            const cwd = this.config.newSessionCwd || undefined;
            sessionId = await this.createTrackedSession(cwd);
            this.setActiveSession(sessionId);
            this.logger.info('入站媒体前自动新建会话 %s', sessionId);
        }
        const cwd = (await this.bridge.sessionCwd(sessionId)) || this.config.newSessionCwd || process.cwd();
        const destDir = join(cwd, this.config.inboundMediaDir);
        const saved = await saveInboundMediaFiles(downloaded, destDir, { maxBytes: this.config.maxFileBytes });
        return attachSavedMediaToDsh(this.ctx, saved, this.logger);
    }
    /**
     * Ensure an active session exists for first-run UX. Returns whether a session
     * was auto-created, and whether a welcome was sent.
     */
    async ensureSessionForFirstMessage(userId, options) {
        let sessionId = this.state.get().activeSessionId;
        let autoCreated = false;
        if (sessionId === '' && this.config.autoCreateSessionOnFirstMessage) {
            const cwd = this.config.newSessionCwd || undefined;
            sessionId = await this.createTrackedSession(cwd);
            this.setActiveSession(sessionId);
            autoCreated = true;
            this.logger.info('首条消息未绑定会话，已自动新建 %s', sessionId);
        }
        let welcomed = false;
        if (this.config.sendWelcomeOnActivate && sessionId !== '') {
            await this.sendReply(userId, welcomeAfterActivate({
                sessionId,
                autoCreated,
                processingFirstText: options.processingFirstText === true && !options.welcomeOnly,
            }));
            welcomed = true;
        }
        else if (sessionId === '') {
            await this.sendReply(userId, unboundSessionHint(this.config.autoCreateSessionOnFirstMessage)).catch(() => { });
        }
        else if (options.welcomeOnly) {
            await this.sendReply(userId, '目前支持文本、语音转写与图片/文件。发送 /help 查看命令。').catch(() => { });
        }
        return { sessionId, autoCreated, welcomed };
    }
    async deliverText(userId, text, mode, sourceMessageId, options = {}) {
        let activeSessionId = this.state.get().activeSessionId;
        let skippedStartAck = false;
        if (activeSessionId === '') {
            if (mode !== 'followup') {
                await this.sendReply(userId, unboundSessionHint(this.config.autoCreateSessionOnFirstMessage));
                return;
            }
            if (!this.config.autoCreateSessionOnFirstMessage) {
                await this.sendReply(userId, unboundSessionHint(false));
                return;
            }
            const ensured = await this.ensureSessionForFirstMessage(userId, {
                welcomeOnly: false,
                processingFirstText: true,
            });
            activeSessionId = ensured.sessionId;
            skippedStartAck = ensured.welcomed;
            if (activeSessionId === '')
                return;
        }
        else if (options.isFirstInbound && this.config.sendWelcomeOnActivate && mode === 'followup') {
            await this.sendReply(userId, welcomeAfterActivate({
                sessionId: activeSessionId,
                autoCreated: false,
                processingFirstText: true,
            }));
            skippedStartAck = true;
        }
        try {
            await this.bridge.deliver(activeSessionId, text, mode, { userId, messageId: sourceMessageId }, options.attachments ?? []);
            this.lastRetryable.delete(userId);
            this.logger.info('已投递到会话 %s（%s，附件 %d）', activeSessionId, mode, options.attachments?.length ?? 0);
            if (mode === 'followup') {
                await this.maybeNameWechatSession(activeSessionId, text);
            }
            if (mode === 'followup' && this.config.sendProgressUpdates) {
                this.progress.start(activeSessionId, userId, this.config.progressIntervalMs);
            }
            if (this.config.sendStartAck && mode === 'followup' && !skippedStartAck) {
                try {
                    await this.sendReply(userId, '已收到，DSH 正在处理，请稍候…');
                }
                catch (ackError) {
                    this.noteError(ackError);
                    const reason = describeError(ackError);
                    this.logger.error('已投递到 DSH，但向微信发送“处理中”回执失败：%s', reason);
                    await this.notifyDsh(activeSessionId, `已收到微信消息并开始处理，但向微信发送“处理中”回执失败：${reason}`);
                }
            }
        }
        catch (error) {
            this.noteError(error);
            const reason = describeError(error);
            this.logger.error('投递到会话失败：%s', reason);
            this.lastRetryable.set(userId, {
                sessionId: activeSessionId,
                text,
                mode,
                sourceMessageId,
                attachments: [...(options.attachments ?? [])],
                isFirstInbound: options.isFirstInbound,
                createdAt: this.clock.now(),
            });
            const wechatError = [
                `未能把消息交给 DSH：${reason}`,
                '发送「重试」或 /retry 可再试一次；也可发 /status 看通道状态。',
            ].join('\n');
            try {
                await this.sendReply(userId, wechatError);
            }
            catch (replyError) {
                this.logger.error('投递失败，且无法向微信回错：%s', describeError(replyError));
                await this.notifyDsh(activeSessionId, `微信消息未能投递到本会话（${reason}），且向微信回错也失败：${describeError(replyError)}`);
                return;
            }
            await this.notifyDsh(activeSessionId, `微信消息未能投递到本会话：${reason}`);
        }
    }
    async retryLastFailure(userId) {
        const pending = this.lastRetryable.get(userId);
        if (pending === undefined)
            return false;
        this.lastRetryable.delete(userId);
        await this.sendReply(userId, '正在重试上一次投递…').catch(() => { });
        await this.deliverText(userId, pending.text, pending.mode, pending.sourceMessageId, {
            isFirstInbound: pending.isFirstInbound,
            attachments: pending.attachments,
        });
        return true;
    }
    async maybeWarnWindowExpiry() {
        if (this.config.windowWarnHours <= 0)
            return;
        const owner = this.config.ownerUserId || this.state.get().ownerUserId;
        if (owner === '' || !this.canProactivelySend(owner))
            return;
        const setup = this.currentSetup();
        const remaining = setup.windowRemainingMs;
        if (remaining === undefined || remaining <= 0)
            return;
        const warnMs = this.config.windowWarnHours * 3_600_000;
        if (remaining > warnMs)
            return;
        const lastInbound = this.state.get().lastInboundAt;
        if (lastInbound <= 0 || this.windowWarnedForInboundAt === lastInbound)
            return;
        this.windowWarnedForInboundAt = lastInbound;
        await this.sendReply(owner, [
            `提醒：主动推送窗口还剩约 ${formatDuration(remaining)}。`,
            '请回一句任意消息（例如「在」），以免到期后任务结果推不过来。',
        ].join('\n'));
    }
    describePollHealth() {
        if (this.lastPollAt <= 0) {
            return { label: '尚未开始轮询', healthy: false, staleMs: 0 };
        }
        const staleMs = Math.max(0, this.clock.now() - this.lastPollAt);
        const staleLimit = Math.max(this.pollTimeoutMs * 2 + 15_000, 90_000);
        if (this.status === 'connected' && staleMs <= staleLimit) {
            return { label: '轮询正常', healthy: true, staleMs };
        }
        if (this.status === 'reconnecting') {
            return { label: `重连中（距上次轮询 ${formatDuration(staleMs)}）`, healthy: false, staleMs };
        }
        if (this.status === 'waiting-login' || this.status === 'expired') {
            return { label: '等待登录', healthy: false, staleMs };
        }
        return { label: `轮询可能异常（距上次 ${formatDuration(staleMs)}）`, healthy: false, staleMs };
    }
    async notifyDsh(sessionId, text) {
        if (sessionId === '' || text.trim() === '')
            return;
        try {
            await this.bridge.notifySession(sessionId, text);
        }
        catch (error) {
            this.logger.warn('向 DSH 写入通道通知失败：%s', describeError(error));
        }
    }
    async handleCommand(userId, name, args) {
        await runWechatCommand({
            config: this.config,
            state: this.state,
            bridge: this.bridge,
            sendReply: (uid, text) => this.sendReply(uid, text),
            setActiveSession: (sessionId, clearList) => this.setActiveSession(sessionId, clearList),
            noteUntitledSession: (sessionId) => this.pendingWechatTitles.add(sessionId),
            formatStatus: () => this.formatStatus(),
            deliverText: (uid, text, mode, sourceMessageId) => this.deliverText(uid, text, mode, sourceMessageId),
            retryLastFailure: (uid) => this.retryLastFailure(uid),
            noteError: (error) => this.noteError(error),
            describeError,
            logError: (format, ...params) => this.logger.error(format, ...params),
        }, userId, name, args);
    }
    async createTrackedSession(cwd) {
        const sessionId = await this.bridge.createSession(cwd);
        this.pendingWechatTitles.add(sessionId);
        return sessionId;
    }
    /** Name a WeChat-created session from its first delivered followup text. */
    async maybeNameWechatSession(sessionId, text) {
        if (sessionId === '' || !this.pendingWechatTitles.has(sessionId))
            return;
        if (typeof this.bridge.setSessionTitle !== 'function') {
            this.pendingWechatTitles.delete(sessionId);
            return;
        }
        const title = formatWechatSessionTitle(text);
        const ok = await this.bridge.setSessionTitle(sessionId, title).catch(() => false);
        this.pendingWechatTitles.delete(sessionId);
        if (ok)
            this.logger.info('微信会话已命名：%s', title);
    }
    setActiveSession(sessionId, clearList = true) {
        const previous = this.state.get().activeSessionId;
        this.state.update((data) => {
            data.activeSessionId = sessionId;
            if (clearList)
                data.listSnapshot = [];
        });
        if (previous !== sessionId)
            this.logger.info('activeSessionId：%s -> %s', previous || '(none)', sessionId);
    }
    async formatStatus() {
        const data = this.state.get();
        const active = data.activeSessionId;
        let sessionStatus = '未绑定';
        let title = '';
        if (active !== '') {
            try {
                const status = await this.bridge.sessionStatus(active);
                sessionStatus = status.exists ? status.status : '不存在';
                title = status.title;
            }
            catch {
                sessionStatus = '查询失败';
            }
        }
        const labels = {
            starting: '启动中',
            'waiting-login': '等待扫码登录',
            connected: '已连接',
            reconnecting: '重连中',
            expired: '登录已过期',
            stopped: '已停止',
            error: '错误',
        };
        const setup = this.currentSetup();
        const owner = this.config.ownerUserId || data.ownerUserId;
        const hasToken = owner !== '' && this.contextTokenFor(owner) !== undefined;
        const health = this.describePollHealth();
        const lines = [
            'DSH 微信通道状态',
            `就绪阶段：${setup.label}`,
            `下一步：${setup.nextAction}`,
            `健康：${health.label}`,
            `连接：${labels[this.status]}`,
            `Bot：${data.accountId || this.config.accountId || '未登录'}`,
            `绑定用户：${owner || '尚未绑定（将绑定首个发消息的人）'}`,
            `回复凭证：${hasToken ? '已缓存 context_token' : '无（需微信先发一条消息）'}`,
            `活跃会话：${active || '未绑定'}${title ? `（${truncate(title, 40)}）` : ''}`,
            `会话状态：${sessionStatus}`,
            `最近入站：${formatTimestamp(data.lastInboundAt)}`,
            ...(setup.windowRemainingMs === undefined
                ? []
                : [`主动推送窗口剩余：${formatDuration(setup.windowRemainingMs)}`]),
            `最近轮询：${formatTimestamp(this.lastPollAt)}${this.lastPollAt ? `（${formatDuration(this.clock.now() - this.lastPollAt)} 前）` : ''}`,
            `待补发摘要：${data.pendingNotices.length}`,
            `出站队列：${this.queue.size}`,
            `可重试失败：${owner !== '' && this.lastRetryable.has(owner) ? '有（发「重试」）' : '无'}`,
            `计数：入站 ${data.counters.inbound} / 出站 ${data.counters.outbound} / 错误 ${data.counters.errors}`,
        ];
        if (this.loginQr !== undefined && this.credentials === undefined)
            lines.push(`登录二维码：${this.loginQr.url}`);
        if (this.loginPage.running)
            lines.push(`扫码页：${this.loginPage.address}`);
        if (this.lastError !== '')
            lines.push(`最近错误：${truncate(this.lastError, 160)}`);
        return lines.join('\n');
    }
    currentSetup() {
        const data = this.state.get();
        const owner = this.config.ownerUserId || data.ownerUserId;
        return resolveSetupPhase({
            status: this.status,
            hasCredentials: this.credentials !== undefined,
            hasContextToken: owner !== '' && this.contextTokenFor(owner) !== undefined,
            hasOwner: owner !== '',
            hasActiveSession: data.activeSessionId !== '',
            lastInboundAt: data.lastInboundAt,
            windowHours: this.config.windowHours,
            now: this.clock.now(),
            ...(this.loginQr === undefined ? {} : { loginQrUrl: this.loginQr.url }),
        });
    }
    async onTurnComplete(result) {
        this.progress.stop(result.sessionId);
        if (!this.config.notifyOnTurnEnd)
            return;
        const owner = this.config.ownerUserId || this.state.get().ownerUserId;
        if (owner === '') {
            this.logger.warn('任务完成，但尚未绑定微信用户，跳过通知。');
            return;
        }
        const active = this.state.get().activeSessionId;
        const prefix = result.kind === 'completed' ? '✅' : '⚠️';
        let body = '';
        if (result.kind === 'completed')
            body = result.text || '任务已完成，但没有文本输出。';
        else if (result.kind === 'error')
            body = `任务执行失败：${result.error ?? '未知错误'}${result.text ? `\n\n${result.text}` : ''}`;
        else if (result.kind === 'aborted')
            body = '任务已停止。';
        else if (result.kind === 'blocked')
            body = '任务被阻止。';
        else if (result.kind === 'max-tokens')
            body = `任务因输出长度上限结束。${result.text ? `\n\n${result.text}` : ''}`;
        else
            body = `任务结束（${result.kind}）。`;
        if (result.sessionId !== active)
            body = `[会话 ${result.sessionId}]\n${body}`;
        let title = '';
        try {
            const status = await this.bridge.sessionStatus(result.sessionId);
            title = status.title;
        }
        catch {
            // ignore
        }
        if (title !== '' && result.sessionId !== active)
            body = `[${truncate(title, 30)}]\n${body}`;
        await this.sendProactive(owner, `${prefix} ${body}`, result.files, result.sessionId);
        if (result.files.length > 0)
            this.logger.info('任务完成，附带 %d 个文件', result.files.length);
    }
    canProactivelySend(userId) {
        const record = this.state.getContextToken(userId);
        if (record === undefined || record.token === '')
            return false;
        const last = this.state.get().lastInboundAt;
        if (last <= 0)
            return false;
        const maxAge = this.config.windowHours * 3_600_000;
        const now = this.clock.now();
        return now - last <= maxAge && now - record.updatedAt <= maxAge;
    }
    async sendProactive(userId, text, files, sessionId) {
        if (!this.canProactivelySend(userId)) {
            this.state.addPendingNotice({ sessionId, text, files: [...files] });
            this.logger.warn('距上次入站已超过 %d 小时（或没有 context_token），不尝试主动发送；已暂存摘要，等待用户下次发消息补发。', this.config.windowHours);
            await this.notifyDsh(sessionId, `超过 ${this.config.windowHours} 小时互动窗口（或缺少 context_token），任务结果未推送到微信，已暂存待补发。`);
            return;
        }
        let textSent = false;
        try {
            if (text.trim() !== '') {
                await this.sendReply(userId, text);
                textSent = true;
            }
            await this.sendFiles(userId, files, sessionId);
        }
        catch (error) {
            this.noteError(error);
            const reason = describeError(error);
            this.logger.error('主动推送失败，已暂存摘要：%s', reason);
            // Text that already reached the user is not queued again; only the
            // undelivered part is retained for the next inbound message.
            this.state.addPendingNotice({ sessionId, text: textSent ? '' : text, files: [...files] });
            await this.notifyDsh(sessionId, `任务结果推送到微信失败，已暂存待用户下次发消息补发：${reason}`);
        }
    }
    async flushPendingNotices(userId) {
        const notices = this.state.takePendingNotices(3);
        if (notices.length === 0)
            return;
        if (!this.canProactivelySend(userId))
            return;
        const sent = [];
        for (const notice of notices) {
            try {
                const header = `补发 ${formatTimestamp(notice.createdAt)} 的任务摘要：`;
                await this.sendReply(userId, `${header}\n${notice.text}`);
                await this.sendFiles(userId, notice.files, notice.sessionId);
                sent.push(notice.id);
            }
            catch (error) {
                this.noteError(error);
                this.logger.warn('补发摘要失败：%s', describeError(error));
            }
        }
        if (sent.length > 0) {
            this.state.removePendingNotices(sent);
            this.logger.info('已补发 %d 条暂存摘要', sent.length);
        }
    }
    contextTokenFor(userId) {
        const record = this.state.getContextToken(userId);
        if (record === undefined || record.token === '')
            return undefined;
        return record.token;
    }
    async sendReply(userId, text) {
        const token = this.contextTokenFor(userId);
        if (token === undefined) {
            this.logger.warn('没有可用的 context_token，无法回复；请让用户在微信中先发一条消息。');
            return;
        }
        const parts = splitText(text, this.config.textChunkChars);
        if (parts.length === 0)
            return;
        for (const part of parts) {
            await this.queue.enqueue({
                id: randomUUID(),
                user: userId,
                run: async () => {
                    await this.sendTextWithRetry(userId, part, token);
                    this.state.update((data) => {
                        data.counters.outbound += 1;
                    });
                },
            });
        }
    }
    async sendTextWithRetry(userId, text, token) {
        let lastError;
        for (let attempt = 1; attempt <= this.config.maxSendAttempts; attempt += 1) {
            try {
                await this.transport.sendText(userId, text, token);
                return;
            }
            catch (error) {
                lastError = error;
                if (isAbortError(error) || this.signal.aborted)
                    throw error;
                this.logger.warn('发送文本失败（第 %d/%d 次）：%s', attempt, this.config.maxSendAttempts, describeError(error));
                if (attempt < this.config.maxSendAttempts) {
                    await this.safeSleep(1_000 * 2 ** (attempt - 1), this.signal);
                }
            }
        }
        throw lastError;
    }
    async sendMediaWithRetry(userId, filePath, caption, token) {
        let lastError;
        for (let attempt = 1; attempt <= this.config.maxSendAttempts; attempt += 1) {
            try {
                await this.transport.sendMedia(userId, filePath, caption, token);
                return;
            }
            catch (error) {
                lastError = error;
                if (isAbortError(error) || this.signal.aborted)
                    throw error;
                this.logger.warn('发送媒体失败（第 %d/%d 次）：%s', attempt, this.config.maxSendAttempts, describeError(error));
                if (attempt < this.config.maxSendAttempts) {
                    await this.safeSleep(1_000 * 2 ** (attempt - 1), this.signal);
                }
            }
        }
        throw lastError;
    }
    async mediaRootsFor(sessionId) {
        const roots = [...this.config.mediaRoots];
        let baseDir = this.config.newSessionCwd || process.cwd();
        if (sessionId !== '') {
            try {
                const cwd = await this.bridge.sessionCwd(sessionId);
                if (cwd !== undefined) {
                    baseDir = cwd;
                    roots.push(cwd);
                }
            }
            catch {
                // ignore
            }
        }
        roots.push(baseDir);
        return { roots: [...new Set(roots)], baseDir };
    }
    async validateFiles(files, sessionId) {
        const { roots, baseDir } = await this.mediaRootsFor(sessionId);
        const validated = [];
        for (const file of files) {
            const entry = await validateMediaFile(file.path, {
                roots,
                baseDir,
                maxBytes: this.config.maxFileBytes,
            });
            validated.push({ ...entry, ...(file.description === undefined ? {} : { description: file.description }) });
        }
        return validated;
    }
    async sendFiles(userId, files, sessionId) {
        if (files.length === 0)
            return;
        const token = this.contextTokenFor(userId);
        if (token === undefined)
            return;
        let validated;
        try {
            validated = await this.validateFiles(files, sessionId);
        }
        catch (error) {
            if (error instanceof MediaValidationError) {
                this.logger.warn('跳过无法发送的文件：%s', error.message);
                return;
            }
            throw error;
        }
        for (const file of validated) {
            // Captions are separate iLink text messages. Queue them explicitly so the
            // per-minute limiter counts every actual sendmessage request.
            if (file.description !== undefined && file.description.trim() !== '') {
                for (const part of splitText(file.description, this.config.textChunkChars)) {
                    await this.queue.enqueue({
                        id: randomUUID(),
                        user: userId,
                        run: async () => {
                            await this.sendTextWithRetry(userId, part, token);
                            this.state.update((data) => {
                                data.counters.outbound += 1;
                            });
                        },
                    });
                }
            }
            await this.queue.enqueue({
                id: randomUUID(),
                user: userId,
                run: async () => {
                    await this.sendMediaWithRetry(userId, file.path, undefined, token);
                    this.state.update((data) => {
                        data.counters.outbound += 1;
                    });
                },
            });
        }
    }
    /** Used by the `wechat_send` tool. */
    async sendFromTool(input) {
        const callingSessionId = input.sessionId ?? this.state.get().activeSessionId;
        try {
            const owner = this.config.ownerUserId || this.state.get().ownerUserId;
            if (owner === '')
                throw new Error('尚未绑定微信用户，请先在微信中给 Bot 发送任意消息');
            const token = this.contextTokenFor(owner);
            if (token === undefined)
                throw new Error('没有可用的 context_token，请先在微信中给 Bot 发送任意消息');
            if (!this.canProactivelySend(owner)) {
                throw new Error(`距上次入站已超过 ${this.config.windowHours} 小时，不能主动发送；请先在微信中发一条消息`);
            }
            const text = typeof input.text === 'string' ? input.text : '';
            const files = Array.isArray(input.files) ? input.files : [];
            if (text.trim() === '' && files.length === 0)
                throw new Error('text 与 files 至少提供一个');
            // Validate every file before sending any text so a bad path cannot leave a
            // half-delivered tool call.
            let validated = [];
            if (files.length > 0) {
                validated = await this.validateFiles(files, callingSessionId);
            }
            const parts = text.trim() === '' ? [] : splitText(text, this.config.textChunkChars);
            for (const part of parts) {
                await this.queue.enqueue({
                    id: randomUUID(),
                    user: owner,
                    run: async () => {
                        await this.sendTextWithRetry(owner, part, token);
                        this.state.update((data) => {
                            data.counters.outbound += 1;
                        });
                    },
                });
            }
            if (validated.length > 0 && typeof input.caption === 'string' && input.caption.trim() !== '') {
                for (const part of splitText(input.caption, this.config.textChunkChars)) {
                    await this.queue.enqueue({
                        id: randomUUID(),
                        user: owner,
                        run: async () => {
                            await this.sendTextWithRetry(owner, part, token);
                            this.state.update((data) => {
                                data.counters.outbound += 1;
                            });
                        },
                    });
                }
            }
            for (const file of validated) {
                await this.queue.enqueue({
                    id: randomUUID(),
                    user: owner,
                    run: async () => {
                        await this.sendMediaWithRetry(owner, file.path, undefined, token);
                        this.state.update((data) => {
                            data.counters.outbound += 1;
                        });
                    },
                });
            }
            await this.state.flush();
            return { user: owner, textParts: parts.length, files: validated.length };
        }
        catch (error) {
            const reason = describeError(error);
            await this.notifyDsh(callingSessionId, `wechat_send 失败：${reason}`);
            throw error;
        }
    }
    async getStatusSnapshot() {
        const data = this.state.get();
        let activeSessionStatus = '未绑定';
        let activeSessionTitle = '';
        if (data.activeSessionId !== '') {
            try {
                const status = await this.bridge.sessionStatus(data.activeSessionId);
                activeSessionStatus = status.exists ? status.status : '不存在';
                activeSessionTitle = status.title;
            }
            catch {
                activeSessionStatus = '查询失败';
            }
        }
        const setup = this.currentSetup();
        const owner = this.config.ownerUserId || data.ownerUserId;
        return {
            status: this.status,
            connected: this.status === 'connected' && this.credentials !== undefined,
            setupPhase: setup.phase,
            setupLabel: setup.label,
            nextAction: setup.nextAction,
            hasContextToken: owner !== '' && this.contextTokenFor(owner) !== undefined,
            ...(setup.windowRemainingMs === undefined ? {} : { windowRemainingMs: setup.windowRemainingMs }),
            accountId: data.accountId || this.config.accountId,
            ownerUserId: owner,
            activeSessionId: data.activeSessionId,
            activeSessionStatus,
            activeSessionTitle,
            lastInboundAt: data.lastInboundAt,
            lastPollAt: this.lastPollAt,
            pendingNotices: data.pendingNotices.length,
            queueSize: this.queue.size,
            counters: { ...data.counters },
            ...(this.loginQr === undefined ? {} : { loginQrUrl: this.loginQr.url }),
            ...(this.loginPage.running ? { loginPageUrl: this.loginPage.address } : {}),
            ...(this.lastError === '' ? {} : { lastError: this.lastError }),
        };
    }
    loginPageSnapshot() {
        const setup = this.currentSetup();
        const data = this.state.get();
        const health = this.describePollHealth();
        return {
            status: this.status,
            connected: this.credentials !== undefined && this.status === 'connected',
            setupLabel: setup.label,
            nextAction: setup.nextAction,
            health: health.label,
            pollHealthy: health.healthy,
            lastInboundAt: data.lastInboundAt,
            lastPollAt: this.lastPollAt,
            pendingNotices: data.pendingNotices.length,
            queueSize: this.queue.size,
            ...(setup.windowRemainingMs === undefined ? {} : { windowRemainingMs: setup.windowRemainingMs }),
            ...(this.loginQr === undefined ? {} : { qrUrl: this.loginQr.url }),
            accountId: data.accountId || this.config.accountId || undefined,
            ...(this.lastError === '' ? {} : { lastError: this.lastError }),
        };
    }
    /**
     * Start (or re-use) the QR login flow and return the QR URL immediately.
     * The scan status is polled in the background; a successful confirmation is
     * written back into DSH credentials.
     */
    async beginLogin() {
        if (this.credentials !== undefined) {
            return {
                connected: true,
                status: this.status,
                message: alreadyLoggedInMessage(this.currentSetup()),
            };
        }
        if (this.loginStarting !== undefined)
            return this.loginStarting;
        if (this.loginQr !== undefined && this.loginPoller !== undefined) {
            return {
                connected: false,
                status: this.status,
                qrUrl: this.loginQr.url,
                message: loginInProgressMessage(this.loginQr.url),
            };
        }
        this.loginStarting = (async () => {
            try {
                const qr = await this.transport.requestQrCode(this.config.botType);
                this.loginQr = { ...qr, createdAt: Date.now() };
                this.status = 'waiting-login';
                await this.publishLoginQr(qr.url);
                this.loginPoller = this.pollLogin().finally(() => {
                    this.loginPoller = undefined;
                });
                const pageHint = this.loginPage.running ? `\n\n也可打开扫码页：${this.loginPage.address}` : '';
                return {
                    connected: false,
                    status: this.status,
                    qrUrl: qr.url,
                    message: `${loginGuidanceMessage(qr.url)}${pageHint}`,
                };
            }
            catch (error) {
                this.noteError(error);
                this.status = 'error';
                this.logger.error('获取登录二维码失败：%s', describeError(error));
                throw error;
            }
            finally {
                this.loginStarting = undefined;
            }
        })();
        return this.loginStarting;
    }
    async publishLoginQr(url) {
        this.logger.info('请用微信扫描二维码完成登录：%s', url);
        this.logger.info('登录成功后，请在微信里给 Bot 发任意一条消息以激活回复能力。');
        try {
            await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
            const file = join(this.config.stateDir, 'login-qr.txt');
            await writeFile(file, `${new Date().toISOString()}\n${url}\n`, { encoding: 'utf8', mode: 0o600 });
            await chmod(file, 0o600).catch(() => { });
            this.logger.info('二维码 URL 已写入 %s', file);
        }
        catch {
            // QR file logging is best effort.
        }
        if (this.config.printQrInTerminal) {
            const printed = await printQrToTerminal(url, (line) => this.logger.info('%s', line));
            if (!printed) {
                this.logger.debug('未安装 qrcode-terminal，仅打印二维码 URL。');
            }
        }
        if (this.config.enableLoginPage) {
            try {
                const pageUrl = this.loginPage.running
                    ? this.loginPage.address
                    : await this.loginPage.start(this.config.loginPagePort);
                this.logger.info('Web 扫码页：%s （用浏览器打开后扫码）', pageUrl);
            }
            catch (error) {
                this.logger.warn('启动 Web 扫码页失败：%s', describeError(error));
            }
        }
    }
    async pollLogin() {
        const signal = this.signal;
        const startedAt = Date.now();
        let qr = this.loginQr;
        let refreshes = 0;
        while (!signal.aborted && qr !== undefined) {
            if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
                this.logger.warn('扫码登录超时，请重新发起登录。');
                this.status = 'error';
                this.lastError = 'QR login timed out';
                this.loginQr = undefined;
                return;
            }
            try {
                const status = await this.transport.pollQrStatus(qr.qrcode);
                if (status.status === 'confirmed') {
                    if (typeof status.botToken !== 'string' || status.botToken === '') {
                        this.status = 'error';
                        this.lastError = 'login confirmed without bot_token';
                        this.logger.error('扫码已确认，但服务端未返回 bot_token。');
                        this.loginQr = undefined;
                        return;
                    }
                    await this.completeLogin(status);
                    return;
                }
                if (status.status === 'expired') {
                    refreshes += 1;
                    if (refreshes > MAX_QR_REFRESHES) {
                        this.status = 'error';
                        this.lastError = 'QR code expired too many times';
                        this.logger.warn('二维码多次过期，请重新调用 wechat_login 或重启插件。');
                        this.loginQr = undefined;
                        return;
                    }
                    const next = await this.transport.requestQrCode(this.config.botType);
                    qr = { ...next, createdAt: Date.now() };
                    this.loginQr = qr;
                    this.logger.info('二维码已过期，正在刷新…');
                    await this.publishLoginQr(next.url);
                    continue;
                }
                await this.safeSleep(1_000, signal);
            }
            catch (error) {
                if (signal.aborted || isAbortError(error))
                    return;
                this.noteError(error);
                this.logger.warn('轮询扫码状态失败，稍后重试：%s', describeError(error));
                await this.safeSleep(2_000, signal);
            }
        }
    }
    async completeLogin(status) {
        const token = status.botToken;
        const accountId = status.accountId ?? this.config.accountId;
        const baseUrl = status.baseUrl || this.config.baseUrl;
        this.credentials = { token, accountId, baseUrl };
        this.redactor.add(token);
        this.transport.setCredentials(this.credentials);
        this.state.update((data) => {
            data.accountId = accountId;
            data.baseUrl = baseUrl;
            // A fresh login invalidates the previous session's cursor/tokens.
            data.syncBuf = '';
            data.contextTokens = {};
        });
        const credentials = this.ctx.get('credentials');
        if (credentials !== undefined && typeof credentials.set === 'function') {
            try {
                await credentials.set(this.config.botTokenRef, token);
                this.logger.info('Bot Token 已写入 DSH 凭据（ref=%s）', this.config.botTokenRef);
            }
            catch (error) {
                this.logger.warn('写入 DSH 凭据失败（Token 仍仅在内存中使用）：%s', describeError(error));
            }
        }
        this.status = 'connected';
        this.lastError = '';
        this.loginQr = undefined;
        await this.state.flush();
        this.logger.info('微信扫码登录成功（account=%s），开始长轮询。', accountId ?? 'unknown');
        this.logger.info('%s', postLoginNextStepsLog());
        if (this.loginPage.running) {
            this.logger.info('扫码页仍可打开 %s 查看状态；插件停止时会自动关闭。', this.loginPage.address);
        }
    }
    noteError(error) {
        this.lastError = describeError(error);
        if (this.state && this.started) {
            try {
                this.state.update((data) => {
                    data.counters.errors += 1;
                });
            }
            catch {
                // ignore
            }
        }
    }
}
//# sourceMappingURL=wechat-channel.js.map