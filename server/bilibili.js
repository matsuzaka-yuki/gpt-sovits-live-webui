import { EventEmitter } from "node:events";
import { WebSocket as NodeWebSocket } from "ws";
import { BilibiliApiClient, LiveWS, parseLiveConfig } from "bilibili-live-danmaku";

// Node 20 does not expose a global WebSocket yet. The maintained danmaku
// client accepts a global implementation, so reuse the ws package there.
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = NodeWebSocket;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const MAX_LOGS = 40;
const MAX_RECENT = 20;
const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;
const EMOTICON_PATTERN = /\[[^\[\]]{1,16}\]/g;
const TEMPLATE_PATTERN = /\{(user|name|uid|room)\}/gi;
const PROTOCOL_UNKNOWN_USER = "未知用户";
const FALLBACK_USER_NAME = "观众";
// B 站会给未登录访客返回 M***、空*** 这种打码昵称，朗读时替换成通用称呼。
const MASKED_USER_NAME = /\*{2,}/;

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function connectionSignature(config) {
  return JSON.stringify([
    Boolean(config.enabled),
    Number(config.roomId) || 0,
    String(config.cookie || "")
  ]);
}

function clampText(value, maxLength) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function extractDanmaku(message) {
  const info = message?.info;
  const user = info && (Array.isArray(info) ? info[2] : info[2]);
  const text = normalizeText(info && (Array.isArray(info) ? info[1] : info[1]));
  if (!text) return null;
  return {
    text,
    uid: Number(user?.[0]) || 0,
    name: String(user?.[1] || "未知用户")
  };
}

export function filterDanmaku(value, options = {}) {
  let text = normalizeText(value);
  const minLength = Number(options.minLength ?? 1);
  const maxLength = Number(options.maxLength ?? 100);
  const replacement = String(options.replacement || "*").slice(0, 12) || "*";

  if (options.skipCommands && /^[!/#]/.test(text)) {
    return { action: "drop", text, reason: "命令消息" };
  }
  if (options.stripUrls) {
    text = text.replace(URL_PATTERN, " ").replace(/\s+/g, " ").trim();
  }
  if (options.stripEmoticons) {
    text = text.replace(EMOTICON_PATTERN, " ").replace(/\s+/g, " ").trim();
  }
  if (!text) return { action: "drop", text, reason: "没有可朗读内容" };
  if (text.length < minLength) return { action: "drop", text, reason: "太短" };
  if (text.length > maxLength) return { action: "drop", text, reason: "太长" };

  const words = Array.isArray(options.bannedWords)
    ? options.bannedWords.map((word) => String(word).trim()).filter(Boolean)
    : [];
  const matched = words.some((word) => text.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
  if (!matched) return { action: "keep", text, reason: "" };
  if (options.filterMode === "drop") {
    return { action: "drop", text, reason: "命中违禁词" };
  }

  for (const word of words) {
    text = text.replace(new RegExp(escapeRegExp(word), "gi"), () => replacement);
  }
  return { action: "mask", text, reason: "已替换违禁词" };
}

// 朗读模板：把 {user} {name} {uid} {room} 替换成真实弹幕信息，
// 这样前缀可以是动态的，例如 “{user}说：”。
export function renderSpeakTemplate(template, context = {}) {
  const source = typeof template === "string" ? template : "";
  if (!source) return "";
  const rawName = normalizeText(context.user);
  const userName = !rawName || rawName === PROTOCOL_UNKNOWN_USER || MASKED_USER_NAME.test(rawName)
    ? FALLBACK_USER_NAME
    : clampText(rawName, 24);
  const rendered = source.replace(TEMPLATE_PATTERN, (match, key) => {
    switch (String(key).toLowerCase()) {
      case "user":
      case "name":
        return userName;
      case "uid":
        return String(Number(context.uid) || "");
      case "room":
        return String(Number(context.roomId) || "");
      default:
        return match;
    }
  });
  return normalizeText(rendered);
}

export class BilibiliDanmakuReader extends EventEmitter {
  constructor(configStore, options = {}) {
    super();
    this.configStore = configStore;
    this.apiClientFactory = options.apiClientFactory || ((clientOptions) => new BilibiliApiClient(clientOptions));
    this.liveFactory = options.liveFactory || ((roomId, liveOptions) => new LiveWS(roomId, liveOptions));
    this.getPendingCount = options.getPendingCount || (() => 0);
    this.ws = null;
    this.connectTimer = null;
    this.statusTimer = null;
    this.running = false;
    this.connecting = false;
    this.generation = 0;
    this.state = "stopped";
    this.error = "";
    this.roomId = null;
    this.connectedAt = null;
    this.retryDelay = RETRY_BASE_MS;
    this.logs = [];
    this.recent = [];
    this.seen = new Map();
    this.userRate = new Map();
    this.stats = {
      received: 0,
      spoken: 0,
      filtered: 0,
      skipped: 0,
      failed: 0
    };
    this.connectionSignature = connectionSignature(this.config());
  }

  config() {
    return this.configStore.get().bilibili || {};
  }

  start() {
    if (this.running) return this.status();
    this.running = true;
    this.generation += 1;
    this.retryDelay = RETRY_BASE_MS;
    this.connectionSignature = connectionSignature(this.config());
    this.error = "";
    this.connect().catch((error) => {
      this.log(`连接任务异常：${error.message}`);
      this.scheduleReconnect(this.generation);
    });
    return this.status();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.connecting = false;
    this.retryDelay = RETRY_BASE_MS;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    this.state = "stopped";
    this.error = "";
    this.connectedAt = null;
    this.roomId = null;
    this.log("弹幕监听已停止");
    this.emitStatus();
    return this.status();
  }

  applyConfig() {
    const config = this.config();
    const signature = connectionSignature(config);
    if (signature !== this.connectionSignature) {
      this.connectionSignature = signature;
      if (config.enabled) this.start();
      else this.stop();
      return;
    }
    if (config.enabled && !this.running && !this.connecting && !this.connectTimer) {
      this.start();
    }
  }

  status() {
    const config = this.config();
    return {
      state: this.state,
      enabled: Boolean(config.enabled),
      roomId: this.roomId || Number(config.roomId) || 0,
      connectedAt: this.connectedAt,
      error: this.error,
      logs: this.logs.join("\n"),
      stats: { ...this.stats },
      recent: this.recent.map((item) => ({ ...item }))
    };
  }

  async connect() {
    if (!this.running || this.connecting) return;
    const generation = this.generation;
    const config = this.config();
    const inputRoomId = Number(config.roomId);
    if (!Number.isInteger(inputRoomId) || inputRoomId <= 0) {
      this.error = "请填写有效的 B站房间号";
      this.state = "error";
      this.log(this.error);
      this.emitStatus();
      this.scheduleReconnect(generation);
      return;
    }

    this.connecting = true;
    this.state = this.retryDelay > RETRY_BASE_MS ? "reconnecting" : "connecting";
    this.error = "";
    this.log(`正在连接 B站房间 ${inputRoomId}…`);
    this.emitStatus();

    try {
      const cookie = String(config.cookie || "").trim();
      const client = this.apiClientFactory(cookie ? { cookie } : {});
      await client.initCookie();
      if (!this.running || generation !== this.generation) return;

      const roomInit = await client.liveRoomInit({ id: inputRoomId });
      const resolvedRoomId = Number(roomInit?.data?.room_id) || inputRoomId;
      const info = await client.xliveGetDanmuInfo({ id: resolvedRoomId });
      const liveConfig = parseLiveConfig(info.data);
      const uid = Number(client.cookies.get("DedeUserID")) || 0;
      const buvid = client.cookies.get("buvid3") || client.cookies.get("buvid4") || undefined;

      if (!this.running || generation !== this.generation) return;
      const ws = this.liveFactory(resolvedRoomId, { ...liveConfig, uid, buvid });
      if (!this.running || generation !== this.generation) {
        try {
          ws.close();
        } catch {}
        return;
      }
      this.ws = ws;
      this.roomId = resolvedRoomId;
      this.bindSocket(ws, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error.message || String(error);
      this.state = "error";
      this.log(`B站弹幕连接失败：${this.error}`);
      this.emitStatus();
      this.scheduleReconnect(generation);
    } finally {
      if (generation === this.generation) this.connecting = false;
    }
  }

  bindSocket(ws, generation) {
    const isCurrent = () => this.running && generation === this.generation && this.ws === ws;

    ws.addEventListener("open", () => {
      if (isCurrent()) this.log("弹幕 WebSocket 已打开");
    });
    ws.addEventListener("CONNECT_SUCCESS", () => {
      if (!isCurrent()) return;
      this.state = "connected";
      this.connectedAt = Date.now();
      this.error = "";
      this.retryDelay = RETRY_BASE_MS;
      this.log("弹幕监听已连接");
      this.emitStatus();
    });
    ws.addEventListener("HEARTBEAT_REPLY", () => {
      if (isCurrent()) this.emitStatusSoon();
    });
    ws.addEventListener("DANMU_MSG", (event) => {
      if (isCurrent()) this.handleMessage(event.data);
    });
    ws.addEventListener("error", (event) => {
      if (!isCurrent()) return;
      this.log(`弹幕连接错误：${event.error?.message || event.message || "未知错误"}`);
    });
    ws.addEventListener("close", () => {
      const wasCurrent = this.ws === ws;
      if (wasCurrent) this.ws = null;
      if (!wasCurrent || !this.running || generation !== this.generation) return;
      this.state = "reconnecting";
      this.log("弹幕连接已断开");
      this.emitStatus();
      this.scheduleReconnect(generation);
    });
  }

  scheduleReconnect(generation) {
    if (!this.running || generation !== this.generation) return;
    if (this.connectTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.log(`${Math.round(delay / 1000)} 秒后重连`);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connect().catch((error) => {
        this.log(`重连失败：${error.message}`);
        this.scheduleReconnect(generation);
      });
    }, delay);
  }

  handleMessage(message) {
    const item = extractDanmaku(message);
    if (!item) return;
    this.stats.received += 1;

    const config = this.config();
    const filtered = filterDanmaku(item.text, config);
    if (filtered.action === "drop") {
      this.stats.filtered += 1;
      this.pushRecent(item, filtered.text, "filtered", filtered.reason);
      this.emitStatusSoon();
      return;
    }

    const skipReason = this.checkSkip(item, filtered.text, config);
    if (skipReason) {
      this.stats.skipped += 1;
      this.pushRecent(item, filtered.text, "skipped", skipReason);
      this.emitStatusSoon();
      return;
    }

    if (!config.autoRead) {
      this.pushRecent(item, filtered.text, "kept", filtered.reason || "仅监听");
      this.emitStatusSoon();
      return;
    }

    const pending = Math.max(0, Number(this.getPendingCount()) || 0);
    if (Number(config.maxPending) > 0 && pending >= Number(config.maxPending)) {
      this.stats.skipped += 1;
      this.pushRecent(item, filtered.text, "skipped", "等待队列已满");
      this.emitStatusSoon();
      return;
    }

    const prefix = renderSpeakTemplate(config.readPrefix, {
      user: item.name,
      uid: item.uid,
      roomId: this.roomId
    });
    const speakText = `${prefix}${filtered.text}`.trim();
    try {
      this.emit("speak", {
        text: speakText,
        rawText: item.text,
        user: item.name,
        uid: item.uid,
        roomId: this.roomId,
        source: "bilibili"
      });
      this.stats.spoken += 1;
      this.pushRecent(item, filtered.text, "spoken", filtered.reason);
    } catch (error) {
      this.stats.failed += 1;
      this.pushRecent(item, filtered.text, "error", error.message);
      this.log(`加入朗读队列失败：${error.message}`);
    }
    this.emitStatusSoon();
  }

  reportQueueError(error) {
    this.stats.failed += 1;
    this.log(`加入朗读队列失败：${error.message}`);
    this.emitStatusSoon();
  }

  checkSkip(item, text, config) {
    const now = Date.now();
    const duplicateWindow = Math.max(0, Number(config.duplicateWindowSeconds) || 0) * 1000;
    const userKey = String(item.uid || item.name);
    const textKey = `${userKey}:${text}`;

    if (duplicateWindow > 0) {
      const previous = this.seen.get(textKey);
      if (previous && now - previous < duplicateWindow) return "重复弹幕";
      this.seen.set(textKey, now);
    }

    const rateLimit = Math.max(0, Number(config.rateLimitSeconds) || 0) * 1000;
    if (rateLimit > 0) {
      const previous = this.userRate.get(userKey);
      if (previous && now - previous < rateLimit) return "发送过于频繁";
      this.userRate.set(userKey, now);
    }

    if (this.seen.size > 5000) this.pruneTimestamps(this.seen, duplicateWindow * 2);
    if (this.userRate.size > 5000) this.pruneTimestamps(this.userRate, rateLimit * 2);
    return null;
  }

  pruneTimestamps(map, maxAge) {
    const cutoff = Date.now() - Math.max(maxAge, 60000);
    for (const [key, timestamp] of map) {
      if (timestamp < cutoff) map.delete(key);
    }
  }

  pushRecent(item, text, action, reason = "") {
    this.recent.unshift({
      time: Date.now(),
      user: clampText(item.name, 30),
      text: clampText(text, 120),
      action,
      reason: clampText(reason, 30)
    });
    if (this.recent.length > MAX_RECENT) this.recent.pop();
  }

  log(message) {
    const stamp = new Date().toISOString().slice(11, 19);
    this.logs.push(`[${stamp}] ${message}`);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.emitStatusSoon();
  }

  emitStatusSoon() {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.emitStatus();
    }, 150);
    this.statusTimer.unref?.();
  }

  emitStatus() {
    this.emit("status", this.status());
  }
}
