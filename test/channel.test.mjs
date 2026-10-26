import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { makeChannel, inbound, waitFor, cleanupDir, FakeBridge } from './helpers.mjs';

function baseBridge() {
  const bridge = new FakeBridge();
  bridge.sessions.set('s1', { id: 's1', title: '主会话', cwd: '/tmp', status: 'idle', live: true });
  bridge.sessions.set('s2', { id: 's2', title: '第二会话', cwd: '/tmp', status: 'idle', live: true });
  return bridge;
}

test('ordinary WeChat text is delivered with followup and completion returns to WeChat', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1', sendStartAck: true },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '你好' }));
    assert.equal(bridge.delivered.length, 1);
    assert.equal(bridge.delivered[0].sessionId, 's1');
    assert.equal(bridge.delivered[0].text, '你好');
    assert.equal(bridge.delivered[0].mode, 'followup');
    assert.equal(bridge.delivered[0].source.userId, 'wx-user');
    assert.equal(transport.sentText[0].text, '已收到，DSH 正在处理，请稍候…');
    assert.equal(transport.sentText[0].contextToken, 'context-token-value');

    bridge.emitTurn({ sessionId: 's1', turn: 1, kind: 'completed', text: '你好，我是 DSH。', files: [], fromWechat: true });
    assert.equal(await waitFor(() => transport.sentText.some((entry) => entry.text.includes('你好，我是 DSH。'))), true);
    const completion = transport.sentText.find((entry) => entry.text.includes('✅'));
    assert.ok(completion);
    assert.equal(completion.to, 'wx-user');
    assert.equal(state.get().counters.inbound, 1);
    assert.ok(state.get().counters.outbound >= 2);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('session commands bind/new/list/switch/status/stop behave', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1' },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '/bind s2', messageId: 11 }));
    assert.equal(state.get().activeSessionId, 's2');
    assert.ok(transport.sentText.at(-1).text.includes('s2'));
    assert.ok(transport.sentText.at(-1).text.includes('已绑'));

    await channel.handleInbound(inbound({ text: '/new', messageId: 12 }));
    assert.match(state.get().activeSessionId, /^session-created-/);
    assert.equal(bridge.creates.length, 1);

    await channel.handleInbound(inbound({ text: '/list', messageId: 13 }));
    const listReply = transport.sentText.at(-1).text;
    assert.match(listReply, /1\./);
    assert.match(listReply, /主会话/);
    assert.equal(state.get().listSnapshot.length, 3);

    await channel.handleInbound(inbound({ text: '/switch 1', messageId: 14 }));
    assert.equal(state.get().activeSessionId, state.get().listSnapshot[0].id);
    assert.ok(transport.sentText.at(-1).text.includes('已切过去'));

    await channel.handleInbound(inbound({ text: '/status', messageId: 15 }));
    const statusReply = transport.sentText.at(-1).text;
    assert.match(statusReply, /健康/);
    assert.match(statusReply, /活跃会话/);

    bridge.sessions.get('s1').status = 'running';
    state.update((data) => { data.activeSessionId = 's1'; });
    await channel.handleInbound(inbound({ text: '/stop', messageId: 16 }));
    assert.deepEqual(bridge.cancelled, ['s1']);
    assert.ok(transport.sentText.at(-1).text.includes('停'));
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('steer requires a running session and uses the steer delivery mode', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1' },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '/steer 先暂停', messageId: 21 }));
    assert.ok(transport.sentText.at(-1).text.includes('没有正在跑的任务'));
    assert.equal(bridge.delivered.length, 0);

    bridge.sessions.get('s1').status = 'running';
    state.update((data) => { data.activeSessionId = 's1'; });
    await channel.handleInbound(inbound({ text: '/steer 先暂停', messageId: 22 }));
    assert.equal(bridge.delivered.length, 1);
    assert.equal(bridge.delivered[0].mode, 'steer');
    assert.equal(bridge.delivered[0].text, '先暂停');
    assert.ok(transport.sentText.at(-1).text.includes('补充进当前任务'));
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('messages older than the 20 hour window are queued and replayed on the next inbound', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1' },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '先激活', messageId: 31 }));
    const before = transport.sentText.length;
    state.update((data) => {
      data.lastInboundAt = Date.now() - 21 * 3_600_000;
    });
    bridge.emitTurn({ sessionId: 's1', turn: 2, kind: 'completed', text: '迟到任务结果', files: [], fromWechat: true });
    assert.equal(await waitFor(() => state.get().pendingNotices.length === 1), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(transport.sentText.length, before, 'must not attempt a proactive send outside the window');

    await channel.handleInbound(inbound({ text: '我回来了', messageId: 32 }));
    assert.equal(await waitFor(() => transport.sentText.some((entry) => entry.text.includes('补发'))), true);
    assert.equal(state.get().pendingNotices.length, 0);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('turn files are sent after the completion text', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1', mediaRoots: [] },
  });
  try {
    const image = join(dir, 'result.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    bridge.sessions.get('s1').cwd = dir;
    await channel.start();
    await channel.handleInbound(inbound({ text: '生成图片', messageId: 41 }));
    bridge.emitTurn({
      sessionId: 's1',
      turn: 3,
      kind: 'completed',
      text: '图片已生成。',
      files: [{ path: image, description: '结果图' }],
      fromWechat: true,
    });
    assert.equal(await waitFor(() => transport.sentMedia.length === 1), true);
    assert.equal(transport.sentMedia[0].filePath, await realpath(image));
    assert.equal(transport.sentMedia[0].caption, undefined);
    assert.ok(transport.sentText.some((entry) => entry.text === '结果图'));
    assert.equal(transport.sentMedia[0].contextToken, 'context-token-value');
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('duplicate inbound messages are ignored and unknown users cannot drive the bot', async () => {
  const bridge = baseBridge();
  const { channel, state, dir } = await makeChannel({ bridge, config: { defaultSessionId: 's1' } });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '一次', messageId: 51 }));
    await channel.handleInbound(inbound({ text: '一次', messageId: 51 }));
    assert.equal(bridge.delivered.length, 1);
    await channel.handleInbound(inbound({ from: 'stranger', text: '入侵', messageId: 52 }));
    assert.equal(bridge.delivered.length, 1);
    assert.equal(state.get().ownerUserId, 'wx-user');
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('failed sends are retried with backoff and succeed', async () => {
  const bridge = baseBridge();
  const { channel, transport, dir } = await makeChannel({ bridge, config: { defaultSessionId: 's1' } });
  try {
    await channel.start();
    transport.failTextTimes = 2;
    await channel.handleInbound(inbound({ text: '触发重试', messageId: 61 }));
    bridge.emitTurn({ sessionId: 's1', turn: 4, kind: 'completed', text: '重试成功', files: [], fromWechat: true });
    assert.equal(await waitFor(() => transport.sentText.some((entry) => entry.text.includes('重试成功')), 5000), true);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});


test('sendFromTool sends text and files, and refuses outside the window', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1' },
  });
  try {
    bridge.sessions.get('s1').cwd = dir;
    const image = join(dir, 'tool-result.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await channel.start();
    await assert.rejects(
      channel.sendFromTool({ text: '还没有 token' }),
      /context_token/,
    );
    await channel.handleInbound(inbound({ text: '激活', messageId: 71 }));
    const result = await channel.sendFromTool({ text: '主动发送', files: [{ path: image }], caption: '图' });
    assert.equal(result.files, 1);
    assert.ok(transport.sentText.some((entry) => entry.text === '主动发送'));
    assert.ok(transport.sentText.some((entry) => entry.text === '图'));
    assert.equal(transport.sentMedia.length, 1);
    assert.equal(transport.sentMedia[0].caption, undefined);

    state.update((data) => { data.lastInboundAt = Date.now() - 21 * 3_600_000; });
    await assert.rejects(channel.sendFromTool({ text: '超窗' }), /超过 20 小时/);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});


test('long-poll cursor survives a restart and reconnects after a transient failure', async () => {
  const bridge = baseBridge();
  const first = await makeChannel({ bridge, config: { defaultSessionId: 's1' } });
  first.transport.updates.push({
    msgs: [inbound({ text: '第一条', messageId: 81 })],
    get_updates_buf: 'cursor-persisted',
  });
  try {
    await first.channel.start();
    assert.equal(await waitFor(() => first.state.get().syncBuf === 'cursor-persisted', 3000), true);
    assert.equal(bridge.delivered.length, 1);
  } finally {
    await first.channel.stop();
  }
  try {
    const bridge2 = baseBridge();
    const second = await makeChannel({ bridge: bridge2, dir: first.dir, config: { defaultSessionId: 's1' } });
    second.transport.failPollTimes = 1;
    second.transport.updates.push({
      msgs: [inbound({ text: '重连后', messageId: 82 })],
      get_updates_buf: 'cursor-after-reconnect',
    });
    try {
      await second.channel.start();
      assert.equal(await waitFor(() => bridge2.delivered.length === 1, 4000), true);
      assert.equal(second.transport.pollCalls[0].syncBuf, 'cursor-persisted');
      assert.equal(await waitFor(() => second.state.get().syncBuf === 'cursor-after-reconnect', 3000), true);
    } finally {
      await second.channel.stop();
    }
  } finally {
    await cleanupDir(first.dir);
  }
});

test('logs never contain the bot token or the inbound context token', async () => {
  const bridge = baseBridge();
  const { channel, loggerImpl, dir, transport } = await makeChannel({ bridge, config: { defaultSessionId: 's1' } });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '秘密测试', messageId: 91 }));
    bridge.emitTurn({ sessionId: 's1', turn: 1, kind: 'error', error: 'boom', text: '', files: [], fromWechat: true });
    assert.equal(await waitFor(() => transport.sentText.some((entry) => entry.text.includes('boom'))), true);
    const logs = loggerImpl.text();
    assert.equal(logs.includes('bot-token-value'), false);
    assert.equal(logs.includes('context-token-value'), false);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});


test('errcode -14 marks the channel expired and clears the stale cursor/tokens', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({ bridge, config: { defaultSessionId: 's1' } });
  try {
    await state.load();
    state.update((data) => {
      data.syncBuf = 'stale-cursor';
      data.contextTokens.u = { token: 'ctx', updatedAt: Date.now() };
    });
    transport.updates.push({ errcode: -14, errmsg: 'session timeout' });
    await channel.start();
    assert.equal(await waitFor(() => state.get().syncBuf === '' && Object.keys(state.get().contextTokens).length === 0, 3000), true);
    const status = await channel.getStatusSnapshot();
    assert.equal(status.status, 'expired');
    assert.equal(status.connected, false);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('browser login flow stores the token and begins polling', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    noToken: true,
    config: { defaultSessionId: 's1', autoLogin: false },
  });
  try {
    await channel.start();
    const login = await channel.beginLogin();
    assert.equal(login.connected, false);
    assert.equal(login.qrUrl, 'https://example.test/qr-1');
    assert.match(login.message, /三步/);
    assert.match(login.message, /发任意一条消息/);
    let status = await channel.getStatusSnapshot();
    assert.equal(status.setupPhase, 'need-login');
    assert.match(status.nextAction, /扫描二维码|wechat_login/);
    transport.qrStatus = {
      status: 'confirmed',
      botToken: 'scanned-token',
      accountId: 'bot@im.bot',
      baseUrl: 'http://127.0.0.1:1',
      userId: 'wx-user',
    };
    assert.equal(await waitFor(() => transport.credentials?.token === 'scanned-token', 4000), true);
    assert.equal(state.get().accountId, 'bot@im.bot');
    status = await channel.getStatusSnapshot();
    assert.equal(status.setupPhase, 'need-first-message');
    assert.match(status.nextAction, /发任意一条消息/);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('first inbound without a bound session auto-creates one and welcomes the user', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    ownerUserId: '',
    config: {
      defaultSessionId: '',
      autoCreateSessionOnFirstMessage: true,
      sendWelcomeOnActivate: true,
    },
  });
  try {
    await channel.start();
    let status = await channel.getStatusSnapshot();
    assert.equal(status.setupPhase, 'need-first-message');

    await channel.handleInbound(inbound({ text: '你好', messageId: 201 }));
    assert.equal(bridge.creates.length, 1);
    assert.equal(state.get().activeSessionId, bridge.creates[0].id);
    assert.equal(bridge.delivered.length, 1);
    assert.equal(bridge.delivered[0].text, '你好');
    assert.equal(state.get().ownerUserId, 'wx-user');
    assert.ok(transport.sentText.some((entry) => entry.text.includes('通道已激活')));
    assert.ok(transport.sentText.some((entry) => entry.text.includes('自动新建')));

    status = await channel.getStatusSnapshot();
    assert.equal(status.setupPhase, 'ready');
    assert.equal(status.hasContextToken, true);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('first inbound with a pre-bound session still sends an activation welcome', async () => {
  const bridge = baseBridge();
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: {
      defaultSessionId: 's1',
      autoCreateSessionOnFirstMessage: true,
      sendWelcomeOnActivate: true,
      sendStartAck: true,
    },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '你好', messageId: 202 }));
    assert.equal(bridge.creates.length, 0);
    assert.equal(bridge.delivered.length, 1);
    assert.ok(transport.sentText.some((entry) => entry.text.includes('通道已激活')));
    assert.ok(transport.sentText.some((entry) => entry.text.includes('正在处理你的第一条消息')));
    // Welcome already said "processing"; do not also send the generic start ack.
    assert.equal(transport.sentText.some((entry) => entry.text.includes('DSH 正在处理')), false);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('auto-created session is named from the first WeChat message', async () => {
  const bridge = baseBridge();
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    ownerUserId: '',
    config: {
      defaultSessionId: '',
      autoCreateSessionOnFirstMessage: true,
      sendWelcomeOnActivate: false,
      sendStartAck: false,
    },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '帮我看看这段报错', messageId: 801 }));
    const sessionId = state.get().activeSessionId;
    assert.match(sessionId, /^session-created-/);
    assert.equal(bridge.titles.get(sessionId), '[微信会话] 帮我看看这段报错');
    assert.equal(bridge.sessions.get(sessionId).title, '[微信会话] 帮我看看这段报错');
    assert.equal(transport.sentText.length >= 0, true);
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('clear and model commands work from WeChat', async () => {
  const bridge = baseBridge();
  bridge.modelLabel = 'deepseek/chat';
  bridge.models = ['deepseek/chat', 'deepseek/reasoner'];
  const { channel, transport, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1' },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '/model', messageId: 701 }));
    assert.ok(transport.sentText.at(-1).text.includes('deepseek/chat'));
    await channel.handleInbound(inbound({ text: '/model deepseek/reasoner', messageId: 702 }));
    assert.equal(bridge.modelLabel, 'deepseek/reasoner');
    await channel.handleInbound(inbound({ text: '/clear', messageId: 703 }));
    assert.match(state.get().activeSessionId, /^session-created-/);
    assert.ok(transport.sentText.at(-1).text.includes('清空'));
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('failed deliver can be retried with 重试', async () => {
  const bridge = baseBridge();
  let fails = 1;
  bridge.failDeliver = () => {
    if (fails > 0) {
      fails -= 1;
      return new Error('temporary');
    }
    return null;
  };
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1', sendStartAck: false },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '重要请求', messageId: 711 }));
    assert.equal(bridge.delivered.length, 0);
    assert.ok(transport.sentText.some((entry) => entry.text.includes('重试')));
    await channel.handleInbound(inbound({ text: '重试', messageId: 712 }));
    assert.equal(bridge.delivered.length, 1);
    assert.equal(bridge.delivered[0].text, '重要请求');
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('deliver failure replies to WeChat and notifies the DSH session', async () => {
  const bridge = baseBridge();
  bridge.failDeliver = () => new Error('session offline');
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1', sendStartAck: true },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '你好', messageId: 301 }));
    assert.equal(bridge.delivered.length, 0);
    assert.ok(transport.sentText.some((entry) => entry.text.includes('未能把消息交给 DSH')));
    assert.ok(transport.sentText.some((entry) => entry.text.includes('重试')));
    assert.ok(bridge.notices.some((entry) => entry.sessionId === 's1' && entry.text.includes('未能投递')));
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('turn completion outside the window notifies DSH that WeChat push was deferred', async () => {
  const bridge = baseBridge();
  const { channel, state, dir } = await makeChannel({
    bridge,
    config: { defaultSessionId: 's1', windowHours: 20 },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '激活', messageId: 302 }));
    state.update((data) => {
      data.lastInboundAt = Date.now() - 21 * 3600 * 1000;
      data.contextTokens['wx-user'] = { token: 'context-token-value', updatedAt: Date.now() - 21 * 3600 * 1000 };
    });
    bridge.emitTurn({
      sessionId: 's1',
      turn: 9,
      kind: 'completed',
      text: '迟来的结果',
      files: [],
      fromWechat: true,
    });
    assert.equal(await waitFor(() => state.get().pendingNotices.length >= 1), true);
    assert.ok(bridge.notices.some((entry) => entry.text.includes('未推送到微信') || entry.text.includes('暂存')));
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});

test('unbound session without auto-create tells the user how to bind', async () => {
  const bridge = baseBridge();
  const { channel, transport, dir } = await makeChannel({
    bridge,
    config: {
      defaultSessionId: '',
      autoCreateSessionOnFirstMessage: false,
      sendWelcomeOnActivate: false,
    },
  });
  try {
    await channel.start();
    await channel.handleInbound(inbound({ text: '你好', messageId: 203 }));
    assert.equal(bridge.delivered.length, 0);
    assert.equal(bridge.creates.length, 0);
    assert.ok(transport.sentText.some((entry) => entry.text.includes('/bind') && entry.text.includes('/new')));
  } finally {
    await channel.stop();
    await cleanupDir(dir);
  }
});
