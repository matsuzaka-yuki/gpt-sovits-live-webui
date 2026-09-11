import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const audioCacheDir = path.resolve(__dirname, "..", "data", "audio_cache");

export class TtsService {
  constructor(configStore) {
    this.configStore = configStore;
    this.ensureDir();
  }

  async ensureDir() {
    if (!fsSync.existsSync(audioCacheDir)) {
      await fs.mkdir(audioCacheDir, { recursive: true });
    }
  }

  buildRequestBody(text, overrideParams = {}) {
    const config = this.configStore.get();
    const params = {
      ...config.activeParams,
      ...overrideParams
    };
    if (typeof text !== 'string' || !text.trim() || text.length > 3000) throw new Error('请输入 1–3000 字的文本');
    if (!params.ref_audio_path?.trim()) throw new Error('当前音色缺少参考音频，请在设置中导入有效的 GUI 预设或填写参考音频路径。');

    return {
      text: text.trim(),
      text_lang: params.text_lang || "zh",
      ref_audio_path: params.ref_audio_path || "",
      aux_ref_audio_paths: params.aux_ref_audio_paths || [],
      prompt_text: params.no_prompt ? '' : (params.prompt_text || ""),
      prompt_lang: params.prompt_lang || "zh",
      top_k: Number(params.top_k ?? 5),
      top_p: Number(params.top_p ?? 1.0),
      temperature: Number(params.temperature ?? 1.0),
      text_split_method: params.text_split_method || "cut5",
      batch_size: Number(params.batch_size ?? 1),
      batch_threshold: Number(params.batch_threshold ?? 0.75),
      split_bucket: Boolean(params.split_bucket ?? true),
      speed_factor: Number(params.speed_factor ?? 1.0),
      streaming_mode: false,
      seed: Number(params.seed ?? -1),
      parallel_infer: Boolean(params.parallel_infer ?? true),
      repetition_penalty: Number(params.repetition_penalty ?? 1.35),
      sample_steps: Number(params.sample_steps ?? 32),
      super_sampling: Boolean(params.super_sampling ?? false),
      media_type: "wav",
      return_fragment: false
    };
  }

  async synthesize(text, overrideParams = {}, signal = null) {
    if (!text || !text.trim()) {
      throw new Error("合成文本不能为空");
    }

    const config = this.configStore.get();
    const endpoint = config.apiEndpoint || "http://127.0.0.1:9880/tts";
    const body = this.buildRequestBody(text, overrideParams);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2min timeout

    let abortListener = null;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw new Error("任务已取消");
      }
      abortListener = () => controller.abort();
      signal.addEventListener("abort", abortListener);
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "audio/wav"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        let errDetail = "";
        try {
          const raw = await response.text();
          let errJson;
          try { errJson = JSON.parse(raw); } catch { errJson = { message: raw }; }
          errDetail = errJson.message || JSON.stringify(errJson);
        } catch (e) {
          errDetail = await response.text().catch(() => "");
        }
        throw new Error(`GPT-SoVITS API 返回错误 (${response.status}): ${errDetail || "请检查模型与参考音频"}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error("接口未返回标准 WAV 音频格式，请检查 API 设置");
      }

      const id = randomUUID();
      const filename = `tts_${Date.now()}_${id.slice(0, 8)}.wav`;
      const filePath = path.join(audioCacheDir, filename);
      await fs.writeFile(filePath, buffer);

      return {
        id,
        filename,
        filePath,
        url: `/api/audio/${filename}`,
        size: buffer.length,
        text
      };
    } finally {
      clearTimeout(timeout);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  async checkApiStatus() {
    const config = this.configStore.get();
    const base = new URL(config.apiEndpoint).origin;
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/openapi.json`, {
        signal: AbortSignal.timeout(3000)
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}
