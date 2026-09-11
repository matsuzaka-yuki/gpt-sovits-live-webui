import test from 'node:test';
import assert from 'node:assert/strict';
import { TtsService } from '../server/tts.js';
import { QueueManager } from '../server/queue.js';

function setup() {
  const config = { activeParams: { ref_audio_path: 'a.wav' }, presets: { A: { ref_audio_path: 'a.wav' }, B: { ref_audio_path: 'b.wav' } } };
  const tts = new TtsService({ get: () => config });
  const calls = [];
  tts.synthesize = (text, params) => new Promise((resolve, reject) => calls.push({ text, params, resolve, reject }));
  const player = { onEnded(cb) { this.end = cb; }, play(file) { this.played = file; }, stop() {}, getStatus() { return { isPlaying: false }; } };
  return { config, tts, calls, player, queue: new QueueManager(tts, player) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('empty reference is rejected before reaching the API', () => {
  const { tts } = setup();
  assert.throws(() => tts.buildRequestBody('你好', { ref_audio_path: '' }), /参考音频/);
});
test('selected preset is used and queued parameters are immutable', () => {
  const { queue, calls, config } = setup();
  queue.enqueue('你好', { presetName: 'B' });
  config.presets.B.ref_audio_path = 'changed.wav';
  assert.equal(calls[0].params.ref_audio_path, 'b.wav');
  assert.throws(() => queue.enqueue('你好', { presetName: 'missing' }), /不存在/);
});
test('late completion of a cancelled synthesis cannot disrupt the next task', async () => {
  const { queue, calls, player } = setup();
  queue.enqueue('旧任务'); queue.enqueue('新任务'); queue.stopCurrent();
  calls[0].resolve({ filePath: 'old.wav', url: '/old.wav' });
  await tick();
  assert.equal(queue.currentTask.text, '新任务');
  assert.equal(player.played, undefined);
  calls[1].resolve({ filePath: 'new.wav', url: '/new.wav' }); await tick();
  assert.equal(player.played, 'new.wav');
  player.end({ code: 1 });
  assert.equal(queue.history[0].status, 'error');
  assert.equal(queue.history.filter(t => t.text === '旧任务').length, 1);
});
test('late rejection after clear cannot cancel a newly submitted task', async () => {
  const { queue, calls } = setup();
  queue.enqueue('旧任务'); queue.stopAndClearAll(); queue.enqueue('新任务');
  calls[0].reject(new Error('aborted')); await tick();
  assert.equal(queue.currentTask.text, '新任务');
  assert.equal(queue.isProcessing, true);
});
