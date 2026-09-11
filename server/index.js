import path from "node:path";
import fsSync from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import QRCode from "qrcode";

import { ConfigStore } from "./config.js";
import { AudioPlayer } from "./player.js";
import { TtsService } from "./tts.js";
import { QueueManager } from "./queue.js";
import { BilibiliDanmakuReader } from "./bilibili.js";
import { checkPortAccess, formatWarning } from "./firewall.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const clientDist = path.join(projectRoot, "client", "dist");
const audioCacheDir = path.join(projectRoot, "data", "audio_cache");

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    // 跳过 Docker / 虚拟网桥，这些地址手机无法访问
    if (/^(docker|br-|veth|virbr|vmnet)/.test(name)) continue;
    for (const iface of interfaces[name]) {
      // IPv4 and non-internal
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

export async function createServer() {
  const configStore = new ConfigStore();
  await configStore.load();

  const audioPlayer = new AudioPlayer(configStore);
  const ttsService = new TtsService(configStore);
  const queueManager = new QueueManager(ttsService, audioPlayer);
  const bilibili = new BilibiliDanmakuReader(configStore, {
    getPendingCount: () => queueManager.queue.length
  });
  bilibili.on("speak", (payload) => {
    try {
      queueManager.enqueue(payload.text, {
        source: payload.source,
        sourceUser: payload.user
      });
    } catch (error) {
      bilibili.reportQueueError(error);
    }
  });

  const fastify = Fastify({
    logger: false
  });
  fastify.setErrorHandler((error, req, reply) => reply.code(error.statusCode || 400).send({ success: false, message: error.message }));

  // 访问日志：手机连不上时，看这里有没有对应 IP 的请求
  fastify.addHook("onResponse", (req, reply, done) => {
    const url = req.raw.url || "";
    const noisy = url.startsWith("/assets/") || url.startsWith("/api/audio/") || url === "/favicon.ico";
    if (!noisy) {
      console.log(`${new Date().toISOString()} ${req.ip} ${req.method} ${url} -> ${reply.statusCode}`);
    }
    done();
  });

  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyWebsocket);

  // Serve generated audio
  if (!fsSync.existsSync(audioCacheDir)) {
    fsSync.mkdirSync(audioCacheDir, { recursive: true });
  }
  await fastify.register(fastifyStatic, {
    root: audioCacheDir,
    prefix: "/api/audio/",
    decorateReply: false
  });

  // Track connected WS clients
  const wsClients = new Set();
  fastify.register(async function (fastifyInstance) {
    fastifyInstance.get("/ws", { websocket: true }, (socket, req) => {
      wsClients.add(socket);
      // Send current state immediately
      socket.send(JSON.stringify({
        type: "state",
        data: queueManager.getState(),
        config: configStore.get(),
        bilibili: bilibili.status()
      }));

      socket.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.action === "synth") {
            queueManager.enqueue(msg.text, {
              presetName: msg.presetName,
              overrideParams: msg.params
            });
          } else if (msg.action === "stop") {
            queueManager.stopCurrent();
          } else if (msg.action === "clear") {
            queueManager.stopAndClearAll();
          }
        } catch (e) {}
      });

      socket.on("close", () => {
        wsClients.delete(socket);
      });
    });
  });

  const broadcast = (payload) => {
    const data = JSON.stringify(payload);
    for (const client of wsClients) {
      if (client.readyState === 1) { // OPEN
        client.send(data);
      }
    }
  };

  bilibili.on("status", (data) => {
    broadcast({ type: "bilibili", data });
  });

  queueManager.on("change", (state) => {
    broadcast({ type: "state", data: state });
  });

  // REST APIs
  fastify.get("/api/status", async () => {
    const apiStatus = await ttsService.checkApiStatus();
    const config = configStore.get();
    const localIps = getLocalIpAddresses();
    const primaryIp = localIps[0] || "127.0.0.1";
    const accessUrl = `http://${primaryIp}:${config.port}`;
    const qrDataUrl = await QRCode.toDataURL(accessUrl, { width: 250, margin: 2 }).catch(() => "");
    const firewall = checkPortAccess(Number(process.env.PORT || config.port || 9870));

    return {
      success: true,
      inference: { mode: config.inferenceMode, ...ttsService.local.status() },
      apiConnected: apiStatus.ok,
      apiDetails: apiStatus,
      localIps,
      accessUrl,
      qrDataUrl,
      firewall,
      config,
      bilibili: bilibili.status(),
      state: queueManager.getState()
    };
  });

  fastify.get("/api/config", async () => {
    return { success: true, config: configStore.get() };
  });

  fastify.get("/api/diagnostics", async () => {
    const config = configStore.get();
    const port = Number(process.env.PORT || config.port || 9870);
    const host = process.env.HOST || config.host || "0.0.0.0";
    const localIps = getLocalIpAddresses();
    return {
      success: true,
      platform: process.platform,
      node: process.version,
      listen: { host, port },
      localIps,
      accessUrls: localIps.map(ip => `http://${ip}:${port}`),
      firewall: checkPortAccess(port),
      note: "手机端请求会带来源 IP 记录在本服务的启动日志里；data/server.log 是启动脚本保存的日志文件。"
    };
  });

  fastify.post("/api/config", async (req) => {
    const patch = req.body || {};
    const before = configStore.get();
    const inferenceChanged = (patch.inferenceMode !== undefined && patch.inferenceMode !== before.inferenceMode) ||
      (patch.localInference && JSON.stringify({ ...before.localInference, ...patch.localInference }) !== JSON.stringify(before.localInference)) ||
      (patch.apiEndpoint !== undefined && patch.apiEndpoint !== before.apiEndpoint);
    if (inferenceChanged && queueManager.queue.length) throw new Error('请先停止并清空队列，再修改推理设置');
    const updated = await configStore.update(patch);
    if (inferenceChanged) await ttsService.local.stop();
    if (updated.inferenceMode === 'local' && updated.localInference.autoStart && inferenceChanged) ttsService.local.start().catch(console.error);
    bilibili.applyConfig();
    broadcast({ type: "config", config: updated });
    return { success: true, config: updated };
  });

  fastify.get("/api/bilibili/status", async () => {
    return { success: true, bilibili: bilibili.status() };
  });

  fastify.post("/api/bilibili/start", async () => {
    const updated = await configStore.update({ bilibili: { enabled: true } });
    bilibili.applyConfig();
    broadcast({ type: "config", config: updated });
    return { success: true, bilibili: bilibili.status() };
  });

  fastify.post("/api/bilibili/stop", async () => {
    const updated = await configStore.update({ bilibili: { enabled: false } });
    bilibili.applyConfig();
    broadcast({ type: "config", config: updated });
    return { success: true, bilibili: bilibili.status() };
  });

  fastify.post("/api/config/import-gag", async (req) => {
    if (queueManager.queue.length) throw new Error('请先停止并清空队列，再导入配置');
    const { path: gagPath } = req.body || {};
    const ok = await configStore.importGagConfig(gagPath);
    if (!ok) {
      return { success: false, message: "无法读取或解析 GAG_config.json 配置文件" };
    }
    const updated = configStore.get();
    broadcast({ type: "config", config: updated });
    return { success: true, config: updated };
  });

  fastify.get("/api/devices", async () => {
    const devices = await audioPlayer.getDevices();
    return { success: true, devices };
  });

  fastify.post('/api/inference/start', async () => {
    if (configStore.get().inferenceMode !== 'local') throw new Error('当前是外部 API 模式');
    if (ttsService.local.state !== 'loading') ttsService.local.start().catch(console.error);
    return { success: true, inference: ttsService.local.status() };
  });
  fastify.post('/api/inference/stop', async () => {
    queueManager.stopAndClearAll();
    await ttsService.local.stop();
    return { success: true, inference: ttsService.local.status() };
  });

  fastify.post("/api/tts", async (req, reply) => {
    const { text, presetName, params } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ success: false, message: "合成文本不能为空" });
    }
    const task = queueManager.enqueue(text, { presetName, overrideParams: params });
    return { success: true, taskId: task.id };
  });

  fastify.post("/api/control/stop", async () => {
    queueManager.stopCurrent();
    return { success: true };
  });

  fastify.post("/api/control/clear", async () => {
    queueManager.stopAndClearAll();
    return { success: true };
  });

  fastify.delete("/api/queue/:id", async (req) => {
    queueManager.removeQueuedItem(req.params.id);
    return { success: true };
  });

  // Serve static client bundle if it exists
  if (fsSync.existsSync(clientDist)) {
    await fastify.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
      decorateReply: true
    });
    // SPA fallback
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ success: false, message: '接口不存在' });
      reply.sendFile("index.html", clientDist);
    });
  }

  fastify.addHook('onClose', async () => {
    bilibili.stop();
    queueManager.stopAndClearAll();
    await ttsService.local.stop();
    for (const socket of wsClients) socket.close();
  });
  if (configStore.get().inferenceMode === 'local' && configStore.get().localInference.autoStart) ttsService.local.start().catch(console.error);
  bilibili.applyConfig();
  return { fastify, configStore, queueManager };
}

// Direct start
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { fastify, configStore } = await createServer();
  const config = configStore.get();
  const port = Number(process.env.PORT || config.port || 9870);
  const host = process.env.HOST || config.host || "0.0.0.0";

  await fastify.listen({ port, host });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fastify.close(); process.exit(0); });
  const ips = getLocalIpAddresses();
  console.log(`
[GPT-SoVITS 直播辅助 WebUI 已启动]`);
  console.log(`电脑本机访问: http://127.0.0.1:${port}`);
  ips.forEach(ip => {
    console.log(`手机局域网访问: http://${ip}:${port}`);
  });
  const firewall = checkPortAccess(port);
  if (!firewall.ok) {
    console.log("");
    formatWarning(firewall, port).forEach(line => console.log(line));
  }
  console.log("");
}
