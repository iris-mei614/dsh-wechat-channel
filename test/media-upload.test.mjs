import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiClient, UploadMediaType } from 'wechat-ilink-client';
import { uploadMedia, sendImageMessage, sendFileMessage, assertTrustedUploadUrl } from '../dist/ilink/media.js';
import { tempDir, cleanupDir } from './helpers.mjs';

async function withServer(handler, fn) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { url: req.url, method: req.method, body: Buffer.concat(chunks) };
    requests.push(record);
    await handler(record, res, requests);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ baseUrl, requests });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('media upload supports the new upload_full_url response', async () => {
  const dir = await tempDir();
  let serverBase = '';
  try {
    await withServer(async (record, res) => {
      if (record.url.startsWith('/ilink/bot/getuploadurl')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          upload_full_url: `${serverBase}/upload-full?encrypted_query_param=abc&filekey=def`,
        }));
        return;
      }
      if (record.url.startsWith('/upload-full')) {
        assert.equal(record.method, 'POST');
        assert.ok(record.body.length > 0);
        res.writeHead(200, { 'x-encrypted-param': 'download-param-new' });
        res.end();
        return;
      }
      if (record.url.startsWith('/ilink/bot/sendmessage')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ret: 0 }));
        return;
      }
      res.writeHead(404);
      res.end();
    }, async ({ baseUrl, requests }) => {
      serverBase = baseUrl;
      const file = join(dir, 'image.png');
      await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
      const api = new ApiClient({ baseUrl, cdnBaseUrl: baseUrl, token: 'token' });
      const uploaded = await uploadMedia(api, file, 'wx-user', UploadMediaType.IMAGE);
      assert.equal(uploaded.uploadMode, 'upload_full_url');
      assert.equal(uploaded.downloadEncryptedQueryParam, 'download-param-new');
      await sendImageMessage(api, 'wx-user', uploaded, 'context-token');

      const send = requests.find((entry) => entry.url.startsWith('/ilink/bot/sendmessage'));
      assert.ok(send);
      const payload = JSON.parse(send.body.toString('utf8'));
      assert.equal(payload.msg.context_token, 'context-token');
      assert.equal(payload.msg.item_list[0].type, 2);
      assert.equal(payload.msg.item_list[0].image_item.media.encrypt_query_param, 'download-param-new');
      assert.equal(payload.msg.item_list[0].image_item.media.encrypt_type, 1);
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('media upload still supports the legacy upload_param response', async () => {
  const dir = await tempDir();
  try {
    await withServer(async (record, res) => {
      if (record.url.startsWith('/ilink/bot/getuploadurl')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upload_param: 'legacy-param' }));
        return;
      }
      if (record.url.startsWith('/upload?')) {
        res.writeHead(200, { 'x-encrypted-param': 'download-param-legacy' });
        res.end();
        return;
      }
      if (record.url.startsWith('/ilink/bot/sendmessage')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ret: 0 }));
        return;
      }
      res.writeHead(404);
      res.end();
    }, async ({ baseUrl, requests }) => {
      const file = join(dir, 'report.pdf');
      await writeFile(file, Buffer.from('%PDF-1.4 test'));
      const api = new ApiClient({ baseUrl, cdnBaseUrl: baseUrl, token: 'token' });
      const uploaded = await uploadMedia(api, file, 'wx-user', UploadMediaType.FILE);
      assert.equal(uploaded.uploadMode, 'upload_param');
      await sendFileMessage(api, 'wx-user', file, uploaded, 'context-token');
      const send = requests.find((entry) => entry.url.startsWith('/ilink/bot/sendmessage'));
      const payload = JSON.parse(send.body.toString('utf8'));
      assert.equal(payload.msg.item_list[0].type, 4);
      assert.equal(payload.msg.item_list[0].file_item.file_name, 'report.pdf');
      assert.equal(payload.msg.item_list[0].file_item.media.encrypt_query_param, 'download-param-legacy');
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('upload_full_url rejects untrusted hosts', () => {
  assert.throws(
    () => assertTrustedUploadUrl('https://evil.example/upload', 'https://novac2c.cdn.weixin.qq.com/c2c'),
    /untrusted upload host/,
  );
  assert.doesNotThrow(() =>
    assertTrustedUploadUrl('https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1', 'https://novac2c.cdn.weixin.qq.com/c2c'),
  );
  assert.doesNotThrow(() =>
    assertTrustedUploadUrl('https://ilinkai.weixin.qq.com/upload?x=1', 'https://novac2c.cdn.weixin.qq.com/c2c'),
  );
});
