#!/usr/bin/env bash
cd "$(dirname "$0")"

# 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js (20.19+ 或 22.12+)"
  exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
  echo "[提示] 检测到首次运行，正在安装依赖..."
  npm install
fi

# 如果 client/dist 不存在则构建
if [ ! -d "client/dist" ]; then
  echo "[提示] 正在构建前端页面..."
  npm run build
fi

echo "[检查] 正在检查局域网端口是否被防火墙拦截..."
node server/firewall.js || true

echo "[启动] 正在启动 GPT-SoVITS 直播辅助 WebUI..."
mkdir -p data
node server/index.js 2>&1 | tee -a data/server.log
