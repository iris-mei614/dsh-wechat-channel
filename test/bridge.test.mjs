import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAgentBridge } from '../dist/agent/bridge.js';
import { resolveConfig } from '../dist/config.js';
import { Redactor, createSafeLogger } from '../dist/log.js';
import { fakeCtx, FakeLogger } from './helpers.mjs';

function makeLive(id, options = {}) {
  return {
    id,
    status: options.status ?? 'idle',
    session: { id, header: { id, cwd: options.cwd ?? '/tmp', ...(options.origin ? { origin: options.origin } : {}) } },
    calls: { followup: [], steer: [], inject: [], cancel: [] },
    followup(message) { this.calls.followup.push(message); },
    steer(message) { this.calls.steer.push(message); },
    inject(message) { this.calls.inject.push(message); },
    cancel(cause, opts) { this.calls.cancel.push({ cause, opts }); },
    async whenIdle() {},
  };
}

function makeHost() {
  const ctx = fakeCtx();
  const live = new Map();
  const resumed = [];
  const created = [];
  const mounted = [];
  const archived = ['session-archived'];
  const headers = new Map([
    ['s1', { id: 's1', cwd: '/tmp', agentPreset: 'default' }],
    ['s2', { id: 's2', cwd: '/tmp', agentPreset: 'default' }],
    ['session-archived', { id: 'session-archived', cwd: '/tmp' }],
    ['session-sub', { id: 'session-sub', cwd: '/tmp', origin: 'subagent' }],
  ]);
  const agents = {
    get(id) { return live.get(id); },
    list() { return [...live.values()]; },
    async create(options) {
      created.push(options);
      const agent = makeLive(options.sessionId, { cwd: options.meta?.cwd });
      if (options.setup) await options.setup({}, agent);
      live.set(options.sessionId, agent);
      return { agent, async dispose() { live.delete(options.sessionId); } };
    },
    async resume(options) {
      resumed.push(options);
      const header = headers.get(options.resumeSessionId);
      const agent = makeLive(options.resumeSessionId, { cwd: header?.cwd });
      if (options.setup) await options.setup({}, agent);
      live.set(options.resumeSessionId, agent);
      return { agent, async dispose() { live.delete(options.resumeSessionId); } };
    },
  };
  const sessionQuery = {
    async listSessions() {
      return [...headers.values()].map((header) => ({ header, live: live.has(header.id), persisted: true }));
    },
    async readSession(id) {
      const header = headers.get(id);
      if (!header) {
        const error = new Error('not found');
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      return { session: header, events: [] };
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: headers.get(id), title: { title: `标题-${id}` } },
      }));
    },
    async readTitle(id) {
      return { title: `标题-${id}` };
    },
  };
  const agentPresets = {
    defaultId: 'default',
    async resolve(id) { return { id }; },
    async mount(_ctx, id) { mounted.push(id); },
  };
  const agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) };
  ctx.setService('agents', agents);
  ctx.setService('sessionQuery', sessionQuery);
  ctx.setService('agentPresets', agentPresets);
  ctx.setService('agentDefaultModel', agentDefaultModel);
  ctx.setService('workspaceRegistry', { archivedSessionIds: archived });
  return { ctx, live, resumed, created, mounted, headers, agents, sessionQuery };
}

function makeBridge(host, overrides = {}) {
  const logger = new FakeLogger();
  const redactor = new Redactor();
  return new DshAgentBridge(
    host.ctx,
    resolveConfig({ notifyAllTurns: false, ...overrides }),
    createSafeLogger(logger, redactor),
  );
}

test('live delivery uses followup and tags the native message source', async () => {
  const host = makeHost();
  const agent = makeLive('s1');
  host.live.set('s1', agent);
  const bridge = makeBridge(host);
  const result = await bridge.deliver('s1', '你好', 'followup', { userId: 'wx-user', messageId: 'm1' });
  assert.equal(agent.calls.followup.length, 1);
  const message = agent.calls.followup[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'wechat-channel');
  assert.equal(message.content[0].text, '你好');
  assert.equal(result.messageId, message.id);
  assert.equal(Object.isFrozen(message), true);
  await bridge.dispose();
});

test('steer and inject are rejected unless the target is running', async () => {
  const host = makeHost();
  const agent = makeLive('s1', { status: 'idle' });
  host.live.set('s1', agent);
  const bridge = makeBridge(host);
  await assert.rejects(bridge.deliver('s1', 'x', 'steer', { userId: 'u', messageId: 'm' }), /仅用于正在运行/);
  agent.status = 'running';
  await bridge.deliver('s1', 'x', 'steer', { userId: 'u', messageId: 'm2' });
  await bridge.deliver('s1', 'y', 'inject', { userId: 'u', messageId: 'm3' });
  assert.equal(agent.calls.steer.length, 1);
  assert.equal(agent.calls.inject.length, 1);
  await bridge.dispose();
});

test('offline delivery resumes the session and mounts its preset', async () => {
  const host = makeHost();
  const bridge = makeBridge(host);
  await bridge.deliver('s2', '离线消息', 'followup', { userId: 'u', messageId: 'm1' });
  assert.equal(host.resumed.length, 1);
  assert.equal(host.resumed[0].resumeSessionId, 's2');
  assert.equal(host.mounted[0], 'default');
  const agent = host.live.get('s2');
  assert.equal(agent.calls.followup.length, 1);
  await bridge.dispose();
});

test('createSession mints an id, ensures cwd and uses the default model', async () => {
  const host = makeHost();
  const bridge = makeBridge(host);
  const id = await bridge.createSession('/tmp/new-cwd');
  assert.match(id, /^session-/);
  assert.equal(host.created.length, 1);
  assert.equal(host.created[0].meta.cwd, '/tmp/new-cwd');
  assert.equal(host.created[0].agentOptions.provider, 'deepseek-account');
  assert.equal(host.mounted.at(-1), 'default');
  await bridge.dispose();
});

test('listSessions filters archived/subagent sessions and adds titles', async () => {
  const host = makeHost();
  host.live.set('s2', makeLive('s2', { status: 'running' }));
  const bridge = makeBridge(host);
  const sessions = await bridge.listSessions();
  assert.deepEqual(sessions.map((session) => session.id), ['s2', 's1']);
  assert.equal(sessions[0].status, 'running');
  assert.equal(sessions[0].title, '标题-s2');
  await bridge.dispose();
});

test('turn events emit a completion with assistant text and presented files', async () => {
  const host = makeHost();
  const agent = makeLive('s1');
  host.live.set('s1', agent);
  const bridge = makeBridge(host);
  const results = [];
  bridge.onTurnComplete((result) => results.push(result));

  host.ctx.emit('agent/inbox/claimed', {
    agent,
    message: { source: { kind: 'wechat-channel' } },
    turn: 7,
  });
  host.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 7 } });
  host.ctx.emit('session/event', { id: 's1' }, {
    type: 'assistant/message',
    data: { turn: 7, message: { content: [{ type: 'text', text: '完成结果' }, { type: 'reasoning', text: '思考' }] } },
  });
  host.ctx.emit('session/event', { id: 's1' }, {
    type: 'deliverables/presented',
    data: { turn: 7, files: [{ path: '/tmp/a.png', description: '图' }] },
  });
  host.ctx.emit('session/event', { id: 's1' }, {
    type: 'turn/end',
    data: { turn: 7, reason: { kind: 'completed' } },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'completed');
  assert.equal(results[0].text, '完成结果');
  assert.equal(results[0].fromWechat, true);
  assert.deepEqual(results[0].files, [{ path: '/tmp/a.png', description: '图' }]);
  await bridge.dispose();
});

test('turns not started from WeChat are ignored unless notifyAllTurns is set', async () => {
  const host = makeHost();
  host.live.set('s1', makeLive('s1'));
  const bridge = makeBridge(host);
  const results = [];
  bridge.onTurnComplete((result) => results.push(result));
  host.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
  host.ctx.emit('session/event', { id: 's1' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '手动任务' }] } },
  });
  host.ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(results.length, 0);
  await bridge.dispose();
});

test('error turns carry a readable reason', async () => {
  const host = makeHost();
  const agent = makeLive('s1');
  host.live.set('s1', agent);
  const bridge = makeBridge(host);
  const results = [];
  bridge.onTurnComplete((result) => results.push(result));
  host.ctx.emit('agent/inbox/claimed', { agent, message: { source: { kind: 'wechat-channel' } }, turn: 3 });
  host.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 3 } });
  host.ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } } });
  assert.equal(results[0].kind, 'error');
  assert.equal(results[0].error, 'boom');
  await bridge.dispose();
});

test('cancelSession and sessionStatus reflect the live registry', async () => {
  const host = makeHost();
  const agent = makeLive('s1', { status: 'running' });
  host.live.set('s1', agent);
  const bridge = makeBridge(host);
  assert.equal(await bridge.cancelSession('s1'), true);
  assert.equal(agent.calls.cancel.length, 1);
  const status = await bridge.sessionStatus('s1');
  assert.equal(status.status, 'running');
  assert.equal(status.title, '标题-s1');
  const missing = await bridge.sessionStatus('missing');
  assert.equal(missing.exists, false);
  await bridge.dispose();
});
