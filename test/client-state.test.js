import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { ref, computed } from 'vue';
import Fastify from 'fastify';

// Exercise the actual component's WebSocket handler without a browser or server.
function client(overrides = {}) {
  const source = fs.readFileSync(new URL('../client/src/App.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = descriptor.scriptSetup.content.replace(/^import .* from 'vue';$/m, '');
  let socket;
  const context = vm.createContext({
    ref, computed, onMounted() {}, onUnmounted() {},
    location: { protocol: 'http:', host: 'localhost:9870' },
    WebSocket: class { constructor() { socket = this; } },
    ...overrides
  });
  vm.runInContext(`${script}\nconnect();`, context);
  return {
    send(message) { socket.onmessage({ data: JSON.stringify(message) }); },
    read(expression) { return vm.runInContext(expression, context); }
  };
}

test('client requests pass Fastify parsing with and without JSON bodies', async t => {
  const server = Fastify();
  t.after(() => server.close());
  server.post('/generate', async () => ({ success: true, state: 'waiting' }));
  server.post('/poll', async req => ({ success: true, id: req.body.id }));
  server.get('/status', async () => ({ success: true }));
  server.delete('/queue/1', async () => ({ success: true }));
  const app = client({
    fetch: async (url, options) => {
      const result = await server.inject({ url, method: options.method, headers: options.headers, payload: options.body });
      return { ok: result.statusCode === 200, json: async () => result.json() };
    }
  });
  assert.equal((await app.read("request('/generate')")).state, 'waiting');
  assert.equal((await app.read("request('/poll', { id: 'qr-session' })")).id, 'qr-session');
  assert.equal((await app.read("request('/status', undefined, 'GET')")).success, true);
  assert.equal((await app.read("request('/queue/1', undefined, 'DELETE')")).success, true);
});

test('Bilibili updates leave the queue renderable between synthesis updates', () => {
  const app = client();
  const current = { id: '1', text: '正在朗读', status: 'playing' };
  const waiting = { id: '2', text: '下一句', status: 'pending' };
  const initial = {
    type: 'state',
    data: { queue: [current, waiting], history: [], currentTask: current },
    config: { presets: { voice: {} }, currentPresetName: 'voice' },
    bilibili: { state: 'connected', stats: { received: 0 } }
  };
  app.send(initial);
  const queueState = app.read('state.value');
  assert.equal(app.read('selected.value'), 'voice');
  assert.equal(app.read('bilibili.value.state'), 'connected');

  for (const state of ['connected', 'reconnecting', 'stopped']) {
    app.send({ type: 'bilibili', data: { state, stats: { received: 1 }, recent: [] } });
    assert.equal(app.read('state.value'), queueState);
    assert.equal(app.read('pending.value.length'), 1);
    assert.equal(app.read('state.value.currentTask.text'), '正在朗读');
    assert.equal(app.read('state.value.history.length'), 0);
    assert.equal(app.read('bilibili.value.state'), state);
  }

  app.send({ type: 'state', data: { queue: [waiting], history: [current], currentTask: waiting } });
  assert.equal(app.read('pending.value.length'), 0);
  assert.equal(app.read('state.value.history[0].id'), '1');
  assert.equal(app.read('state.value.currentTask.id'), '2');

  app.send({ type: 'config', config: { presets: {}, currentPresetName: '_custom' } });
  assert.equal(app.read('selected.value'), '_custom');
  assert.equal(app.read('state.value.currentTask.id'), '2');
});

test('login broadcast updates credentials without replacing unsaved settings or queue state', () => {
  const app = client();
  app.send({ type: 'state', data: { queue: [], history: [] }, config: {
    presets: {}, bilibili: { cookie: 'old', roomId: 123, readPrefix: '未保存的模板' }
  } });
  const state = app.read('state.value');
  app.send({ type: 'bilibili-login', cookie: 'new', bilibili: { state: 'connecting' } });
  assert.equal(app.read('config.value.bilibili.cookie'), 'new');
  assert.equal(app.read('config.value.bilibili.roomId'), 123);
  assert.equal(app.read('config.value.bilibili.readPrefix'), '未保存的模板');
  assert.equal(app.read('state.value'), state);
});

test('closing a login dialog discards a late QR response and cancels its server session', async () => {
  let resolve;
  const cancelled = [];
  const app = client({
    clearTimeout() {},
    setTimeout() { assert.fail('closed dialog must not start polling'); },
    fetch: async (url, options) => {
      if (url.endsWith('/generate')) return new Promise(r => { resolve = r; });
      if (url.endsWith('/cancel')) cancelled.push(JSON.parse(options.body).id);
      return { ok: true, json: async () => ({ success: true }) };
    }
  });
  const pending = app.read('openBilibiliLogin()');
  app.read('closeBilibiliLogin()');
  resolve({ ok: true, json: async () => ({ success: true, id: 'late', qrDataUrl: 'image', state: 'waiting' }) });
  await pending;
  assert.equal(app.read('showBilibiliLogin.value'), false);
  assert.equal(app.read('loginQr.value'), '');
  assert.deepEqual(cancelled, ['late']);
});
