#!/usr/bin/env node
/**
 * Offline end-to-end smoke test:
 *
 *   inbound WeChat text
 *     -> fake iLink transport
 *     -> fake DSH agent bridge
 *     -> turn completion
 *     -> outbound WeChat text
 *
 * It exercises the same channel code used in production without network or
 * model calls. Run with `npm run smoke` (builds first).
 */
import assert from 'node:assert/strict';
import { FakeBridge, FakeTransport, inbound, makeChannel, waitFor, cleanupDir } from '../test/helpers.mjs';

const bridge = new FakeBridge();
bridge.sessions.set('session-smoke', {
  id: 'session-smoke',
  title: 'smoke',
  cwd: process.cwd(),
  status: 'idle',
  live: true,
});

const transport = new FakeTransport();
const { channel, state, dir } = await makeChannel({
  bridge,
  transport,
  config: { defaultSessionId: 'session-smoke' },
});

try {
  await channel.start();
  await channel.handleInbound(inbound({ text: '你好，做个冒烟测试', messageId: 9001 }));
  assert.equal(bridge.delivered.length, 1);
  assert.equal(bridge.delivered[0].sessionId, 'session-smoke');
  assert.equal(bridge.delivered[0].mode, 'followup');

  bridge.emitTurn({
    sessionId: 'session-smoke',
    turn: 1,
    kind: 'completed',
    text: '冒烟测试通过。',
    files: [],
    fromWechat: true,
  });

  const ok = await waitFor(() => transport.sentText.some((entry) => entry.text.includes('冒烟测试通过')));
  assert.equal(ok, true);
  assert.ok(state.get().lastInboundAt > 0);
  console.log('PASS inbound -> DSH followup -> turn/end -> WeChat outbound');
  console.log(`   inbound=${state.get().counters.inbound} outbound=${state.get().counters.outbound}`);
} finally {
  await channel.stop();
  await cleanupDir(dir);
}
