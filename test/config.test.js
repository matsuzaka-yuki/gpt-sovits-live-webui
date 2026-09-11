import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../server/config.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovits-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'config.json');
}

test('mode, nested settings and presets survive restart and concurrent saves', async t => {
  const file = await fixture(t);
  const store = new ConfigStore(file);
  await store.load();
  assert.equal(store.get().inferenceMode, 'local');
  await Promise.all([
    store.update({ localInference: { rootPath: 'D:\\Models\\中文 folder', device: 'cpu' } }),
    store.update({ localInference: { precision: 'full' }, presets: { Voice: { ref_audio_path: 'voice.wav' } } }),
    store.update({ quickTexts: ['你好'], volume: 75 })
  ]);
  const restored = new ConfigStore(file);
  await restored.load();
  assert.equal(restored.get().localInference.rootPath, 'D:\\Models\\中文 folder');
  assert.equal(restored.get().localInference.device, 'cpu');
  assert.equal(restored.get().localInference.precision, 'full');
  assert.equal(restored.get().presets.Voice.ref_audio_path, 'voice.wav');
  assert.deepEqual(restored.get().quickTexts, ['你好']);
  assert.equal(restored.get().volume, 75);
  await assert.rejects(store.update({ inferenceMode: 'invalid' }));
  assert.equal(store.get().inferenceMode, 'local');
});

test('legacy configuration keeps external mode and corrupt files are preserved', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ apiEndpoint: 'http://localhost:9880/tts', volume: 45 }));
  const store = new ConfigStore(file);
  await store.load();
  assert.equal(store.get().inferenceMode, 'external');
  assert.equal(store.get().volume, 45);
  await fs.writeFile(file, '{broken');
  await assert.rejects(new ConfigStore(file).load(), /无法读取配置/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('a failed disk save rolls back in-memory settings', async t => {
  const file = await fixture(t);
  const store = new ConfigStore(file);
  await store.load();
  await fs.mkdir(file + '.tmp');
  await assert.rejects(store.update({ volume: 25 }));
  assert.equal(store.get().volume, 100);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).volume, 100);
});
