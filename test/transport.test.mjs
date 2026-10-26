import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WechatIlinkTransport, extractInboundText } from '../dist/ilink/transport.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, body, json: body ? JSON.parse(body) : undefined };
      requests.push(record);
      await handler(record, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('transport sends text with the inbound context_token and bearer token', async () => {
  const { server, requests, baseUrl } = await startServer((_record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0 }));
  });
  try {
    const transport = new WechatIlinkTransport({ baseUrl, cdnBaseUrl: baseUrl });
    transport.setCredentials({ token: 'secret-token', accountId: 'bot@im.bot', baseUrl });
    await transport.sendText('wx-user', '你好', 'context-token');
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/ilink\/bot\/sendmessage$/);
    assert.equal(requests[0].headers.authorization, 'Bearer secret-token');
    assert.equal(requests[0].headers.authorizationtype, 'ilink_bot_token');
    assert.equal(requests[0].json.msg.context_token, 'context-token');
    assert.equal(requests[0].json.msg.to_user_id, 'wx-user');
    assert.equal(requests[0].json.msg.item_list[0].text_item.text, '你好');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('transport maps getupdates messages and preserves the cursor', async () => {
  const { server, requests, baseUrl } = await startServer((_record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ret: 0,
      get_updates_buf: 'cursor-next',
      longpolling_timeout_ms: 30000,
      msgs: [{
        message_id: 42,
        from_user_id: 'wx-user',
        message_type: 1,
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: '来自微信' } }],
      }],
    }));
  });
  try {
    const transport = new WechatIlinkTransport({ baseUrl, cdnBaseUrl: baseUrl });
    transport.setCredentials({ token: 't', baseUrl });
    const response = await transport.getUpdates('cursor-old', 35000);
    assert.equal(requests[0].json.get_updates_buf, 'cursor-old');
    assert.equal(response.get_updates_buf, 'cursor-next');
    assert.equal(response.msgs[0].from, 'wx-user');
    assert.equal(extractInboundText(response.msgs[0]), '来自微信');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('transport can be aborted out of a hanging long poll', async () => {
  const { server, baseUrl } = await startServer((_record, _res) => {
    // Intentionally never respond.
  });
  try {
    const transport = new WechatIlinkTransport({ baseUrl, cdnBaseUrl: baseUrl });
    transport.setCredentials({ token: 't', baseUrl });
    const controller = new AbortController();
    const pending = transport.getUpdates('', 35000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /aborted/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
