import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../dist/state.js';
import { WechatChannel } from '../dist/channel.js';
import { resolveConfig } from '../dist/config.js';
import { Redactor, createSafeLogger } from '../dist/log.js';

export async function tempDir(prefix = 'dsh-wechat-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(path) {
  if (path) await rm(path, { recursive: true, force: true });
}

export class FakeLogger {
  constructor() {
    this.lines = [];
  }
  push(level, args) {
    this.lines.push({ level, args });
  }
  info(...args) { this.push('info', args); }
  warn(...args) { this.push('warn', args); }
  error(...args) { this.push('error', args); }
  debug(...args) { this.push('debug', args); }
  text() {
    return this.lines.map((line) => line.args.join(' ')).join('\n');
  }
}

export class FakeTransport {
  constructor() {
    this.credentials = undefined;
    this.sentText = [];
    this.sentMedia = [];
    this.updates = [];
    this.failTextTimes = 0;
    this.failPollTimes = 0;
    this.qr = { qrcode: 'qr-1', url: 'https://example.test/qr-1' };
    this.qrStatus = { status: 'wait' };
    this.pollCalls = [];
    this.disposed = false;
    this.pendingPoll = false;
  }

  setCredentials(credentials) {
    this.credentials = credentials;
  }

  getCredentials() {
    return this.credentials;
  }

  async getUpdates(syncBuf, timeoutMs, signal) {
    this.pollCalls.push({ syncBuf, timeoutMs });
    if (this.failPollTimes > 0) {
      this.failPollTimes -= 1;
      throw new Error('network down');
    }
    if (this.updates.length > 0) return this.updates.shift();
    this.pendingPoll = true;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      // Keep the poll pending until aborted; tests drive inbound directly.
    });
  }

  async sendText(to, text, contextToken) {
    if (this.failTextTimes > 0) {
      this.failTextTimes -= 1;
      throw new Error('send failed');
    }
    this.sentText.push({ to, text, contextToken });
  }

  async sendMedia(to, filePath, caption, contextToken) {
    this.sentMedia.push({ to, filePath, caption, contextToken });
  }

  async requestQrCode() {
    return this.qr;
  }

  async pollQrStatus() {
    return this.qrStatus;
  }

  async downloadInboundMedia(message) {
    if (typeof this.downloadHandler === 'function') return this.downloadHandler(message);
    return this.inboundMedia ?? [];
  }

  async dispose() {
    this.disposed = true;
  }
}

export class FakeBridge {
  constructor() {
    this.sessions = new Map();
    this.delivered = [];
    this.notices = [];
    this.creates = [];
    this.cancelled = [];
    this.turnListener = undefined;
    this.failDeliver = null;
  }

  async deliver(sessionId, text, mode, source, attachments = []) {
    if (typeof this.failDeliver === 'function') {
      const error = this.failDeliver({ sessionId, text, mode, source, attachments });
      if (error) throw error;
    }
    this.delivered.push({ sessionId, text, mode, source, attachments: [...attachments] });
    return { messageId: `msg-${this.delivered.length}` };
  }

  async notifySession(sessionId, text) {
    this.notices.push({ sessionId, text });
    return true;
  }

  async createSession(cwd) {
    const id = `session-created-${this.creates.length + 1}`;
    this.creates.push({ id, cwd });
    this.sessions.set(id, { id, title: `created-${this.creates.length}`, cwd: cwd ?? '', status: 'idle', live: true });
    return id;
  }

  async listSessions() {
    return [...this.sessions.values()];
  }

  async sessionStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { id: sessionId, title: '', status: 'offline', exists: false };
    return { ...session };
  }

  async cancelSession(sessionId) {
    this.cancelled.push(sessionId);
    return this.sessions.get(sessionId)?.status === 'running';
  }

  async resolveSession(idOrPrefix) {
    if (this.sessions.has(idOrPrefix)) return idOrPrefix;
    const matches = [...this.sessions.keys()].filter((id) => id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  async sessionCwd(sessionId) {
    return this.sessions.get(sessionId)?.cwd;
  }

  onTurnComplete(listener) {
    this.turnListener = listener;
    return () => {
      if (this.turnListener === listener) this.turnListener = undefined;
    };
  }

  onTurnActivity(listener) {
    this.activityListener = listener;
    return () => {
      if (this.activityListener === listener) this.activityListener = undefined;
    };
  }

  emitTurn(result) {
    this.turnListener?.(result);
  }

  emitActivity(sessionId, activity) {
    this.activityListener?.({ sessionId, activity });
  }

  async clearSession(sessionId) {
    await this.cancelSession(sessionId);
    const cwd = this.sessions.get(sessionId)?.cwd;
    return this.createSession(cwd);
  }

  async setSessionTitle(sessionId, title) {
    this.titles = this.titles ?? new Map();
    this.titles.set(sessionId, title);
    const session = this.sessions.get(sessionId);
    if (session !== undefined) session.title = title;
    return true;
  }

  currentModelLabel() {
    return this.modelLabel ?? '';
  }

  async listModels() {
    return this.models ?? [];
  }

  async selectModel(spec) {
    this.modelLabel = spec;
    return { ok: true, message: `已切换默认模型：${spec}` };
  }

  async dispose() {
    this.disposed = true;
  }
}

export function fakeCtx({ credentials } = {}) {
  const logger = new FakeLogger();
  const handlers = new Map();
  const services = new Map();
  if (credentials !== undefined) services.set('credentials', credentials);
  const tools = {
    registered: [],
    register(tool) {
      this.registered.push(tool);
      return () => {};
    },
  };
  return {
    logger: () => logger,
    effect(execute) { return execute; },
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(listener);
      return () => {
        const list = handlers.get(event) ?? [];
        const index = list.indexOf(listener);
        if (index !== -1) list.splice(index, 1);
      };
    },
    get(name) { return services.get(name); },
    setService(name, value) { services.set(name, value); },
    emit(event, ...args) {
      for (const listener of [...(handlers.get(event) ?? [])]) listener(...args);
    },
    tools,
    loggerImpl: logger,
    handlers,
  };
}

export async function makeChannel(options = {}) {
  const dir = options.dir ?? (await tempDir());
  const config = resolveConfig({
    stateDir: join(dir, 'state'),
    autoLogin: false,
    autoRelogin: false,
    ownerUserId: options.ownerUserId ?? 'wx-user',
    sendStartAck: options.sendStartAck ?? false,
    // Keep first-run UX off in the shared fixture so existing channel tests stay
    // focused; opt in per-test via config overrides.
    sendWelcomeOnActivate: false,
    autoCreateSessionOnFirstMessage: false,
    printQrInTerminal: false,
    sendProgressUpdates: false,
    enableLoginPage: false,
    inboundMediaHoldMs: 0,
    askCaptionOnMediaOnly: false,
    notifyOnTurnEnd: true,
    ...options.config,
  });
  const state = new StateStore(config.stateDir);
  const transport = options.transport ?? new FakeTransport();
  const bridge = options.bridge ?? new FakeBridge();
  const loggerImpl = new FakeLogger();
  const redactor = new Redactor();
  const logger = createSafeLogger(loggerImpl, redactor);
  const credentials = {
    value: options.noToken ? undefined : (options.token ?? 'bot-token-value'),
    async resolve() {
      return this.value === undefined ? undefined : { value: this.value, source: 'test' };
    },
    async set(_ref, value) { this.value = value; },
  };
  const ctx = fakeCtx({ credentials });
  const channel = new WechatChannel({ ctx, config, state, transport, bridge, logger, redactor, ...(options.clock ? { clock: options.clock } : {}) });
  return { channel, state, transport, bridge, ctx, config, dir, loggerImpl, redactor };
}

export async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function inbound(overrides = {}) {
  const { text, ...rest } = overrides;
  return {
    from: 'wx-user',
    to: 'bot',
    messageType: 1,
    messageId: Math.floor(Math.random() * 1_000_000),
    contextToken: 'context-token-value',
    items: [{ type: 1, textItem: { text: typeof text === 'string' ? text : '你好' } }],
    ...rest,
  };
}
