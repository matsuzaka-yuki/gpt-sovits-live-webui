import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { ref, computed } from 'vue';

// Exercise the actual component's WebSocket handler without a browser or server.
function client() {
  const source = fs.readFileSync(new URL('../client/src/App.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = descriptor.scriptSetup.content.replace(/^import .* from 'vue';$/m, '');
  let socket;
  const context = vm.createContext({
    ref, computed, onMounted() {}, onUnmounted() {},
    location: { protocol: 'http:', host: 'localhost:9870' },
    WebSocket: class { constructor() { socket = this; } }
  });
  vm.runInContext(`${script}\nconnect();`, context);
  return {
    send(message) { socket.onmessage({ data: JSON.stringify(message) }); },
    read(expression) { return vm.runInContext(expression, context); }
  };
}

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
