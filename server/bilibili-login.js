import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

const BASE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/';
const STATES = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' };

export class BilibiliLogin {
  constructor(saveCookie, { fetchImpl = fetch, now = Date.now } = {}) {
    this.saveCookie = saveCookie;
    this.fetch = fetchImpl;
    this.now = now;
    this.sessions = new Map();
  }

  async request(action) {
    const response = await this.fetch(BASE + action, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    });
    if (!response.ok) throw new Error('B站登录服务暂时不可用，请稍后重试');
    const result = await response.json();
    if (result.code !== 0 || !result.data) throw new Error('B站登录请求失败，请稍后重试');
    return { data: result.data, headers: response.headers };
  }

  async generate() {
    for (const [id, session] of this.sessions) {
      if (this.now() >= session.expiresAt) this.sessions.delete(id);
    }
    if (this.sessions.size >= 10) throw new Error('打开的登录二维码过多，请关闭旧窗口或稍后重试');
    const { data } = await this.request('generate');
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || !['passport.bilibili.com', 'account.bilibili.com'].includes(url.hostname) || typeof data.qrcode_key !== 'string' || !data.qrcode_key) {
      throw new Error('B站返回了无效的登录二维码');
    }
    const qrDataUrl = await QRCode.toDataURL(url.href, { width: 260, margin: 2 });
    const id = randomUUID();
    const expiresAt = this.now() + 180000;
    this.sessions.set(id, { key: data.qrcode_key, expiresAt, state: 'waiting', lastPoll: -Infinity });
    return { id, qrDataUrl, expiresAt, state: 'waiting' };
  }

  cancel(id) { this.sessions.delete(id); }

  async poll(id) {
    const session = this.sessions.get(id);
    if (!session || this.now() >= session.expiresAt) {
      this.sessions.delete(id);
      return { state: 'expired' };
    }
    if (session.pending) return session.pending;
    if (session.state === 'success' || session.state === 'expired' || this.now() - session.lastPoll < 1800) {
      return { state: session.state };
    }
    session.pending = this.update(id, session);
    try { return await session.pending; } finally { session.pending = null; }
  }

  async update(id, session) {
    const { data, headers } = await this.request('poll?qrcode_key=' + encodeURIComponent(session.key));
    if (this.sessions.get(id) !== session || this.now() >= session.expiresAt) return { state: 'expired' };
    if (data.code === 0) {
      // Only response cookies are credentials; never follow the callback URL.
      const cookies = new Map();
      for (const header of headers.getSetCookie()) {
        const pair = header.split(';', 1)[0];
        const split = pair.indexOf('=');
        if (split > 0) cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
      }
      if (!cookies.get('SESSDATA') || !cookies.get('bili_jct') || !/^\d+$/.test(cookies.get('DedeUserID') || '')) {
        throw new Error('未获取到完整的登录信息，请刷新二维码重新扫码');
      }
      await this.saveCookie([...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      session.state = 'success';
      session.key = '';
    } else {
      session.state = STATES[data.code];
      if (!session.state) throw new Error('B站返回了未知登录状态，请刷新二维码重试');
    }
    session.lastPoll = this.now();
    return { state: session.state };
  }
}
