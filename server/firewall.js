import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function run(cmd, args, timeout = 4000) {
  try {
    return execFileSync(cmd, args, {
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}

function localLanSubnet() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal && !iface.address.startsWith("172.")) {
        const parts = iface.address.split(".");
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      }
    }
  }
  return "192.168.0.0/16";
}

function checkUfw(port, subnet) {
  if (!readIfExists("/etc/ufw/ufw.conf").match(/^\s*ENABLED\s*=\s*yes\s*$/im)) {
    return null;
  }

  const allowed = readIfExists("/etc/ufw/user.rules")
    .split("\n")
    .filter((line) => line.startsWith("-A ufw-user-input"))
    .some((line) => new RegExp(`--dport\\s+${port}(\\s|$)`).test(line) && /-j ACCEPT/.test(line));

  if (allowed) {
    return { firewall: "ufw", ok: true };
  }

  return {
    firewall: "ufw",
    ok: false,
    reason: `ufw 处于启用状态，但没有放行 ${port} 端口`,
    fix: `sudo ufw allow from ${subnet} to any port ${port} proto tcp`
  };
}

function checkFirewalld(port) {
  const state = run("firewall-cmd", ["--state"]);
  if (!state || !state.includes("running")) return null;
  if (run("firewall-cmd", [`--query-port=${port}/tcp`])) {
    return { firewall: "firewalld", ok: true };
  }
  return {
    firewall: "firewalld",
    ok: false,
    reason: `firewalld 处于运行状态，但没有放行 ${port}/tcp`,
    fix: `sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload`
  };
}

function checkWindowsFirewall(port) {
  const ruleName = "GPT-SoVITS Live WebUI";
  const existing = run("netsh", [
    "advfirewall",
    "firewall",
    "show",
    "rule",
    `name=${ruleName}`
  ]);
  if (existing && existing.includes(ruleName)) {
    return { firewall: "Windows 防火墙", ok: true };
  }
  return {
    firewall: "Windows 防火墙",
    ok: false,
    reason: `没有找到名为 ${ruleName} 的入站规则，手机连接可能被系统拦截`,
    fix: `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}`
  };
}

export function checkPortAccess(port) {
  try {
    if (process.platform === "linux") {
      return checkUfw(port, localLanSubnet()) || checkFirewalld(port) || { firewall: null, ok: true };
    }
    if (process.platform === "win32") {
      return checkWindowsFirewall(port);
    }
  } catch {
    return { firewall: null, ok: true };
  }
  return { firewall: null, ok: true };
}

export function formatWarning(result, port) {
  if (!result || result.ok) return [];
  const lines = [
    `[防火墙提示] ${result.reason}`,
    `            手机打不开页面时，先执行：${result.fix}`,
    `            放行后无需重启本服务，直接用手机访问 http://<电脑局域网IP>:${port}`
  ];
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || process.argv[2] || 9870);
  const result = checkPortAccess(port);
  if (result.ok) {
    const name = result.firewall ? `${result.firewall} 未发现拦截规则` : "未检测到会拦截的防火墙";
    console.log(`[防火墙检查] ${name}，${port} 端口应当可以从局域网访问。`);
  } else {
    console.log(formatWarning(result, port).join("\n"));
  }
}
