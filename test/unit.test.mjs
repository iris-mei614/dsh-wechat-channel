import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { splitText, truncate } from '../dist/text.js';
import { parseCommand, formatSessionList, resolveSwitchArgument } from '../dist/commands.js';
import { formatWechatSessionTitle, summarizeForSessionTitle } from '../dist/session-title.js';
import { resolveConfig } from '../dist/config.js';
import { StateStore, emptyState, normalizeState } from '../dist/state.js';
import { RateLimiter } from '../dist/rate-limit.js';
import { validateMediaFile, classifyMedia, isPathWithin } from '../dist/media.js';
import { inspectWav } from '../dist/ilink/audio.js';
import { tempDir, cleanupDir } from './helpers.mjs';

test('splitText respects chunk size and keeps content', () => {
  const source = `${'第一段。'.repeat(400)}\n第二段`;
  const parts = splitText(source, 100);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 100, `part length ${part.length}`);
  assert.equal(parts.join('\n').replace(/\s+/g, ''), source.replace(/\s+/g, ''));
});

test('splitText does not split surrogate pairs', () => {
  const source = '😀'.repeat(50);
  const parts = splitText(source, 21);
  for (const part of parts) {
    assert.equal([...part].every((char) => char === '😀'), true);
  }
});

test('formatWechatSessionTitle uses first-message summary', () => {
  assert.equal(summarizeForSessionTitle('帮我看看这段报错'), '帮我看看这段报错');
  assert.equal(
    formatWechatSessionTitle('帮我看看这段报错\n\n用户通过微信发送了图片：a.png'),
    '[微信会话] 帮我看看这段报错',
  );
  assert.match(formatWechatSessionTitle(''), /\[微信会话\] 新会话/);
});

test('parseCommand handles English, Chinese and unknown commands', () => {
  assert.deepEqual(parseCommand('/bind session-1'), { name: 'bind', args: 'session-1' });
  assert.deepEqual(parseCommand('/switch 2'), { name: 'switch', args: '2' });
  assert.deepEqual(parseCommand('/steer 继续'), { name: 'steer', args: '继续' });
  assert.deepEqual(parseCommand('/状态'), { name: 'status', args: '' });
  assert.deepEqual(parseCommand('/clear'), { name: 'clear', args: '' });
  assert.deepEqual(parseCommand('/model deepseek/v3'), { name: 'model', args: 'deepseek/v3' });
  assert.deepEqual(parseCommand('/retry'), { name: 'retry', args: '' });
  assert.deepEqual(parseCommand('重试'), { name: 'retry', args: '' });
  assert.deepEqual(parseCommand('/wat'), { name: 'unknown', args: '' });
  assert.equal(parseCommand('你好 /bind x'), null);
  assert.equal(parseCommand('普通文本'), null);
});

test('formatSessionList marks the active session and switch resolves indices', () => {
  const sessions = [
    { id: 'session-a', title: '开发', cwd: '', status: 'idle', live: true },
    { id: 'session-b', title: '', cwd: '', status: 'offline', live: false },
  ];
  const text = formatSessionList(sessions, 'session-a');
  assert.match(text, /1\. 开发/);
  assert.match(text, /正在用这个/);
  assert.equal(resolveSwitchArgument('2', sessions).id, 'session-b');
  assert.equal(resolveSwitchArgument('3', sessions).error !== undefined, true);
  assert.equal(resolveSwitchArgument('session-a', sessions).id, 'session-a');
});

test('resolveConfig applies safe defaults and validates numeric values', () => {
  const config = resolveConfig({
    rateLimitPerMinute: 0,
    windowHours: 99,
    maxFileBytes: 999999999,
    textChunkChars: 10,
  });
  assert.equal(config.rateLimitPerMinute, 10);
  assert.equal(config.windowHours, 24);
  assert.equal(config.maxFileBytes, 100 * 1024 * 1024);
  assert.equal(config.textChunkChars, 1800);
  assert.equal(config.autoLogin, true);
  assert.equal(config.notifyOnTurnEnd, true);
  assert.equal(config.sendStartAck, true);
  assert.equal(config.botTokenRef, 'WECHAT_ILINK_BOT_TOKEN');
  assert.equal(config.autoCreateSessionOnFirstMessage, true);
  assert.equal(config.sendWelcomeOnActivate, true);
  assert.equal(config.printQrInTerminal, true);
  assert.equal(config.sendProgressUpdates, true);
  assert.equal(config.progressIntervalMs, 180_000);
  assert.equal(config.enableLoginPage, true);
  assert.equal(config.loginPagePort, 19_876);
});

test('Config schema validates and fills defaults', async () => {
  const { Config } = await import('../dist/config.js');
  const value = Config(undefined);
  assert.equal(value.sendStartAck, true);
  assert.equal(value.sendProgressUpdates, true);
  assert.equal(value.botTokenRef, 'WECHAT_ILINK_BOT_TOKEN');
});

test('resolveSetupPhase walks the first-run journey', async () => {
  const { resolveSetupPhase } = await import('../dist/onboarding.js');
  assert.equal(
    resolveSetupPhase({
      status: 'waiting-login',
      hasCredentials: false,
      hasContextToken: false,
      hasOwner: false,
      hasActiveSession: false,
      lastInboundAt: 0,
      windowHours: 20,
      now: 1_000,
      loginQrUrl: 'https://example.test/qr',
    }).phase,
    'need-login',
  );
  assert.equal(
    resolveSetupPhase({
      status: 'connected',
      hasCredentials: true,
      hasContextToken: false,
      hasOwner: false,
      hasActiveSession: true,
      lastInboundAt: 0,
      windowHours: 20,
      now: 1_000,
    }).phase,
    'need-first-message',
  );
  assert.equal(
    resolveSetupPhase({
      status: 'connected',
      hasCredentials: true,
      hasContextToken: true,
      hasOwner: true,
      hasActiveSession: false,
      lastInboundAt: 500,
      windowHours: 20,
      now: 1_000,
    }).phase,
    'need-session',
  );
  const ready = resolveSetupPhase({
    status: 'connected',
    hasCredentials: true,
    hasContextToken: true,
    hasOwner: true,
    hasActiveSession: true,
    lastInboundAt: 1_000,
    windowHours: 20,
    now: 1_000 + 3_600_000,
  });
  assert.equal(ready.phase, 'ready');
  assert.ok(ready.windowRemainingMs !== undefined && ready.windowRemainingMs > 0);
});

test('state normalizes corrupt data and persists atomically with mode 0600', async () => {
  const dir = await tempDir();
  try {
    const state = new StateStore(join(dir, 'state'));
    await state.load();
    state.update((data) => {
      data.activeSessionId = 'session-x';
      data.syncBuf = 'cursor-1';
    });
    state.cacheContextToken('u1', 'ctx-token');
    state.addPendingNotice({ sessionId: 'session-x', text: '稍后补发', files: [] });
    await state.flush();
    const file = join(dir, 'state', 'state.json');
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);

    const reloaded = new StateStore(join(dir, 'state'));
    const data = await reloaded.load();
    assert.equal(data.activeSessionId, 'session-x');
    assert.equal(data.syncBuf, 'cursor-1');
    assert.equal(data.contextTokens.u1.token, 'ctx-token');
    assert.equal(data.pendingNotices.length, 1);

    const normalized = normalizeState({ contextTokens: { u: { token: 't', updatedAt: 1 } }, seenMessages: ['a'] });
    assert.equal(normalized.contextTokens.u.token, 't');
    assert.equal(normalized.seenMessages[0], 'a');
    assert.deepEqual(emptyState().counters, { inbound: 0, outbound: 0, errors: 0 });
    await reloaded.close();
    await state.close();
  } finally {
    await cleanupDir(dir);
  }
});

test('rate limiter allows the limit then waits for the window', async () => {
  let now = 0;
  const sleeps = [];
  const resolvers = [];
  const clock = {
    now: () => now,
    sleep(ms) {
      sleeps.push(ms);
      return new Promise((resolve) => {
        resolvers.push(() => {
          now += ms;
          resolve();
        });
      });
    },
  };
  const limiter = new RateLimiter(2, 60_000, clock);
  await limiter.acquire();
  await limiter.acquire();
  let acquired = false;
  const pending = limiter.acquire().then(() => { acquired = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(acquired, false);
  assert.equal(sleeps[0], 60_000);
  resolvers.shift()();
  await pending;
  assert.equal(acquired, true);
  assert.equal(limiter.size, 1);
});

test('media validation enforces roots, existence and size', async () => {
  const dir = await tempDir();
  try {
    const root = join(dir, 'root');
    await mkdir(root);
    const image = join(root, 'a.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const valid = await validateMediaFile(image, { roots: [root], baseDir: root, maxBytes: 1024 });
    assert.equal(valid.kind, 'image');
    assert.equal(classifyMedia('x.mp4'), 'video');
    assert.equal(classifyMedia('x.mp3'), 'audio');
    assert.equal(classifyMedia('x.pdf'), 'file');
    assert.equal(isPathWithin(root, image), true);
    await assert.rejects(
      validateMediaFile(join(root, 'missing.png'), { roots: [root], baseDir: root, maxBytes: 1024 }),
      /文件不存在/,
    );
    await assert.rejects(
      validateMediaFile(image, { roots: [join(dir, 'other')], baseDir: root, maxBytes: 1024 }),
      /工作区外/,
    );
    await assert.rejects(
      validateMediaFile(image, { roots: [root], baseDir: root, maxBytes: 2 }),
      /文件过大/,
    );
  } finally {
    await cleanupDir(dir);
  }
});

test('inspectWav parses duration and sample rate', () => {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + 16000, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(16000, 40);
  const wav = inspectWav(buffer);
  assert.ok(wav);
  assert.equal(wav.sampleRate, 8000);
  assert.equal(wav.durationMs, 1000);
  assert.equal(truncate('a'.repeat(20), 10).length, 10);
});
