import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StateStore } from '../dist/state.js';
import { makeChannel, inbound, cleanupDir, waitFor } from './helpers.mjs';

function mediaBatch(userId, overrides = {}) {
  return { userId, sessionId: 's1', attachments: [], mediaText: 'old command',
    sourceMessageId: 'old', wasFirstInbound: false, createdAt: Date.now() - 1000, ...overrides };
}

test('state saves remain serialized even when time is frozen and flushes overlap updates', async () => {
  const f = await makeChannel();
  const originalNow = Date.now;
  try {
    await f.state.load();
    Date.now = () => 123456;
    let active = 0;
    let maxActive = 0;
    const write = f.state.write.bind(f.state);
    f.state.write = async () => {
      maxActive = Math.max(maxActive, ++active);
      try { await new Promise(resolve => setTimeout(resolve, 2)); await write(); }
      finally { active--; }
    };
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      f.state.update(data => { data.counters.inbound = index; });
      return f.state.flush();
    }));
    assert.equal(maxActive, 1);
    assert.equal(JSON.parse(await readFile(f.state.path, 'utf8')).counters.inbound, 19);
    assert.deepEqual((await readdir(f.config.stateDir)).filter(name => name.endsWith('.tmp')), []);
  } finally { Date.now = originalNow; await cleanupDir(f.dir); }
});

test('a failed state save is reported and a subsequent flush can recover', async () => {
  const f = await makeChannel();
  try {
    await f.state.load();
    await mkdir(f.state.path);
    await assert.rejects(f.state.flush());
    assert.ok(f.state.lastSaveFailure);
    await rm(f.state.path, { recursive: true });
    f.state.update(data => { data.activeSessionId = 'restored'; });
    await f.state.flush();
    assert.equal(f.state.lastSaveFailure, undefined);
    assert.equal(JSON.parse(await readFile(f.state.path, 'utf8')).activeSessionId, 'restored');
  } finally { await cleanupDir(f.dir); }
});

test('restart quarantines media from a previously authorized user', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1', inboundMediaHoldMs: 1 } });
  try {
    await f.state.load();
    f.state.update(data => { data.ownerUserId = 'old-owner'; data.heldMedia = [mediaBatch('old-owner')]; });
    await f.state.flush();
    await f.channel.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.bridge.delivered.length, 0);
    assert.equal(f.state.get().heldMedia.length, 0);
    assert.equal(f.state.get().quarantinedMedia.length, 1);
    const restored = new StateStore(f.config.stateDir);
    await restored.load();
    assert.equal(restored.get().quarantinedMedia[0].batch.userId, 'old-owner');
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});

test('media authorization is checked again when its timeout executes', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1', inboundMediaHoldMs: 50 } });
  try {
    await f.channel.start();
    f.channel.mediaHold.hold(mediaBatch('wx-user', { createdAt: Date.now() }));
    f.config.ownerUserId = 'new-owner';
    assert.equal(await waitFor(() => f.state.get().quarantinedMedia.length === 1), true);
    assert.equal(f.bridge.delivered.length, 0);
    assert.equal(f.state.get().heldMedia.length, 0);
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});

test('steer preserves held media through restart and caption delivery consumes only that batch', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1', inboundMediaHoldMs: 60000 } });
  let restored;
  try {
    f.bridge.sessions.set('s1', { id: 's1', title: 'test', cwd: f.dir, status: 'running', live: true });
    await f.channel.start();
    f.transport.inboundMedia = [{ kind: 'file', data: Uint8Array.of(1), fileName: 'a.txt' }];
    await f.channel.handleInbound(inbound({ text: '', messageId: 1, items: [{ type: 4, raw: {} }] }));
    await f.channel.handleInbound(inbound({ text: '/steer other instruction', messageId: 2 }));
    assert.equal(f.state.get().heldMedia.length, 1);
    await f.channel.stop();
    restored = await makeChannel({ dir: f.dir, config: { inboundMediaHoldMs: 60000 } });
    await restored.channel.start();
    await restored.channel.handleInbound(inbound({ text: 'analyze it', messageId: 3 }));
    assert.equal(restored.bridge.delivered[0].attachments.length, 1);
    assert.equal(restored.state.get().heldMedia.length, 0);
  } finally { await restored?.channel.stop(); await f.channel.stop(); await cleanupDir(f.dir); }
});

test('three permanently invalid notices do not block the fourth valid result', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1' } });
  try {
    f.bridge.sessions.set('s1', { id: 's1', title: 'test', cwd: f.dir, status: 'idle', live: true });
    await f.channel.start();
    await f.channel.handleInbound(inbound({ text: 'activate' }));
    for (let i = 0; i < 3; i++) f.state.addPendingNotice({ sessionId: 's1', text: '', files: [{ path: join(f.dir, `missing-${i}`) }] });
    f.state.addPendingNotice({ sessionId: 's1', text: 'later valid result', files: [] });
    await f.channel.handleInbound(inbound({ text: '/status' }));
    assert.equal(f.state.get().pendingNotices.filter(notice => notice.quarantined).length, 3);
    await f.channel.handleInbound(inbound({ text: '/status' }));
    assert.ok(f.transport.sentText.some(entry => entry.text.includes('later valid result')));
    assert.equal(f.state.get().pendingNotices.length, 3);
    await f.state.flush();
    const restored = new StateStore(f.config.stateDir);
    await restored.load();
    assert.ok(restored.get().pendingNotices.every(notice => notice.quarantined));
    assert.equal(restored.takePendingNotices(3).length, 0);
    await writeFile(join(f.dir, 'missing-0'), 'recovered');
    await f.channel.handleInbound(inbound({ text: '/retry' }));
    assert.equal(f.state.get().pendingNotices.length, 2);
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});

test('transient notice failures back off and quarantine after three attempts', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1', maxSendAttempts: 1 } });
  try {
    await f.channel.start();
    await f.channel.handleInbound(inbound({ text: 'activate' }));
    const notice = f.state.addPendingNotice({ sessionId: 's1', text: 'retry me', files: [] });
    f.transport.failTextTimes = 3;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await assert.rejects(f.channel.deliverPendingNotice('wx-user', notice));
      assert.equal(notice.attempts, attempt);
      assert.ok(notice.nextAttemptAt > Date.now());
      assert.ok(!f.state.takePendingNotices(3).includes(notice));
    }
    assert.equal(notice.quarantined, true);
    await f.channel.handleInbound(inbound({ text: '/retry' }));
    assert.ok(!f.state.get().pendingNotices.includes(notice));
    assert.equal(f.transport.sentText.filter(entry => entry.text === 'retry me').length, 1);
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});

test('consuming an old batch does not delete a newer batch for the same user', async () => {
  const f = await makeChannel({ config: { defaultSessionId: 's1', inboundMediaHoldMs: 60000 } });
  try {
    await f.channel.start();
    f.channel.mediaHold.hold(mediaBatch('wx-user', { createdAt: Date.now(), sourceMessageId: 'first' }));
    const old = f.channel.mediaHold.take('wx-user');
    f.channel.mediaHold.hold(mediaBatch('wx-user', { createdAt: Date.now(), sourceMessageId: 'second' }));
    const newer = f.state.get().heldMedia.find(batch => batch.sourceMessageId === 'second');
    assert.equal(f.state.get().heldMedia.length, 2);
    assert.notEqual(newer.batchId, old.batchId);
    await f.channel.deliverText('wx-user', 'old batch', 'followup', old.sourceMessageId, { heldBatchId: old.batchId, attachments: old.attachments });
    assert.equal(f.state.get().heldMedia.length, 1);
    assert.equal(f.state.get().heldMedia[0].batchId, newer.batchId);
  } finally { await f.channel.stop(); await cleanupDir(f.dir); }
});
