import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiClient } from 'wechat-ilink-client';
import { sendVoice, inspectWav } from '../dist/ilink/audio.js';
import { tempDir, cleanupDir } from './helpers.mjs';

function wavBuffer(seconds = 1) {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2 * seconds;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test('voice upload builds the expected iLink voice message', async () => {
  const dir = await tempDir();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ url: req.url, method: req.method, body });
    if (req.url.startsWith('/ilink/bot/getuploadurl')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ upload_param: 'upload-param' }));
      return;
    }
    if (req.url.startsWith('/upload')) {
      res.writeHead(200, { 'x-encrypted-param': 'download-param' });
      res.end();
      return;
    }
    if (req.url.startsWith('/ilink/bot/sendmessage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const file = join(dir, 'voice.wav');
    const wav = wavBuffer(1);
    await writeFile(file, wav);
    assert.equal(inspectWav(wav)?.durationMs, 1000);
    const api = new ApiClient({ baseUrl, cdnBaseUrl: baseUrl, token: 'token' });
    await sendVoice(api, 'wx-user', file, 'context-token');
    const send = requests.find((entry) => entry.url.startsWith('/ilink/bot/sendmessage'));
    assert.ok(send);
    const payload = JSON.parse(send.body.toString('utf8'));
    const voice = payload.msg.item_list[0].voice_item;
    assert.equal(payload.msg.context_token, 'context-token');
    assert.equal(payload.msg.to_user_id, 'wx-user');
    assert.equal(voice.encode_type, 1);
    assert.equal(voice.playtime, 1000);
    assert.equal(voice.sample_rate, 8000);
    assert.equal(voice.media.encrypt_query_param, 'download-param');
    assert.equal(Buffer.from(voice.media.aes_key, 'base64').length, 32);
    assert.equal(requests.some((entry) => entry.url.startsWith('/upload')), true);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await cleanupDir(dir);
  }
});
