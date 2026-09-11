import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../server/config.js';
import { LocalInference } from '../server/local-inference.js';

const fakeWorker = `
const readline = require('node:readline');
let configured = false;
readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!configured) { configured = true; console.log(JSON.stringify({ready:true,device:'cpu'})); return; }
  if (message.params.text === 'crash') process.exit(3);
  if (message.params.text === 'wait') return;
  console.log(JSON.stringify({id: message.id, ok: true}));
});`;

test('worker reuses its process, handles cancellation, reloads and reports crashes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovits-worker-'));
  const moduleDir = path.join(dir, 'GPT_SoVITS', 'TTS_infer_pack');
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(path.join(moduleDir, 'TTS.py'), '');
  const store = new ConfigStore(path.join(dir, 'config.json'));
  await store.load();
  await store.update({ localInference: { rootPath: dir } });
  let launches = 0;
  const worker = new LocalInference(store, (_python, _args, options) => {
    launches++;
    return spawn(process.execPath, ['-e', fakeWorker], options);
  });
  t.after(async () => { await worker.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  await worker.synthesize({ text: 'first' }, 'unused');
  await worker.synthesize({ text: 'second' }, 'unused');
  assert.equal(launches, 1);
  assert.equal(worker.status().state, 'ready');
  const controller = new AbortController();
  const pending = worker.synthesize({ text: 'wait' }, 'unused', controller.signal);
  const rejection = assert.rejects(pending, /取消/);
  await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort();
  await rejection;
  await worker.synthesize({ text: 'after cancel' }, 'unused');
  assert.equal(launches, 2);
  await assert.rejects(worker.synthesize({ text: 'crash' }, 'unused'), /进程退出/);
  assert.equal(worker.status().state, 'error');
  await worker.stop();
  assert.equal(worker.status().state, 'stopped');
});
