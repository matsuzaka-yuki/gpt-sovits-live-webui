import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'data', 'config.json');

const DEFAULT_CONFIG = {
  inferenceMode: 'local',
  localInference: {
    pythonPath: process.platform === 'win32' ? 'python' : 'python3',
    rootPath: '',
    configPath: 'GPT_SoVITS/configs/tts_infer.yaml',
    gptWeights: '',
    sovitsWeights: '',
    device: 'auto',
    precision: 'auto',
    autoStart: false,
    timeoutSeconds: 300
  },
  bilibili: {
    enabled: false,
    roomId: 0,
    autoRead: true,
    cookie: '',
    minLength: 1,
    maxLength: 100,
    rateLimitSeconds: 3,
    duplicateWindowSeconds: 60,
    maxPending: 12,
    skipCommands: true,
    stripUrls: true,
    stripEmoticons: true,
    filterMode: 'mask',
    bannedWords: [],
    replacement: '*',
    readPrefix: ''
  },
  port: 9870,
  host: '0.0.0.0',
  apiEndpoint: 'http://127.0.0.1:9880/tts',
  apiBaseUrl: 'http://127.0.0.1:9880',
  playbackBackend: 'auto', // 'auto', 'mpv', 'ffplay', 'powershell', 'browser_only'
  audioDevice: 'auto',
  volume: 100, // 0 - 150
  autoPlayOnComputer: true,
  gagConfigPath: '',
  currentPresetName: '默认预设',
  activeParams: {
    ref_audio_path: '',
    prompt_text: '',
    prompt_lang: 'zh',
    text_lang: 'zh',
    speed_factor: 1.0,
    top_k: 5,
    top_p: 1.0,
    temperature: 1.0,
    text_split_method: 'cut5',
    batch_size: 1,
    batch_threshold: 0.75,
    split_bucket: true,
    return_fragment: false,
    streaming_mode: false,
    seed: -1,
    parallel_infer: true,
    repetition_penalty: 1.35
  },
  presets: {},
  quickTexts: [
    '感谢老板的舰长！十分感谢支持！',
    '欢迎来到直播间，喜欢主播的点个关注哦！',
    '今天我们来玩点不一样的。',
    '大家有什么想聊的尽管在弹幕发出来！'
  ]
};

export class ConfigStore {
  constructor(filepath = configPath) {
    this.path = filepath;
    this.config = structuredClone(DEFAULT_CONFIG);
    this.writes = Promise.resolve();
  }

  async load() {
    try {
      const configPath = this.path;
      const dataDir = path.dirname(configPath);
      if (!fsSync.existsSync(dataDir)) {
        await fs.mkdir(dataDir, { recursive: true });
      }
      if (fsSync.existsSync(configPath)) {
        const raw = await fs.readFile(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.config = {
          ...DEFAULT_CONFIG,
          ...parsed,
          inferenceMode: parsed.inferenceMode || 'external',
          localInference: { ...DEFAULT_CONFIG.localInference, ...(parsed.localInference || {}) },
          bilibili: { ...DEFAULT_CONFIG.bilibili, ...(parsed.bilibili || {}) },
          activeParams: { ...DEFAULT_CONFIG.activeParams, ...(parsed.activeParams || {}) }
        };
      } else {
        // Try to load initial defaults from GAG_config.json if available
        await this.importGagConfig(DEFAULT_CONFIG.gagConfigPath, true);
        await this.save();
      }
      // Older releases picked the GUI source directory, not its working directory.
      if (!this.config.activeParams.ref_audio_path && this.config.gagConfigPath) {
        const candidate = path.resolve(path.dirname(this.config.gagConfigPath), '..', 'GAG_config.json');
        try {
          const gag = JSON.parse(await fs.readFile(candidate, 'utf8'));
          if (gag.presets?.[gag.current_preset]?.ref_audio_path) await this.importGagConfig(candidate);
        } catch {}
      }
    } catch (err) {
      throw new Error(`无法读取配置 ${this.path}：${err.message}。请修复或备份后移走该文件。`);
    }
    return this.config;
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      await fs.writeFile(`${this.path}.tmp`, JSON.stringify(this.config, null, 2), 'utf8');
      await fs.rename(`${this.path}.tmp`, this.path);
    } catch (err) {
      console.error('Failed to save config:', err.message);
      throw err;
    }
  }

  get() {
    return this.config;
  }

  async update(patch) {
    const operation = this.writes.catch(() => {}).then(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('配置必须是对象');
      const next = { ...this.config, ...patch,
        activeParams: { ...this.config.activeParams, ...patch.activeParams },
        localInference: { ...this.config.localInference, ...patch.localInference },
        bilibili: { ...this.config.bilibili, ...patch.bilibili } };
      if (!['local', 'external'].includes(next.inferenceMode)) throw new Error('无效的推理模式');
      const local = next.localInference;
      for (const key of ['pythonPath', 'rootPath', 'configPath', 'gptWeights', 'sovitsWeights']) {
        if (typeof local[key] !== 'string' || local[key].includes('\0')) throw new Error(`无效的本地配置：${key}`);
      }
      if (!['auto', 'cpu', 'cuda', 'cuda:0', 'cuda:1', 'mps'].includes(local.device)) throw new Error('无效的推理设备');
      if (!['auto', 'full', 'half'].includes(local.precision)) throw new Error('无效的精度');
      if (typeof local.autoStart !== 'boolean' || !Number.isInteger(local.timeoutSeconds) || local.timeoutSeconds < 10 || local.timeoutSeconds > 1800) throw new Error('加载/合成超时必须为 10–1800 秒');
      const bilibili = next.bilibili;
      if (typeof bilibili.enabled !== 'boolean' || typeof bilibili.autoRead !== 'boolean') throw new Error('无效的弹幕开关');
      if (!Number.isInteger(bilibili.roomId) || bilibili.roomId < 0 || bilibili.roomId > 999999999999) throw new Error('B站房间号必须是正整数');
      if (bilibili.enabled && bilibili.roomId <= 0) throw new Error('启用弹幕监听前请填写有效的 B站房间号');
      if (typeof bilibili.cookie !== 'string' || bilibili.cookie.length > 20000 || bilibili.cookie.includes('\0')) throw new Error('无效的 B站 Cookie');
      if (!['mask', 'drop'].includes(bilibili.filterMode)) throw new Error('无效的违禁词过滤方式');
      if (!Array.isArray(bilibili.bannedWords) || bilibili.bannedWords.length > 500) throw new Error('违禁词最多 500 个');
      for (const word of bilibili.bannedWords) {
        if (typeof word !== 'string' || word.length > 64 || word.includes('\0')) throw new Error('违禁词格式不正确');
      }
      if (typeof bilibili.replacement !== 'string' || bilibili.replacement.length > 12) throw new Error('违禁词替换内容过长');
      if (typeof bilibili.readPrefix !== 'string' || bilibili.readPrefix.length > 80) throw new Error('朗读前缀过长');
      if (!Number.isInteger(bilibili.minLength) || bilibili.minLength < 1 || bilibili.minLength > 100) throw new Error('弹幕最短字数必须为 1–100');
      if (!Number.isInteger(bilibili.maxLength) || bilibili.maxLength < 1 || bilibili.maxLength > 500 || bilibili.maxLength < bilibili.minLength) throw new Error('弹幕最长字数必须不小于最短字数，且不超过 500');
      if (!Number.isFinite(bilibili.rateLimitSeconds) || bilibili.rateLimitSeconds < 0 || bilibili.rateLimitSeconds > 3600) throw new Error('同一用户发送间隔必须为 0–3600 秒');
      if (!Number.isFinite(bilibili.duplicateWindowSeconds) || bilibili.duplicateWindowSeconds < 0 || bilibili.duplicateWindowSeconds > 3600) throw new Error('重复弹幕窗口必须为 0–3600 秒');
      if (!Number.isInteger(bilibili.maxPending) || bilibili.maxPending < 0 || bilibili.maxPending > 100) throw new Error('弹幕等待队列上限必须为 0–100 条');
      if (typeof bilibili.skipCommands !== 'boolean' || typeof bilibili.stripUrls !== 'boolean' || typeof bilibili.stripEmoticons !== 'boolean') throw new Error('无效的弹幕过滤选项');
      let url;
      try { url = new URL(next.apiEndpoint); } catch { throw new Error('API 地址格式不正确'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS');
      if (!Array.isArray(next.quickTexts) || next.quickTexts.some(x => typeof x !== 'string') || !next.presets || typeof next.presets !== 'object' || Array.isArray(next.presets)) throw new Error('无效的常用语或音色预设');
      const previous = this.config;
      this.config = next;
      try { await this.save(); } catch (error) { this.config = previous; throw error; }
      return this.config;
    });
    this.writes = operation;
    return operation;
  }

  async importGagConfig(filepath, silent = false) {
    try {
      const p = filepath || this.config.gagConfigPath;
      if (!fsSync.existsSync(p)) return false;
      const raw = await fs.readFile(p, 'utf8');
      const gag = JSON.parse(raw);
      if (!gag.presets || typeof gag.presets !== 'object' || Array.isArray(gag.presets)) throw new Error('配置没有预设');
      const patch = { gagConfigPath: p };
      if (gag.api_url) {
        patch.apiBaseUrl = gag.api_url;
        patch.apiEndpoint = `${gag.api_url.replace(/\/+$/, '')}/tts`;
      }
      if (gag.presets && typeof gag.presets === 'object') {
        patch.presets = { ...this.config.presets, ...gag.presets };
        if (gag.current_preset && gag.presets[gag.current_preset]) {
          patch.currentPresetName = gag.current_preset;
          const pset = gag.presets[gag.current_preset];
          patch.activeParams = {
            ...this.config.activeParams,
            ...pset
          };
        }
      }
      await this.update(patch);
      return true;
    } catch (err) {
      if (!silent) console.error('Failed to import GAG_config:', err.message);
      return false;
    }
  }
}
