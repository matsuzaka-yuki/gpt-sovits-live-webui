import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliDanmakuReader, extractDanmaku, filterDanmaku, renderSpeakTemplate } from '../server/bilibili.js';
import { cleanSpeechText } from '../server/text-cleaner.js';

test('smart cleanup preserves meaningful multilingual speech and drops empty decoration', () => {
  assert.equal(cleanSpeechText('萝卜喵-official说：不看我不买低于ａ的\u200b🔥！！！'), '萝卜喵-official说:不看我不买低于a的!');
  assert.equal(cleanSpeechText('你好👨‍👩‍👧‍👦 👍🏽 🇨🇳 1️⃣ **世界**'), '你好 世界');
  assert.equal(cleanSpeechText("don't，3.14，-5，日本語"), "don't,3.14,-5,日本語");
  const options = { smartClean: true, bannedWords: ['bad'], filterMode: 'drop', skipCommands: true };
  assert.equal(filterDanmaku('ｂａ\u200bd', options).action, 'drop');
  assert.equal(filterDanmaku('！点歌', options).reason, '命令消息');
  assert.equal(filterDanmaku('🌸 *** !!!', options).reason, '没有可朗读内容');
  assert.equal(filterDanmaku('bad', { ...options, filterMode: 'mask' }).reason, '没有可朗读内容');
  assert.equal(filterDanmaku('你好!!!', { smartClean: false }).text, '你好!!!');
  assert.equal(filterDanmaku('你\u200b好🌸!!!', options).text, '你好!');
  assert.equal(filterDanmaku('你好！！！', { smartClean: true, maxLength: 3 }).text, '你好!');
});

test('cleanup switch applies to new danmaku and names, preserving source information', (t) => {
  const config = { bilibili: { autoRead: true, smartClean: true, readPrefix: '{user}说：' } };
  const reader = new BilibiliDanmakuReader({ get: () => config });
  t.after(() => reader.stop());
  const spoken = [];
  reader.on('speak', item => spoken.push(item));
  const message = { info: [[], '不看我不买低于a的🌸！！', [1, '萝卜喵-official🌸']] };
  reader.handleMessage(message);
  assert.equal(spoken[0].text, '萝卜喵-official说:不看我不买低于a的!');
  assert.equal(spoken[0].rawText, message.info[1]);
  assert.equal(spoken[0].user, message.info[2][1]);
  reader.handleMessage({ info: [[], '🌸！！！', [1, '观众']] });
  assert.equal(spoken.length, 1);
  reader.handleMessage({ info: [[], '你好', [1, '🌸']] });
  assert.equal(spoken[1].text, '观众说:你好');
  reader.handleMessage({ info: [[], '你好', [1, 'M***']] });
  assert.equal(spoken[2].text, '观众说:你好');
  config.bilibili.smartClean = false;
  reader.handleMessage(message);
  assert.equal(spoken[3].text, '萝卜喵-official🌸说：不看我不买低于a的🌸！！');
});

test('renders dynamic speak templates with real sender information', () => {
  const context = { user: '测试用户', uid: 123456, roomId: 5928158 };
  assert.equal(renderSpeakTemplate('', context), '');
  assert.equal(renderSpeakTemplate('弹幕说：', context), '弹幕说：');
  assert.equal(renderSpeakTemplate('{user}说：', context), '测试用户说：');
  assert.equal(renderSpeakTemplate('{name}：', context), '测试用户：');
  assert.equal(renderSpeakTemplate('观众{user}说：', context), '观众测试用户说：');
  assert.equal(renderSpeakTemplate('{uid}-{room}', context), '123456-5928158');
  assert.equal(renderSpeakTemplate('{user}说：', { user: '未知用户', uid: 0, roomId: 0 }), '观众说：');
  assert.equal(renderSpeakTemplate('{user}说：', { user: '   ', uid: 0, roomId: 0 }), '观众说：');
  assert.equal(renderSpeakTemplate('{user}说：', { user: 'M***', uid: 0, roomId: 0 }), '观众说：');
  assert.equal(renderSpeakTemplate('{user}说：', { user: '空***', uid: 0, roomId: 0 }), '观众说：');
  assert.equal(renderSpeakTemplate('观众{user}说：', { user: 'M***', uid: 0, roomId: 0 }), '观众说：');
  assert.equal(renderSpeakTemplate('观众{user}说：', { user: '小明', uid: 1, roomId: 0 }), '观众小明说：');
  assert.equal(renderSpeakTemplate('{nickname}说：', context), '{nickname}说：');
});

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
        readPrefix: '{user}说：'
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
  assert.equal(spoken[0].text, '测试用户说：这是*广告');
  assert.equal(spoken[0].user, '测试用户');
  assert.equal(reader.status().stats.spoken, 1);
  assert.equal(reader.status().loggedIn, false);
  assert.equal(reader.status().maskedReceived, 0);

  const masked = new Event('DANMU_MSG');
  masked.data = { info: [[0, 1, 25], '打码昵称的弹幕', [0, 'M***']] };
  socket.dispatchEvent(masked);
  assert.equal(reader.status().maskedReceived, 1);
  assert.equal(spoken[1].text, '观众说：打码昵称的弹幕');

  const duplicate = new Event('DANMU_MSG');
  duplicate.data = { info: [[0, 1, 25], '这是赌博广告', [123, '测试用户']] };
  socket.dispatchEvent(duplicate);
  assert.equal(spoken.length, 2);
  assert.equal(reader.status().stats.skipped, 1);
});

test('changing the room or cookie reconnects the listener while it is running', async (t) => {
  const config = {
    bilibili: {
      enabled: true,
      roomId: 1001,
      autoRead: false,
      cookie: '',
      minLength: 1,
      maxLength: 100,
      rateLimitSeconds: 0,
      duplicateWindowSeconds: 0,
      maxPending: 12,
      skipCommands: true,
      stripUrls: true,
      stripEmoticons: true,
      filterMode: 'mask',
      bannedWords: [],
      replacement: '*',
      readPrefix: ''
    }
  };
  const sockets = [];
  const apiClient = {
    cookies: { get: () => null },
    async initCookie() {},
    async liveRoomInit({ id }) { return { data: { room_id: id } }; },
    async xliveGetDanmuInfo() { return { data: { token: 'token', host_list: [{ host: 'example.com' }] } }; }
  };
  const reader = new BilibiliDanmakuReader({ get: () => config }, {
    apiClientFactory: () => apiClient,
    liveFactory: (roomId) => {
      const next = new EventTarget();
      next.roomId = roomId;
      next.closed = false;
      next.close = () => { next.closed = true; };
      sockets.push(next);
      return next;
    },
    getPendingCount: () => 0
  });
  t.after(() => reader.stop());

  reader.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].roomId, 1001);

  // 只改 Cookie：必须断开旧连接并按新身份重连
  config.bilibili.cookie = 'SESSDATA=demo';
  reader.applyConfig();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);

  // 只改房间号：同样要重连
  config.bilibili.roomId = 2002;
  reader.applyConfig();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[1].closed, true);
  assert.equal(sockets.length, 3);
  assert.equal(sockets[2].roomId, 2002);

  // 关闭开关：断开且不再新建连接
  config.bilibili.enabled = false;
  reader.applyConfig();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[2].closed, true);
  assert.equal(sockets.length, 3);
  assert.equal(reader.status().state, 'stopped');
});
