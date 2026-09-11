import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const workerPath = fileURLToPath(new URL('./inference_worker.py', import.meta.url));
const runtimeConfigPath = fileURLToPath(new URL('../data/local-inference.yaml', import.meta.url));

export class LocalInference {
  constructor(configStore, spawnProcess = spawn) {
    this.configStore = configStore;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.state = 'stopped';
    this.logs = '';
    this.error = '';
    this.generation = 0;
    this.stopping = Promise.resolve();
  }

  status() { return { state: this.state, error: this.error, logs: this.logs, device: this.device || '' }; }

  async start() {
    await this.stopping;
    if (this.starting) return this.starting;
    if (this.state === 'ready') return;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = null; }
  }

  async launch() {
    const generation = this.generation;
    const settings = structuredClone(this.configStore.get().localInference);
    this.state = 'loading'; this.error = ''; this.logs = '';
    try {
      if (!settings.rootPath.trim()) throw new Error('请先设置 GPT-SoVITS 目录和 Python 路径');
      settings.rootPath = path.resolve(settings.rootPath);
      await fs.access(path.join(settings.rootPath, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py'));
      await fs.mkdir(path.dirname(runtimeConfigPath), { recursive: true });
      if (generation !== this.generation) throw new Error('模型加载已取消');
      settings.runtimeConfigPath = runtimeConfigPath;
      await new Promise((resolve, reject) => {
        const child = this.spawnProcess(settings.pythonPath, ['-u', workerPath], {
          cwd: settings.rootPath, windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe']
        });
        this.child = child;
        const timer = setTimeout(() => { this.stop('本地模型加载超时'); }, settings.timeoutSeconds * 1000);
        this.rejectStart = reject;
        const lines = createInterface({ input: child.stdout });
        child.stderr.on('data', data => { this.logs = (this.logs + data.toString()).slice(-16000); });
        child.stdin.on('error', () => {});
        lines.on('line', line => {
          let message;
          try { message = JSON.parse(line); } catch { return; }
          if (message.ready) {
            clearTimeout(timer); this.rejectStart = null;
            this.state = 'ready'; this.device = message.device; resolve();
          } else if (message.fatal) {
            this.stop(message.fatal);
          } else {
            const pending = this.pending.get(message.id);
            if (pending) {
              this.pending.delete(message.id);
              message.error ? pending.reject(new Error(message.error)) : pending.resolve();
            }
          }
        });
        const ended = message => {
          clearTimeout(timer); lines.close();
          if (this.child !== child) return;
          this.child = null;
          this.state = 'error'; this.error = message;
          reject(new Error(message)); this.rejectStart = null;
          for (const pending of this.pending.values()) pending.reject(new Error(message));
          this.pending.clear();
        };
        child.once('error', error => ended(error.message));
        child.once('exit', (code, signal) => ended(`本地推理进程退出 (${code ?? signal})，请查看日志`));
        child.stdin.write(JSON.stringify(settings) + '\n');
      });
    } catch (error) {
      this.state = 'error'; this.error = error.message;
      throw error;
    }
  }

  stop(reason = '') {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.state = reason ? 'error' : 'stopped'; this.error = reason;
    const error = new Error(reason || '本地推理已停止');
    this.rejectStart?.(error); this.rejectStart = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      this.stopping = new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.once('error', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    return this.stopping;
  }

  async synthesize(params, output, signal) {
    const abort = () => { this.stop('任务已取消，模型将在下次合成时重新加载'); };
    if (signal?.aborted) throw new Error('任务已取消');
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      await this.start();
      if (signal?.aborted) throw new Error('任务已取消');
      if (this.pending.size) throw new Error('本地推理忙，请稍后重试');
      await new Promise((resolve, reject) => {
        const id = randomUUID();
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => this.stop('本地合成超时'), this.configStore.get().localInference.timeoutSeconds * 1000);
        this.child.stdin.write(JSON.stringify({ id, params, output }) + '\n', error => {
          if (error) { this.pending.delete(id); reject(error); }
        });
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
