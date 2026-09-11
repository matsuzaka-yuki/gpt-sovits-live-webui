import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliDanmakuReader, extractDanmaku, filterDanmaku } from '../server/bilibili.js';

test('extracts danmaku text and filters banned words', () => {
  const message = {
    info: [
      [0, 1, 25],
      '  欢迎  大家来看直播 https://example.com  ',
      [123, '测试用户'],
      []
    ]
  };
  const item = extractDanmaku(message);
  assert.deepEqual(item, { text: '欢迎 大家来看直播 https://example.com', uid: 123, name: '测试用户' });

  const masked = filterDanmaku('这是赌博广告，欢迎举报', {
    bannedWords: ['赌博'],
    replacement: '***',
    filterMode: 'mask',
    minLength: 1,
    maxLength: 100,
    skipCommands: true,
    stripUrls: true,
    stripEmoticons: true
  });
  assert.equal(masked.action, 'mask');
  assert.equal(masked.text, '这是***广告，欢迎举报');
});

test('drops commands, links-only messages and banned messages when configured', () => {
  const base = {
    bannedWords: ['诈骗'],
    filterMode: 'drop',
    minLength: 1,
    maxLength: 10,
    skipCommands: true,
    stripUrls: true,
    stripEmoticons: true
  };
  assert.equal(filterDanmaku('!点歌', base).action, 'drop');
  assert.equal(filterDanmaku('https://example.com', base).reason, '没有可朗读内容');
  assert.equal(filterDanmaku('这是诈骗内容', base).action, 'drop');
  assert.equal(filterDanmaku('这是一条很长很长的弹幕', base).reason, '太长');
  assert.equal(filterDanmaku('六年了[dog]', base).text, '六年了');
  assert.equal(filterDanmaku('正常弹幕', base).action, 'keep');
});

test('reader connects with a visitor session and sends filtered comments to the queue', async (t) => {
  const configStore = {
    get: () => ({
      bilibili: {
        enabled: true,
        roomId: 5928158,
        autoRead: true,
        cookie: '',
        minLength: 1,
        maxLength: 100,
        rateLimitSeconds: 0,
        duplicateWindowSeconds: 60,
        maxPending: 12,
        skipCommands: true,
        stripUrls: true,
        stripEmoticons: true,
        filterMode: 'mask',
        bannedWords: ['赌博'],
        replacement: '*',
        readPrefix: '弹幕说：'
      }
    })
  };
  const socket = new EventTarget();
  socket.close = () => {};
  const apiClient = {
    cookies: { get: () => null },
    async initCookie() {},
    async liveRoomInit() { return { data: { room_id: 5928158 } }; },
    async xliveGetDanmuInfo() {
      return { data: { token: 'token', host_list: [{ host: 'example.com' }] } };
    }
  };
  const reader = new BilibiliDanmakuReader(configStore, {
    apiClientFactory: () => apiClient,
    liveFactory: () => socket,
    getPendingCount: () => 0
  });
  t.after(() => reader.stop());

  const spoken = [];
  reader.on('speak', (item) => spoken.push(item));
  reader.start();
  await new Promise((resolve) => setImmediate(resolve));
  socket.dispatchEvent(new Event('CONNECT_SUCCESS'));
  assert.equal(reader.status().state, 'connected');

  const danmaku = new Event('DANMU_MSG');
  danmaku.data = { info: [[0, 1, 25], '这是赌博广告', [123, '测试用户']] };
  socket.dispatchEvent(danmaku);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, '弹幕说：这是*广告');
  assert.equal(spoken[0].user, '测试用户');
  assert.equal(reader.status().stats.spoken, 1);

  const duplicate = new Event('DANMU_MSG');
  duplicate.data = { info: [[0, 1, 25], '这是赌博广告', [123, '测试用户']] };
  socket.dispatchEvent(duplicate);
  assert.equal(spoken.length, 1);
  assert.equal(reader.status().stats.skipped, 1);
});
