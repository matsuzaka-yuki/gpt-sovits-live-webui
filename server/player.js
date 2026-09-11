import { spawn } from "node:child_process";
import os from "node:os";

export class AudioPlayer {
  constructor(configStore) {
    this.configStore = configStore;
    this.currentProcess = null;
    this.isPlaying = false;
    this.onEndedCallback = null;
    this.currentFile = null;
    this.isWindows = os.platform() === "win32";
  }

  onEnded(cb) {
    this.onEndedCallback = cb;
  }

  async getDevices() {
    return new Promise((resolve) => {
      const p = spawn("mpv", ["--audio-device=help"]);
      let output = "";
      p.stdout.on("data", (d) => (output += d.toString()));
      p.stderr.on("data", (d) => (output += d.toString()));
      p.on("close", () => {
        const lines = output.split("\n");
        const list = [{ id: "auto", name: "系统默认输出 (Default)" }];
        for (const line of lines) {
          const match = line.match(/^\s*'([^']+)'\s+\((.*)\)$/);
          if (match) {
            const [, id, desc] = match;
            if (id !== "auto") {
              list.push({ id, name: desc || id });
            }
          }
        }
        resolve(list);
      });
      p.on("error", () => {
        resolve([{ id: "auto", name: "系统默认输出 (Default)" }]);
      });
    });
  }

  async play(filePath) {
    this.stop();

    const config = this.configStore.get();
    if (!config.autoPlayOnComputer) {
      if (this.onEndedCallback) setTimeout(() => this.onEndedCallback({ skipped: true }), 100);
      return;
    }

    this.isPlaying = true;
    this.currentFile = filePath;

    const volume = Math.min(150, Math.max(0, config.volume ?? 100));
    const device = config.audioDevice || "auto";

    const tryMpv = () => {
      const args = [
        "--no-video",
        "--no-terminal",
        "--really-quiet",
        `--volume=${volume}`,
        filePath
      ];
      if (device && device !== "auto") {
        args.push(`--audio-device=${device}`);
      }
      return spawn("mpv", args);
    };

    const tryFfplay = () => {
      const args = [
        "-nodisp",
        "-autoexit",
        "-loglevel", "quiet",
        "-volume", String(volume),
        filePath
      ];
      return spawn("ffplay", args);
    };

    const tryWindowsPowerShell = () => {
      const psCmd = '$ErrorActionPreference="Stop"; $p=New-Object System.Media.SoundPlayer; $p.SoundLocation=$env:SOVITS_AUDIO_FILE; $p.PlaySync()';
      return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { windowsHide: true, env: { ...process.env, SOVITS_AUDIO_FILE: filePath } });
    };

    const tryLinuxAplay = () => {
      return spawn("aplay", ["-q", filePath]);
    };

    let proc = null;
    const backend = config.playbackBackend || "auto";

    if (backend === "mpv") {
      proc = tryMpv();
      this.setupProcessHandlers(proc);
    } else if (backend === "ffplay") {
      proc = tryFfplay();
      this.setupProcessHandlers(proc);
    } else {
      proc = tryMpv();
      proc.on("error", (err) => {
        console.warn("mpv failed, trying ffplay fallback:", err.message);
        proc = tryFfplay();
        proc.on("error", () => {
          if (this.isWindows) {
            proc = tryWindowsPowerShell();
            this.setupProcessHandlers(proc);
          } else {
            proc = tryLinuxAplay();
            this.setupProcessHandlers(proc);
          }
        });
        this.setupProcessHandlers(proc);
      });
      this.setupProcessHandlers(proc);
    }
  }

  setupProcessHandlers(proc) {
    this.currentProcess = proc;
    proc.on("close", (code) => {
      if (this.currentProcess === proc) {
        this.isPlaying = false;
        this.currentProcess = null;
        if (this.onEndedCallback) {
          this.onEndedCallback({ code, file: this.currentFile });
        }
      }
    });
    proc.on("error", (err) => {
      if (this.currentProcess === proc) {
        console.error("Playback process error:", err.message);
        this.isPlaying = false;
        this.currentProcess = null;
        if (this.onEndedCallback) {
          this.onEndedCallback({ error: err.message, file: this.currentFile });
        }
      }
    });
  }

  stop() {
    if (this.currentProcess) {
      try {
        if (this.isWindows) {
          spawn("taskkill", ["/pid", String(this.currentProcess.pid), "/f", "/t"]);
        } else {
          this.currentProcess.kill("SIGKILL");
        }
      } catch (err) {}
      this.currentProcess = null;
    }
    this.isPlaying = false;
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      currentFile: this.currentFile
    };
  }
}
