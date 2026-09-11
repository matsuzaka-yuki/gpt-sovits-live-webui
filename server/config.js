import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'data', 'config.json');

const DEFAULT_CONFIG = {
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
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  async load() {
    try {
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
      console.warn('Failed to load config, using default:', err.message);
    }
    return this.config;
  }

  async save() {
    try {
      await fs.writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save config:', err.message);
      throw err;
    }
  }

  get() {
    return this.config;
  }

  async update(patch) {
    if (patch.activeParams) {
      this.config.activeParams = { ...this.config.activeParams, ...patch.activeParams };
      delete patch.activeParams;
    }
    this.config = { ...this.config, ...patch };
    await this.save();
    return this.config;
  }

  async importGagConfig(filepath, silent = false) {
    try {
      const p = filepath || this.config.gagConfigPath;
      if (!fsSync.existsSync(p)) return false;
      const raw = await fs.readFile(p, 'utf8');
      const gag = JSON.parse(raw);
      if (!gag.presets || typeof gag.presets !== 'object' || Array.isArray(gag.presets)) throw new Error('配置没有预设');
      this.config.gagConfigPath = p;
      if (gag.api_url) {
        this.config.apiBaseUrl = gag.api_url;
        this.config.apiEndpoint = `${gag.api_url.replace(/\/+$/, '')}/tts`;
      }
      if (gag.presets && typeof gag.presets === 'object') {
        this.config.presets = { ...this.config.presets, ...gag.presets };
        if (gag.current_preset && gag.presets[gag.current_preset]) {
          this.config.currentPresetName = gag.current_preset;
          const pset = gag.presets[gag.current_preset];
          this.config.activeParams = {
            ...this.config.activeParams,
            ...pset
          };
        }
      }
      if (!silent) {
        await this.save();
      }
      return true;
    } catch (err) {
      if (!silent) console.error('Failed to import GAG_config:', err.message);
      return false;
    }
  }
}
