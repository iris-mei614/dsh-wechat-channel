import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sniffImageMediaType,
  saveInboundMediaFiles,
  describeSavedMedia,
} from '../dist/ilink/inbound-media.js';
import { createWechatUserMessage } from '../dist/agent/bridge.js';
import { makeChannel, inbound, cleanupDir, FakeBridge } from './helpers.mjs';

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

test('sniffImageMediaType detects png and jpeg', () => {
  assert.equal(sniffImageMediaType(pngBytes()), 'image/png');
  assert.equal(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
});

test('saveInboundMediaFiles writes workspace files', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'inbound-media-'));
  try {
    const saved = await saveInboundMediaFiles(
      [{ kind: 'image', data: pngBytes(), fileName: 'shot.png' }],
      dir,
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fileName, 'shot.png');
    assert.equal(saved[0].mediaType, 'image/png');
    const bytes = await readFile(saved[0].path);
    assert.equal(bytes[0], 0x89);
    assert.match(describeSavedMedia(saved), /shot\.png/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createWechatUserMessage includes durable image attachment blocks', () => {
  const message = createWechatUserMessage('看这张图', 'wx', 'm1', [
    {
      path: '/tmp/a.png',
      kind: 'image',
      fileName: 'a.png',
      bytes: 10,
      mediaType: 'image/png',
      attachment: {
        type: 'image',
        ref: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
      },
    },
  ]);
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[1].type, 'image');
  assert.equal(message.content[1].attachment.attachmentId, 'sha256:abc');
});

test('inbound image is saved and delivered to DSH with path summary', async () => {
  const bridge = new FakeBridge();
  bridge.sessions.set('s1', { id: 's1', title: '主会话', cwd: undefined, status: 'idle', live: true });
  const { channel, transport, dir, config } = await makeChannel({
    bridge,
    config: {
      defaultSessionId: 's1',
      enableInboundMedia: true,
      inboundMediaDir: 'wechat-inbox',
      sendStartAck: false,
      sendWelcomeOnActivate: false,
    },
  });
  // Point the session cwd at the temp dir so files land somewhere we can assert.
  bridge.sessions.get('s1').cwd = join(dir, 'workspace');
  transport.inboundMedia = [{ kind: 'image', data: pngBytes(), fileName: 'photo.png' }];

  try {
    await channel.start();
    await channel.handleInbound(
      inbound({
        text: '这是什么',
        messageId: 9001,
        items: [
          { type: 1, textItem: { text: '这是什么' } },
          { type: 2, raw: { type: 2, image_item: { media: { encrypt_query_param: 'x' } } } },
        ],
      }),
    );
    assert.equal(bridge.delivered.length, 1);
    assert.match(bridge.delivered[0].text, /这是什么/);
    assert.match(bridge.delivered[0].text, /photo\.png/);
    assert.equal(bridge.delivered[0].attachments.length, 1);
    assert.equal(bridge.delivered[0].attachments[0].kind, 'image');
    const savedPath = bridge.delivered[0].attachments[0].path;
    assert.ok(savedPath.includes('wechat-inbox'));
    const bytes = await readFile(savedPath);
    assert.equal(bytes[0], 0x89);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('media-only inbound still creates a DSH turn', async () => {
  const bridge = new FakeBridge();
  const { channel, transport, dir } = await makeChannel({
    bridge,
    ownerUserId: '',
    config: {
      defaultSessionId: '',
      autoCreateSessionOnFirstMessage: true,
      enableInboundMedia: true,
      sendWelcomeOnActivate: false,
      sendStartAck: false,
    },
  });
  transport.inboundMedia = [{ kind: 'file', data: Uint8Array.from([1, 2, 3, 4]), fileName: 'notes.txt' }];
  try {
    await channel.start();
    await channel.handleInbound(
      inbound({
        text: '',
        messageId: 9002,
        items: [{ type: 4, raw: { type: 4, file_item: { file_name: 'notes.txt', media: {} } } }],
      }),
    );
    assert.equal(bridge.creates.length, 1);
    assert.equal(bridge.delivered.length, 1);
    assert.match(bridge.delivered[0].text, /notes\.txt/);
    assert.equal(bridge.delivered[0].attachments[0].kind, 'file');
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('repeated filenames never overwrite earlier inbound files', async () => {
  const { mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'inbound-collision-'));
  try {
    const first = await saveInboundMediaFiles([{ kind: 'file', fileName: 'a.txt', data: Uint8Array.of(1) }], dir);
    const second = await saveInboundMediaFiles([{ kind: 'file', fileName: 'a.txt', data: Uint8Array.of(2) }], dir);
    assert.notEqual(first[0].path, second[0].path);
    assert.deepEqual([...await readFile(first[0].path)], [1]);
    await writeFile(join(dir, 'target'), 'safe');
    await symlink(join(dir, 'target'), join(dir, 'link.txt'));
    await saveInboundMediaFiles([{ kind: 'file', fileName: 'link.txt', data: Uint8Array.of(3) }], dir);
    assert.equal(await readFile(join(dir, 'target'), 'utf8'), 'safe');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doctor command produces a report without credentials or user identifiers', async () => {
  const { channel, dir, transport } = await makeChannel();
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '/doctor' }));
    const report = await channel.diagnose();
    assert.match(report, /状态存储：正常/);
    assert.doesNotMatch(report, /bot-token-value|context-token-value|wx-user/);
  } finally { await channel.stop(); await cleanupDir(dir); }
});

test('uncompleted inbox survives restart and is processed before polling', async () => {
  const fixture = await makeChannel({ config: { defaultSessionId: 's1' } });
  try {
    await fixture.state.load();
    fixture.state.update(data => { data.inboundQueue.push(inbound({ text: 'recover me', messageId: 98765 })); });
    await fixture.state.flush();
    await fixture.channel.start();
    const { waitFor } = await import('./helpers.mjs');
    assert.equal(await waitFor(() => fixture.bridge.delivered.length > 0), true);
    assert.match(fixture.bridge.delivered[0].text, /recover me/);
  } finally { await fixture.channel.stop(); await cleanupDir(fixture.dir); }
});

test('download rejects oversized streams before saving', async () => {
  const { downloadInboundMediaItems } = await import('../dist/ilink/inbound-media.js');
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64)); },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(downloadInboundMediaItems([
      { type: 2, image_item: { media: { encrypt_query_param: 'test' } } },
    ], 'https://example.com', 8), /附件下载失败/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});
