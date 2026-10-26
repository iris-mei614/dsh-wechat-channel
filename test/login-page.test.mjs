import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginPageServer, renderLoginHtml } from '../dist/login-page.js';
import { makeChannel, waitFor, cleanupDir, FakeBridge } from './helpers.mjs';

test('renderLoginHtml embeds the QR url', () => {
  const html = renderLoginHtml({
    status: 'waiting-login',
    connected: false,
    setupLabel: '待扫码登录',
    nextAction: '扫码',
    qrUrl: 'https://example.test/qr.png',
  });
  assert.match(html, /example\.test\/qr\.png/);
  assert.match(html, /微信 iLink 扫码登录/);
  assert.match(html, /id="health"/);
});

test('LoginPageServer serves status JSON and HTML', async () => {
  let snapshot = {
    status: 'waiting-login',
    connected: false,
    setupLabel: '待扫码登录',
    nextAction: '扫码',
    qrUrl: 'https://example.test/qr.png',
  };
  const server = new LoginPageServer(() => snapshot);
  const url = await server.start(0);
  try {
    const status = await fetch(`${url}api/status`).then((r) => r.json());
    assert.equal(status.qrUrl, 'https://example.test/qr.png');
    const html = await fetch(url).then((r) => r.text());
    assert.match(html, /扫码登录/);
    snapshot = { ...snapshot, connected: true, setupLabel: '已就绪', nextAction: '发消息' };
    const after = await fetch(`${url}api/status`).then((r) => r.json());
    assert.equal(after.connected, true);
  } finally {
    await server.stop();
  }
});

test('beginLogin starts the web login page when enabled', async () => {
  const bridge = new FakeBridge();
  bridge.sessions.set('s1', { id: 's1', title: '主会话', cwd: '/tmp', status: 'idle', live: true });
  const { channel, dir } = await makeChannel({
    bridge,
    noToken: true,
    config: {
      defaultSessionId: 's1',
      autoLogin: false,
      enableLoginPage: true,
      loginPagePort: 0,
      printQrInTerminal: false,
    },
  });
  try {
    await channel.start();
    const login = await channel.beginLogin();
    assert.equal(login.connected, false);
    const status = await channel.getStatusSnapshot();
    assert.ok(status.loginPageUrl);
    assert.match(status.loginPageUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(login.message, /扫码页/);
    const page = await fetch(status.loginPageUrl).then((r) => r.text());
    assert.match(page, /微信/);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});
