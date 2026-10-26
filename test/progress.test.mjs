import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressTracker, formatProgressMessage } from '../dist/progress.js';
import { makeChannel, inbound, waitFor, cleanupDir, FakeBridge } from './helpers.mjs';

test('formatProgressMessage uses compact duration', () => {
  assert.match(formatProgressMessage(90_000), /1m30s/);
  assert.match(formatProgressMessage(90_000, '正在读文件 a.ts'), /当前：正在读文件 a\.ts/);
});

test('ProgressTracker emits ticks until stopped', async () => {
  const ticks = [];
  const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const tracker = new ProgressTracker(clock, (tick) => {
    ticks.push(tick.message);
  });
  tracker.start('s1', 'wx-user', 40);
  assert.equal(await waitFor(() => ticks.length >= 2, 3000), true);
  tracker.stop('s1');
  const after = ticks.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ticks.length, after);
  assert.ok(ticks.every((line) => line.includes('仍在处理')));
});

test('long-running WeChat turn sends progress updates then stops on completion', async () => {
  const bridge = new FakeBridge();
  bridge.sessions.set('s1', { id: 's1', title: '主会话', cwd: '/tmp', status: 'idle', live: true });
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: {
      defaultSessionId: 's1',
      sendProgressUpdates: true,
      progressIntervalMs: 1000,
      sendStartAck: false,
    },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '长任务', messageId: 501 }));
    assert.equal(bridge.delivered.length, 1);
    assert.equal(await waitFor(() => transport.sentText.some((e) => e.text.includes('仍在处理')), 3000), true);
    bridge.emitTurn({ sessionId: 's1', turn: 1, kind: 'completed', text: '完成了', files: [], fromWechat: true });
    assert.equal(await waitFor(() => transport.sentText.some((e) => e.text.includes('✅')), 3000), true);
    const progressCount = transport.sentText.filter((e) => e.text.includes('仍在处理')).length;
    await new Promise((r) => setTimeout(r, 120));
    const progressCountAfter = transport.sentText.filter((e) => e.text.includes('仍在处理')).length;
    assert.equal(progressCountAfter, progressCount);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});
