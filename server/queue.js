import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class QueueManager extends EventEmitter {
  constructor(ttsService, audioPlayer) {
    super();
    this.ttsService = ttsService;
    this.audioPlayer = audioPlayer;
    this.queue = [];
    this.history = [];
    this.currentTask = null;
    this.isProcessing = false;
    this.maxHistory = 50;

    this.audioPlayer.onEnded((info) => {
      this.handleAudioEnded(info);
    });
  }

  enqueue(text, options = {}) {
    const config = this.ttsService.configStore.get();
    const name = options.presetName;
    if (name && name !== '_custom' && !Object.hasOwn(config.presets, name)) throw new Error('所选预设不存在，请重新选择');
    const params = structuredClone({ ...(name && name !== '_custom' ? config.presets[name] : config.activeParams), ...options.overrideParams });
    this.ttsService.buildRequestBody(text, params);
    if (this.queue.length >= 50) throw new Error('队列已满，请等待播放完成');
    const item = {
      id: randomUUID(),
      text: text.trim(),
      presetName: options.presetName || "",
      source: options.source || "manual",
      sourceUser: options.sourceUser || "",
      overrideParams: params,
      status: "pending", // pending, synthesizing, playing, completed, cancelled, error
      createdAt: Date.now(),
      startedAt: null,
      audioUrl: null,
      filePath: null,
      error: null,
      abortController: new AbortController()
    };

    this.queue.push(item);
    this.emitChange();
    this.processNext();
    return item;
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    const task = this.queue[0];
    this.currentTask = task;
    this.isProcessing = true;
    task.status = "synthesizing";
    task.startedAt = Date.now();
    this.emitChange();

    try {
      const synthRes = await this.ttsService.synthesize(
        task.text,
        task.overrideParams,
        task.abortController.signal
      );
      if (this.currentTask !== task) return;

      task.audioUrl = synthRes.url;
      task.filePath = synthRes.filePath;

      // Check if task was cancelled while synthesizing
      if (task.abortController.signal.aborted || task.status === "cancelled") {
        this.finishTask(task, "cancelled");
        this.isProcessing = false;
        this.processNext();
        return;
      }

      task.status = "playing";
      this.emitChange();
      await this.audioPlayer.play(task.filePath);
    } catch (err) {
      if (this.currentTask !== task) return;
      task.error = err.message;
      this.finishTask(task, "error");
      this.isProcessing = false;
      this.processNext();
    }
  }

  handleAudioEnded(info) {
    if (this.currentTask && this.currentTask.status === "playing") {
      this.currentTask.error = info.error || (info.code ? '播放器退出，代码 ' + info.code : null);
      this.finishTask(this.currentTask, this.currentTask.error ? 'error' : info.skipped ? 'ready' : 'completed');
    }
    this.isProcessing = false;
    this.processNext();
  }

  finishTask(task, finalStatus) {
    if (task.finishedAt) return;
    task.status = finalStatus;
    task.finishedAt = Date.now();

    // Remove from queue
    const idx = this.queue.findIndex((t) => t.id === task.id);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }

    // Add to history (remove abortController to avoid circular/unserializable fields)
    const historyItem = { ...task };
    delete historyItem.abortController;

    this.history.unshift(historyItem);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    if (this.currentTask && this.currentTask.id === task.id) {
      this.currentTask = null;
    }

    this.emitChange();
  }

  stopCurrent() {
    this.audioPlayer.stop();
    if (this.currentTask) {
      this.currentTask.abortController.abort();
      this.finishTask(this.currentTask, "cancelled");
    }
    this.isProcessing = false;
    this.processNext();
  }

  stopAndClearAll() {
    this.audioPlayer.stop();
    if (this.currentTask) {
      this.currentTask.abortController.abort();
    }

    for (const task of this.queue) {
      task.abortController.abort();
      const historyItem = { ...task, status: "cancelled", finishedAt: Date.now() };
      delete historyItem.abortController;
      this.history.unshift(historyItem);
    }
    this.queue = [];
    this.currentTask = null;
    this.isProcessing = false;
    this.emitChange();
  }

  removeQueuedItem(id) {
    if (this.currentTask?.id === id) return this.stopCurrent();
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx !== -1) {
      const [removed] = this.queue.splice(idx, 1);
      removed.abortController.abort();
      this.emitChange();
    }
  }

  getState() {
    const queueData = this.queue.map((t) => {
      const c = { ...t };
      delete c.abortController;
      return c;
    });

    return {
      currentTask: this.currentTask
        ? {
            id: this.currentTask.id,
            text: this.currentTask.text,
            status: this.currentTask.status,
            audioUrl: this.currentTask.audioUrl,
            startedAt: this.currentTask.startedAt,
            source: this.currentTask.source,
            sourceUser: this.currentTask.sourceUser
          }
        : null,
      queue: queueData,
      history: this.history,
      isPlaying: this.audioPlayer.getStatus().isPlaying
    };
  }

  emitChange() {
    this.emit("change", this.getState());
  }
}
