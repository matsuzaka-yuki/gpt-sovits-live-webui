// Builds a runnable release bundle: app files + prebuilt client + production node_modules.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

const platform = process.argv[2] || `${process.platform}-${process.arch}`;
const skipSmoke = process.argv.includes("--no-smoke");
const bundleName = `gpt-sovits-live-webui-v${pkg.version}-${platform}`;
const releaseDir = path.join(projectRoot, "release");
const stagingDir = path.join(releaseDir, bundleName);

const includes = [
  "package.json",
  "package-lock.json",
  "LICENSE",
  "README.md",
  "server",
  "scripts",
  "client/dist",
  "docs",
  "start.sh",
  "start.bat",
  "stop.sh",
  "node_modules"
];

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(projectRoot, "client", "dist", "index.html"))) {
  fail("client/dist is missing. Run `npm run build` first.");
}

if (!fs.existsSync(path.join(projectRoot, "node_modules", "fastify"))) {
  fail("node_modules is missing. Run `npm install` first.");
}

fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

for (const entry of includes) {
  const source = path.join(projectRoot, entry);
  if (!fs.existsSync(source)) {
    fail(`expected file is missing: ${entry}`);
  }
  fs.cpSync(source, path.join(stagingDir, entry), { recursive: true });
}

if (!skipSmoke) {
  console.log("[package] running smoke test inside the bundle...");
  const smoke = spawnSync(process.execPath, [path.join(stagingDir, "scripts", "smoke.mjs")], {
    cwd: stagingDir,
    stdio: "inherit"
  });
  if (smoke.status !== 0) fail("smoke test failed inside the packaged bundle");
  fs.rmSync(path.join(stagingDir, "data"), { recursive: true, force: true });
}

const archiveBase = path.join(releaseDir, bundleName);
const isWindowsTarget = platform.startsWith("win");
const archive = isWindowsTarget ? `${archiveBase}.zip` : `${archiveBase}.tar.gz`;
fs.rmSync(archive, { force: true });

const tarArgs = isWindowsTarget
  ? ["-a", "-c", "-f", archive, "-C", releaseDir, bundleName]
  : ["-czf", archive, "-C", releaseDir, bundleName];

const tar = spawnSync(process.platform === "win32" ? "tar.exe" : "tar", tarArgs, { stdio: "inherit" });
if (tar.status !== 0) fail(`archive creation failed with status ${tar.status}`);

const sizeMb = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
console.log(`[package] ${path.basename(archive)} (${sizeMb} MB)`);
console.log(`[package] bundle directory: ${stagingDir}`);
