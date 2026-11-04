import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { makeChannel, inbound, cleanupDir, FakeBridge, waitFor } from './helpers.mjs';
import { StateStore } from '../dist/state.js';
import { drainInbox } from '../dist/channel/inbox-runtime.js';
import { deliverNotice } from '../dist/channel/notice-delivery.js';

// Simulate process restart by creating an entirely new channel and store.
test('failed delivery survives restart and retry uses its original session', async () => {
  const first = await makeChannel({ config: { defaultSessionId: 's1' } });
  first.bridge.deliver = async () => { throw new Error('offline'); };
  let second;
  try {
    await first.channel.start();
    await first.channel.handleInbound(inbound({ text: 'keep this', messageId: 101 }));
    assert.equal(Object.keys(first.state.get().retryDeliveries).length, 1);
    await first.channel.stop();
    second = await makeChannel({ dir: first.dir, config: { defaultSessionId: 's2' } });
    await second.channel.start();
    second.state.update(data => { data.activeSessionId = 's2'; });
    await second.channel.handleInbound(inbound({ text: '/retry', messageId: 102 }));
    assert.equal(second.bridge.delivered[0].sessionId, 's1');
    assert.equal(second.bridge.delivered[0].text, 'keep this');
    assert.equal(Object.keys(second.state.get().retryDeliveries).length, 0);
  } finally { await second?.channel.stop(); await first.channel.stop(); await cleanupDir(first.dir); }
});

test('poison message is isolated after three failures; later messages proceed', async () => {
  const f = await makeChannel();
  try {
    await f.state.load();
    f.state.update(data => { data.inboundQueue = [inbound({ messageId: 1 }), inbound({ messageId: 2 })]; });
    const delivered = [];
    const handle = async message => { if (message.messageId === 1) throw new Error('bad'); delivered.push(message.messageId); };
    const drain = () => drainInbox(f.state, handle, Date.now, new AbortController().signal, () => {});
    await assert.rejects(drain());
    await assert.rejects(drain());
    await drain();
    assert.deepEqual(delivered, [2]);
    const restored = new StateStore(f.config.stateDir);
    await restored.load();
    assert.equal(restored.get().failedInbound[0].attempts, 3);
    assert.equal(restored.get().inboundQueue.length, 0);
  } finally { await cleanupDir(f.dir); }
});

test('notification resumes only unsent text chunks and files after restart', async () => {
  const f = await makeChannel();
  try {
    await f.state.load();
    const notice = f.state.addPendingNotice({ sessionId: 's1', text: 'hello', files: [{ path: 'a' }, { path: 'b' }] });
    const sent = [];
    await assert.rejects(deliverNotice(f.state, notice, 100,
      async text => sent.push(text), async file => { if (file.path === 'b') throw new Error('offline'); sent.push(file.path); }));
    const restored = new StateStore(f.config.stateDir);
    await restored.load();
    await deliverNotice(restored, restored.get().pendingNotices[0], 100, async text => sent.push(text), async file => sent.push(file.path));
    assert.deepEqual(sent, ['hello', 'a', 'b']);
    assert.equal(restored.get().pendingNotices.length, 0);
  } finally { await cleanupDir(f.dir); }
});

test('held media survives restart and can be merged with a caption', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1', inboundMediaHoldMs: 60000 } });
  let restored;
  try {
    await f.channel.start();
    f.transport.inboundMedia = [{ kind: 'file', data: Uint8Array.of(1), fileName: 'note.txt' }];
    f.bridge.sessions.set('s1', { id: 's1', cwd: f.dir, title: 'test', status: 'idle', live: true });
    await f.channel.handleInbound(inbound({ text: '', messageId: 10, items: [{ type: 4, raw: {} }] }));
    assert.equal(f.state.get().heldMedia.length, 1);
    await f.channel.stop();
    restored = await makeChannel({ dir: f.dir, config: { inboundMediaHoldMs: 60000 } });
    await restored.channel.start();
    await restored.channel.handleInbound(inbound({ text: 'summarize', messageId: 11 }));
    assert.match(restored.bridge.delivered[0].text, /summarize/);
    assert.equal(restored.bridge.delivered[0].attachments.length, 1);
    assert.equal(restored.state.get().heldMedia.length, 0);
  } finally { await restored?.channel.stop(); await f.channel.stop(); await cleanupDir(f.dir); }
});

test('diagnostics export is private and contains no secrets or filesystem paths', async () => {
  const f = await makeChannel();
  try {
    await f.channel.start();
    const path = await f.channel.exportDiagnostics();
    const report = await readFile(path, 'utf8');
    assert.doesNotMatch(report, /bot-token-value|context-token-value|wx-user/);
    assert.ok(!report.includes(f.dir));
    assert.match(report, /Node.js/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});

test('text chunks checkpoint individually when a later chunk fails', async () => {
  const f = await makeChannel();
  try {
    await f.state.load();
    const notice = f.state.addPendingNotice({ sessionId: 's1', text: 'a'.repeat(250), files: [] });
    let calls = 0;
    await assert.rejects(deliverNotice(f.state, notice, 100, async () => { if (++calls === 2) throw new Error('network'); }, async () => {}));
    const restored = new StateStore(f.config.stateDir);
    await restored.load();
    assert.ok(restored.get().pendingNotices[0].text.length < 250);
    assert.ok(restored.get().pendingNotices[0].text.length > 0);
  } finally { await cleanupDir(f.dir); }
});

test('failed delivery history is not erased by a later successful message', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1' } });
  try {
    await f.channel.start();
    const deliver = f.bridge.deliver.bind(f.bridge);
    f.bridge.deliver = async () => { throw new Error('offline'); };
    await f.channel.handleInbound(inbound({ text: 'first', messageId: 1 }));
    f.bridge.deliver = deliver;
    await f.channel.handleInbound(inbound({ text: 'second', messageId: 2 }));
    assert.equal(Object.keys(f.state.get().retryDeliveries).length, 1);
    await f.channel.handleInbound(inbound({ text: '/retry', messageId: 3 }));
    assert.equal(f.bridge.delivered.at(-1).text, 'first');
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});

test('staged encrypted download decrypts correctly and cleans up after save', async () => {
  const { createCipheriv } = await import('node:crypto');
  const { downloadInboundMediaItems, saveInboundMediaFiles } = await import('../dist/ilink/inbound-media.js');
  const { rm } = await import('node:fs/promises');
  const f = await makeChannel();
  const original = globalThis.fetch;
  const key = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(Buffer.from('hello')), cipher.final()]);
  globalThis.fetch = async () => new Response(encrypted);
  let items = [];
  try {
    items = await downloadInboundMediaItems([{ type: 4, file_item: { file_name: 'a.txt', media: { encrypt_query_param: 'test', aes_key: key.toString('base64') } } }], 'https://example.com', 10, true);
    assert.equal(items[0].data, undefined);
    const saved = await saveInboundMediaFiles(items, f.dir);
    assert.equal(await readFile(saved[0].path, 'utf8'), 'hello');
    assert.equal((await stat(saved[0].path)).mode & 0o777, 0o600);
  } finally {
    globalThis.fetch = original;
    for (const item of items) await rm(item.cleanupDir, { recursive: true, force: true });
    await cleanupDir(f.dir);
  }
});

test('plain text items do not count toward the media item limit', async () => {
  const { downloadInboundMediaItems } = await import('../dist/ilink/inbound-media.js');
  assert.deepEqual(await downloadInboundMediaItems(Array.from({ length: 30 }, () => ({ type: 1, text_item: { text: 'text' } })), 'https://example.com'), []);
});

test('mixed attachment failure identifies the item and success count', async () => {
  const { downloadInboundMediaItems } = await import('../dist/ilink/inbound-media.js');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response(Uint8Array.of(1)) : new Response(null, { status: 503 });
  try {
    await assert.rejects(downloadInboundMediaItems([1, 2].map(n => ({ type: 2, image_item: { media: { encrypt_query_param: String(n) } } })), 'https://example.com', 100, true), /成功 1 个，失败 1 个（第 2 个：网络错误（HTTP 503））/);
  } finally { globalThis.fetch = original; }
});

test('first-message diagnosis does not create a session or start a task', async () => {
  const f = await makeChannel({ config: { autoCreateSessionOnFirstMessage: true, sendWelcomeOnActivate: true } });
  try {
    await f.channel.start();
    await f.channel.handleInbound(inbound({ text: '/doctor' }));
    assert.equal(f.state.get().activeSessionId, '');
    assert.equal(f.bridge.delivered.length, 0);
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});
