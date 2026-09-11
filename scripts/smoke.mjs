// End-to-end smoke test: boots the real server and checks the HTTP surface.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function isFreePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickPort(start = 9879) {
  for (let port = start; port < start + 40; port += 1) {
    if (await isFreePort(port)) return port;
  }
  throw new Error("no free port found for the smoke test");
}

async function waitForServer(baseUrl, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return true;
    } catch {
      // server not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const port = await pickPort();
const baseUrl = `http://127.0.0.1:${port}`;
let serverOutput = "";

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: projectRoot,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

let exitCode = 0;
try {
  const ready = await waitForServer(baseUrl);
  check("server starts and answers /api/status", ready, serverOutput.trim().split("\n").slice(-3).join(" | "));

  if (ready) {
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    check("serves the client bundle", page.status === 200 && html.includes('id="app"'), `status ${page.status}`);

    const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    check("index.html references a built asset", Boolean(assetPath));
    if (assetPath) {
      const asset = await fetch(`${baseUrl}${assetPath}`);
      check("built asset is served", asset.status === 200, `${assetPath} -> ${asset.status}`);
    }

    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    check("status reports success", status.success === true);
    check("status exposes an access url", typeof status.accessUrl === "string" && status.accessUrl.startsWith("http://"));
    check("status includes firewall diagnostics", status.firewall && typeof status.firewall.ok === "boolean");
    check("status includes the queue state", status.state && Array.isArray(status.state.queue));
    check("status includes bilibili danmaku state", status.bilibili && typeof status.bilibili.state === "string");

    const diagnostics = await (await fetch(`${baseUrl}/api/diagnostics`)).json();
    check("diagnostics reports the listening port", diagnostics.listen?.port === port, JSON.stringify(diagnostics.listen));

    const missing = await fetch(`${baseUrl}/api/does-not-exist`);
    const missingBody = await missing.json().catch(() => ({}));
    check("unknown api route returns json 404", missing.status === 404 && missingBody.success === false);

    const emptyText = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " })
    });
    check("rejects empty synthesis text", emptyText.status >= 400);

    if (typeof WebSocket === "function") {
      const wsResult = await new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => { socket.close(); resolve(false); }, 8000);
        socket.onmessage = (event) => {
          clearTimeout(timer);
          socket.close();
          resolve(Boolean(event.data));
        };
        socket.onerror = () => { clearTimeout(timer); resolve(false); };
      });
      check("websocket pushes initial state", wsResult);
    } else {
      console.log("  skip websocket check (no global WebSocket in this Node version)");
    }
  }

  if (failures.length) exitCode = 1;
} catch (error) {
  console.error(`smoke test crashed: ${error.message}`);
  exitCode = 1;
} finally {
  child.kill();
}

if (exitCode === 0) {
  console.log(`\nsmoke test passed on port ${port}`);
} else {
  console.error(`\nsmoke test failed: ${failures.join(", ")}`);
}
process.exit(exitCode);
