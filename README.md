# GPT-SoVITS Live WebUI

**English** | [简体中文](#简体中文)

A LAN companion console for [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS). Type on your phone, the voice is synthesized by your existing GPT-SoVITS API, and the audio plays on your PC, so OBS or any streaming tool can capture it. The phone needs no app, and locking it does not interrupt playback.

![Desktop preview](docs/preview-desktop.png)

## Features

- **Phone as a remote microphone**: open the LAN address in any phone browser, type or tap a phrase, and the PC speaks it.
- **Audio plays on the computer**: the server renders audio through `mpv` or `ffplay` on Linux, or PowerShell `SoundPlayer` on Windows, so playback survives the phone locking or leaving the page.
- **Works with your current setup**: talks to a running GPT-SoVITS API (default `http://127.0.0.1:9880`) and can import presets from your existing `GAG_config.json`.
- **Live queue**: tasks are synthesized and played in order, with stop-current and stop-and-clear controls plus a task history.
- **Common phrases**: a persistent phrase list that fills the composer, so wording can be adjusted before synthesizing.
- **Built-in network diagnostics**: startup checks for firewall rules that would block the phone, an `/api/diagnostics` endpoint, and per-request logs with source IPs.
- **Cross-platform**: Linux and Windows, with startup scripts for both.

## How it works

```
phone browser ──HTTP/WebSocket──▶ Fastify server (9870) ──▶ GPT-SoVITS API (9880)
                                       │
                                       └──▶ mpv / ffplay / SoundPlayer ──▶ PC speakers ──▶ OBS
```

The phone is only a controller. Synthesis and playback both happen on the PC, which keeps the audio chain stable while streaming.

## Requirements

- **Node.js 20.19+ or 22.12+** (required by Vite 8).
- A running **GPT-SoVITS API** on port 9880 (for example `gsv_api_gui.py` or `api_v2.py`).
- A local player: `mpv` is preferred on Linux, `ffplay` also works. Windows falls back to PowerShell `SoundPlayer`.
- Phone and PC on the same LAN.

## Quick start

### Linux

```bash
./start.sh
```

### Windows

Double-click `start.bat`. Run it as administrator once so it can add the inbound firewall rule automatically.

### Manual

```bash
npm install
npm run build
npm start
```

The console prints the local and LAN addresses on startup. Open the LAN address (for example `http://192.168.8.238:9870`) on your phone, or scan the QR code from the phone dialog in the UI.

## Configuration

Settings are stored in `data/config.json` and can be edited from the Settings tab:

| Setting | Description |
| --- | --- |
| API endpoint | GPT-SoVITS `/tts` endpoint, default `http://127.0.0.1:9880/tts` |
| GUI config path | Path to `GAG_config.json`, used to import voice presets |
| Reference audio and prompt text | The reference clip and its transcript sent to the API |
| Text and prompt language | `all_zh`, `zh`, `en`, `ja`, and so on |
| Text split method | `cut0` to `cut5` |
| Output device, volume, player | Which device plays the audio and how loud |

Importing presets only copies voice parameters. It does not switch the GPT or SoVITS models already loaded in your GPT-SoVITS instance.

## Troubleshooting

If the phone cannot open the page, check these in order:

1. **Firewall blocking the port.** This is the most common cause. Verify with `npm run firewall`, then:
   - Linux (ufw): `bash scripts/allow-firewall.sh`, or `sudo ufw allow from 192.168.8.0/24 to any port 9870 proto tcp`
   - Linux (firewalld): `sudo firewall-cmd --permanent --add-port=9870/tcp && sudo firewall-cmd --reload`
   - Windows: `netsh advfirewall firewall add rule name="GPT-SoVITS Live WebUI" dir=in action=allow protocol=TCP localport=9870`
   - Evidence: `journalctl -k | grep UFW` shows `[UFW BLOCK] ... DPT=9870`, or the server log contains no request from the phone IP at all.
2. **Different networks.** The phone must be on the same Wi-Fi, not mobile data and not a guest network.
3. **AP isolation.** Some guest networks block devices from talking to each other.
4. **The PC's LAN IP changed.** Use the address printed at startup or check `/api/diagnostics`.

Requests are logged with their source IP. When the phone connects you will see a line such as:

```
2026-09-11T13:02:37.463Z 192.168.8.240 POST /api/tts -> 200
```

When started through `start.sh`, the log is also written to `data/server.log`.

## API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/status` | GET | API health, LAN address, QR code, firewall state, queue |
| `/api/tts` | POST | Enqueue text: `{ "text": "...", "presetName": "..." }` |
| `/api/control/stop` | POST | Stop the current playback |
| `/api/control/clear` | POST | Stop and clear the whole queue |
| `/api/queue/:id` | DELETE | Remove one queued task |
| `/api/devices` | GET | List audio output devices |
| `/api/diagnostics` | GET | Platform, listening address, LAN URLs, firewall check |
| `/ws` | WebSocket | Live queue and config updates |

## Development

```bash
npm run dev:client   # Vite dev server for the UI
npm run dev:server   # backend on port 9870
npm run build        # build the client into client/dist
node --test test/regression.test.js
```

The backend is Fastify with a WebSocket channel, the frontend is Vue 3 with Vite, and runtime data (config, cached audio, logs) lives in `data/`, which is git-ignored.

## Notes

This tool has no authentication. It is meant for a trusted local network, so do not expose port 9870 to the internet.

## License

[MIT](LICENSE)

---

## 简体中文

[English](#gpt-sovits-live-webui) | **简体中文**

给 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 用的局域网直播配音控制台。手机负责打字，合成由你已经在跑的 GPT-SoVITS API 完成，声音从电脑本地播放，OBS 或直播软件可以直接捕获。手机不用装 App，锁屏也不影响电脑继续出声。

![界面预览](docs/preview-desktop.png)

## 功能

- **手机当遥控话筒**：手机浏览器打开局域网地址，打字或点常用语就能让电脑发声。
- **电脑本地播放**：音频由服务端调用播放器输出（Linux 优先 `mpv`，也支持 `ffplay`；Windows 兜底 PowerShell `SoundPlayer`），手机锁屏或离开页面都不影响。
- **对接现有环境**：连接你正在运行的 GPT-SoVITS API（默认 `http://127.0.0.1:9880`），可导入现有 `GAG_config.json` 里的音色预设。
- **直播队列**：按提交顺序依次合成播放，支持停止当前、停止并清空，并保留任务记录。
- **常用语**：常驻常用语列表，点击后填入输入框，可改字再合成。
- **内置排障**：启动时自动检查防火墙是否拦截手机访问，提供 `/api/diagnostics` 诊断接口和带来源 IP 的请求日志。
- **跨平台**：Linux 与 Windows 均有启动脚本。

## 工作原理

```
手机浏览器 ──HTTP/WebSocket──▶ Fastify 服务 (9870) ──▶ GPT-SoVITS API (9880)
                                     │
                                     └──▶ mpv / ffplay / SoundPlayer ──▶ 电脑扬声器 ──▶ OBS
```

手机只是控制器，合成和播放都在电脑上完成，这样直播中的音频链路才稳定。

## 环境要求

- **Node.js 20.19+ 或 22.12+**（Vite 8 的要求）。
- 已启动的 **GPT-SoVITS API**，监听 9880（例如 `gsv_api_gui.py` 或 `api_v2.py`）。
- 本地播放器：Linux 推荐 `mpv`，也支持 `ffplay`；Windows 兜底使用 PowerShell `SoundPlayer`。
- 手机和电脑在同一局域网。

## 快速开始

### Linux

```bash
./start.sh
```

### Windows

双击 `start.bat`。建议首次以管理员身份运行，脚本会自动添加防火墙入站规则。

### 手动启动

```bash
npm install
npm run build
npm start
```

启动后控制台会打印本机与局域网地址。手机打开局域网地址（例如 `http://192.168.8.238:9870`），或在界面的「手机连接」弹窗里扫码。

## 配置说明

配置保存在 `data/config.json`，也可以在「设置」页修改：

| 配置 | 说明 |
| --- | --- |
| API 地址 | GPT-SoVITS 的 `/tts` 接口，默认 `http://127.0.0.1:9880/tts` |
| GUI 配置文件路径 | `GAG_config.json` 路径，用于导入音色预设 |
| 参考音频与参考文字 | 提交给 API 的参考音频及其文本 |
| 合成语言与参考语言 | `all_zh`、`zh`、`en`、`ja` 等 |
| 文本切分方式 | `cut0` 到 `cut5` |
| 输出设备、音量、播放器 | 决定声音从哪里播出、音量多大 |

导入预设只会复制音色参数，不会切换你 GPT-SoVITS 里已经加载的 GPT / SoVITS 模型。

## 手机连不上页面时

按顺序排查，第一条最常见：

1. **防火墙拦截端口。** 先执行 `npm run firewall` 自检，然后：
   - Linux（ufw）：`bash scripts/allow-firewall.sh`，或 `sudo ufw allow from 192.168.8.0/24 to any port 9870 proto tcp`
   - Linux（firewalld）：`sudo firewall-cmd --permanent --add-port=9870/tcp && sudo firewall-cmd --reload`
   - Windows：`netsh advfirewall firewall add rule name="GPT-SoVITS Live WebUI" dir=in action=allow protocol=TCP localport=9870`
   - 判断依据：`journalctl -k | grep UFW` 出现 `[UFW BLOCK] ... DPT=9870`，或者服务日志里完全没有手机 IP 的请求。
2. **不在同一个网络。** 手机要连同一个 Wi-Fi，不能用流量，也不能是访客网络。
3. **路由器开了 AP 隔离。** 部分访客 Wi-Fi 会禁止设备互访。
4. **电脑局域网 IP 变了。** 以启动日志打印的地址为准，或访问 `/api/diagnostics` 查看。

服务日志会记录每个请求的来源 IP，手机连上后能看到类似：

```
2026-09-11T13:02:37.463Z 192.168.8.240 POST /api/tts -> 200
```

通过 `start.sh` 启动时，日志同时写入 `data/server.log`。

## 接口

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/status` | GET | API 状态、局域网地址、二维码、防火墙状态、队列 |
| `/api/tts` | POST | 提交文本：`{ "text": "...", "presetName": "..." }` |
| `/api/control/stop` | POST | 停止当前播放 |
| `/api/control/clear` | POST | 停止并清空队列 |
| `/api/queue/:id` | DELETE | 删除某条待播任务 |
| `/api/devices` | GET | 列出音频输出设备 |
| `/api/diagnostics` | GET | 平台、监听地址、局域网 URL、防火墙检查 |
| `/ws` | WebSocket | 实时推送队列与配置变化 |

## 开发

```bash
npm run dev:client   # 前端 Vite 开发服务器
npm run dev:server   # 后端，端口 9870
npm run build        # 构建前端到 client/dist
node --test test/regression.test.js
```

后端是 Fastify 加 WebSocket，前端是 Vue 3 + Vite，运行时数据（配置、音频缓存、日志）放在 `data/`，已加入 `.gitignore`。

## 说明

本工具没有鉴权，只适合可信的局域网环境，不要把 9870 端口暴露到公网。

## 协议

[MIT](LICENSE)
