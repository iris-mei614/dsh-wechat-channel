import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../dist/tools.js';
import { FakeLogger } from './helpers.mjs';

function makeCtx() {
  const tools = [];
  return {
    logger: () => new FakeLogger(),
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    toolsList: tools,
  };
}

test('wechat_send passes the calling agent session id for file-root validation', async () => {
  const ctx = makeCtx();
  const calls = [];
  const channel = {
    async sendFromTool(input) {
      calls.push(input);
      return { user: 'wx-user', textParts: 1, files: 1 };
    },
    async getStatusSnapshot() { return {}; },
    async beginLogin() { return { connected: false, status: 'waiting-login', message: '' }; },
  };
  registerTools(ctx, channel, { info() {}, warn() {}, error() {}, debug() {} });
  const send = ctx.toolsList.find((tool) => tool.name === 'wechat_send');
  assert.ok(send);
  await send.execute(
    { text: '结果在下面', files: ['/tmp/example/out/a.mp4'] },
    { agent: { id: 'session-other' }, signal: new AbortController().signal },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-other');
  assert.deepEqual(calls[0].files, [{ path: '/tmp/example/out/a.mp4' }]);
});
