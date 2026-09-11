import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliLogin } from '../server/bilibili-login.js';

function fixture(save = async () => {}) {
  let now = 1000;
  const replies = [];
  const calls = [];
  const login = new BilibiliLogin(save, {
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/generate')) return Response.json({ code: 0, data: {
        url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?key=example', qrcode_key: 'test-key'
      } });
      const next = replies.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    }
  });
  return { login, replies, calls, advance: (ms = 2000) => { now += ms; } };
}

function response(code, cookies = []) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json({ code: 0, data: { code } }, { headers });
}
const credentials = ['SESSDATA=opaque%2Ctoken; Path=/; HttpOnly', 'bili_jct=csrf; Path=/', 'DedeUserID=123; Path=/'];

test('QR login progresses through scan and confirmation and saves cookies exactly once', async () => {
  const saved = [];
  const f = fixture(async cookie => saved.push(cookie));
  const qr = await f.login.generate();
  assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(qr.expiresAt, 181000);
  assert.equal(qr.qrcode_key, undefined);
  for (const [code, state] of [[86101, 'waiting'], [86090, 'scanned'], [0, 'success']]) {
    f.replies.push(response(code, code === 0 ? credentials : []));
    assert.deepEqual(await f.login.poll(qr.id), { state });
    f.advance();
  }
  assert.deepEqual(saved, ['SESSDATA=opaque%2Ctoken; bili_jct=csrf; DedeUserID=123']);
  assert.deepEqual(await f.login.poll(qr.id), { state: 'success' });
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.at(-1).options.redirect, 'error');
});

test('expired and cancelled sessions cannot save credentials', async () => {
  const f = fixture(() => assert.fail('must not save'));
  const qr = await f.login.generate();
  f.replies.push(response(86038));
  assert.equal((await f.login.poll(qr.id)).state, 'expired');
  const qr2 = await f.login.generate();
  f.advance(180000);
  assert.equal((await f.login.poll(qr2.id)).state, 'expired');
  const qr3 = await f.login.generate();
  let resolve;
  f.replies.push(() => new Promise(r => { resolve = r; }));
  const pending = f.login.poll(qr3.id);
  f.login.cancel(qr3.id);
  resolve(response(0, credentials));
  assert.equal((await pending).state, 'expired');
  assert.equal((await f.login.poll('missing')).state, 'expired');
});

test('parallel polls share a request and rapid polls are throttled', async () => {
  const f = fixture();
  const qr = await f.login.generate();
  let resolve;
  f.replies.push(() => new Promise(r => { resolve = r; }));
  const a = f.login.poll(qr.id), b = f.login.poll(qr.id);
  resolve(response(86101));
  assert.deepEqual(await a, await b);
  await f.login.poll(qr.id);
  assert.equal(f.calls.length, 2);
});

test('network failures and incomplete credentials never report login success', async () => {
  const f = fixture(() => assert.fail('must not save'));
  const qr = await f.login.generate();
  f.replies.push(new Error('network unavailable'));
  await assert.rejects(f.login.poll(qr.id), /network/);
  f.replies.push(response(0, ['SESSDATA=partial; Path=/']));
  await assert.rejects(f.login.poll(qr.id), /完整/);
  f.replies.push(response(86101));
  assert.equal((await f.login.poll(qr.id)).state, 'waiting');
});

test('failed credential persistence is retried rather than reporting success', async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts === 1) throw new Error('disk full'); });
  const qr = await f.login.generate();
  f.replies.push(response(0, credentials), response(0, credentials));
  await assert.rejects(f.login.poll(qr.id), /disk full/);
  assert.equal((await f.login.poll(qr.id)).state, 'success');
  assert.equal(attempts, 2);
});
