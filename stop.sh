#!/usr/bin/env bash
# 停止后台运行的直播 WebUI（不影响 GPT-SoVITS 本体）
set -u
cd "$(dirname "$0")"

if ! pgrep -f "^node server/index\.js$" >/dev/null 2>&1; then
  echo "[跳过] 没有发现正在运行的 WebUI 进程。"
  exit 0
fi

pkill -f "^node server/index\.js$"
sleep 1
if pgrep -f "^node server/index\.js$" >/dev/null 2>&1; then
  echo "[提示] 进程仍在退出中，请稍候再检查端口 9870。"
else
  echo "[完成] 直播 WebUI 已停止。"
fi
