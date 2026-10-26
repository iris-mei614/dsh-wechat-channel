import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, getPluginApi } from '../dist/index.js';
import { cleanupDir, tempDir, FakeLogger } from './helpers.mjs';

function pluginCtx() {
  const logger = new FakeLogger();
  const tools = [];
  const effects = [];
  const services = new Map([
    ['agents', { get() {}, list() { return []; }, async resume() { throw new Error('unused'); }, async create() { throw new Error('unused'); } }],
    ['sessionQuery', { async listSessions() { return []; }, async readSession() { throw new Error('unused'); } }],
  ]);
  return {
    logger: () => logger,
    effect(execute) {
      effects.push(execute);
      return () => {};
    },
    on() { return () => {}; },
    get(name) { return services.get(name); },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    loggerImpl: logger,
    toolsImpl: tools,
    effectsImpl: effects,
  };
}

test('apply registers the three tools and a lifecycle effect', async () => {
  const dir = await tempDir();
  try {
    const ctx = pluginCtx();
    apply(ctx, { stateDir: dir, autoLogin: false, defaultSessionId: 'session-x' });
    assert.deepEqual(ctx.toolsImpl.map((tool) => tool.name).sort(), ['wechat_login', 'wechat_send', 'wechat_status']);
    assert.equal(ctx.effectsImpl.length, 1);

    const disposer = await ctx.effectsImpl[0]();
    assert.equal(typeof disposer, 'function');
    const api = getPluginApi(ctx);
    assert.ok(api);
    assert.equal(api.config.defaultSessionId, 'session-x');
    assert.equal(api.state.get().activeSessionId, 'session-x');

    const statusTool = ctx.toolsImpl.find((tool) => tool.name === 'wechat_status');
    const status = await statusTool.execute({}, {});
    assert.equal(status.activeSessionId, 'session-x');
    assert.equal(status.connected, false);
    assert.equal(status.ownerUserId, '');

    await disposer();
    assert.match(ctx.loggerImpl.text(), /通道启动/);
  } finally {
    await cleanupDir(dir);
  }
});
