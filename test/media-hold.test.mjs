import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { MediaHoldBuffer, formatMediaHoldPrompt, isMediaFlushKeyword } from '../dist/media-hold.js';
import { makeChannel, inbound, waitFor, cleanupDir, FakeBridge } from './helpers.mjs';

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

test('isMediaFlushKeyword recognizes short go signals', () => {
  assert.equal(isMediaFlushKeyword('开始'), true);
  assert.equal(isMediaFlushKeyword('分析'), true);
  assert.equal(isMediaFlushKeyword('请看看这是什么错'), false);
});

test('MediaHoldBuffer merges caption on take and fires timeout', async () => {
  const timedOut = [];
  const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const buffer = new MediaHoldBuffer({
    holdMs: 40,
    clock,
    onTimeout: (batch) => timedOut.push(batch),
  });
  buffer.hold({
    userId: 'u1',
    attachments: [{ path: '/a.png', kind: 'image', fileName: 'a.png', bytes: 1 }],
    mediaText: 'media-a',
    wasFirstInbound: false,
    sourceMessageId: '1',
  });
  assert.equal(buffer.has('u1'), true);
  assert.equal(await waitFor(() => timedOut.length === 1, 2000), true);
  assert.equal(timedOut[0].mediaText, 'media-a');
});

test('formatMediaHoldPrompt mentions the wait window', () => {
  assert.match(formatMediaHoldPrompt(1, 30_000), /30 秒后开始工作/);
  assert.match(formatMediaHoldPrompt(1, 30_000), /请补充文字说明/);
  assert.match(formatMediaHoldPrompt(2, 30_000), /2 个文件/);
});

test('media-only inbound waits for caption then merges into one DSH turn', async () => {
  const bridge = new FakeBridge();
  bridge.sessions.set('s1', { id: 's1', title: '主会话', cwd: undefined, status: 'idle', live: true });
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: {
      defaultSessionId: 's1',
      enableInboundMedia: true,
      inboundMediaHoldMs: 5_000,
      askCaptionOnMediaOnly: true,
      sendStartAck: false,
      sendWelcomeOnActivate: false,
    },
  });
  bridge.sessions.get('s1').cwd = join(dir, 'workspace');
  transport.inboundMedia = [{ kind: 'image', data: pngBytes(), fileName: 'shot.png' }];

  try {
    await channel.start();
    await channel.handleInbound(
      inbound({
        text: '',
        messageId: 9101,
        items: [{ type: 2, raw: { type: 2 } }],
      }),
    );
    assert.equal(bridge.delivered.length, 0);
    assert.ok(transport.sentText.some((entry) => entry.text.includes('暂未开始分析')));

    await channel.handleInbound(inbound({ text: '这是什么错误？', messageId: 9102 }));
    assert.equal(bridge.delivered.length, 1);
    assert.match(bridge.delivered[0].text, /这是什么错误/);
    assert.match(bridge.delivered[0].text, /shot\.png/);
    assert.equal(bridge.delivered[0].attachments.length, 1);
    await readFile(bridge.delivered[0].attachments[0].path);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('flush keyword starts analysis without treating it as the caption', async () => {
  const bridge = new FakeBridge();
  bridge.sessions.set('s1', { id: 's1', title: '主会话', cwd: undefined, status: 'idle', live: true });
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: {
      defaultSessionId: 's1',
      enableInboundMedia: true,
      inboundMediaHoldMs: 5_000,
      askCaptionOnMediaOnly: false,
      sendStartAck: false,
      sendWelcomeOnActivate: false,
    },
  });
  bridge.sessions.get('s1').cwd = join(dir, 'workspace');
  transport.inboundMedia = [{ kind: 'image', data: pngBytes(), fileName: 'x.png' }];
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '', messageId: 9201, items: [{ type: 2, raw: { type: 2 } }] }));
    assert.equal(bridge.delivered.length, 0);
    await channel.handleInbound(inbound({ text: '开始', messageId: 9202 }));
    assert.equal(bridge.delivered.length, 1);
    assert.match(bridge.delivered[0].text, /请分析用户通过微信发来的媒体/);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});
