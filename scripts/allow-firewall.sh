#!/usr/bin/env bash
# 放行直播 WebUI 的局域网访问端口（Linux: ufw / firewalld）
# 用法: bash scripts/allow-firewall.sh [端口]
set -u

PORT="${1:-${PORT:-9870}}"

lan_subnet() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')"
  if [ -n "$ip" ]; then
    printf '%s.0/24\n' "${ip%.*}"
  else
    printf '192.168.0.0/16\n'
  fi
}

run_privileged() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"
  elif command -v pkexec >/dev/null 2>&1; then
    pkexec "$@"
  else
    echo "[错误] 需要管理员权限，请手动执行：sudo $*"
    return 1
  fi
}

if command -v ufw >/dev/null 2>&1; then
  SUBNET="$(lan_subnet)"
  echo "[执行] 放行 ${SUBNET} 访问 ${PORT}/tcp ..."
  run_privileged ufw allow from "$SUBNET" to any port "$PORT" proto tcp
  exit $?
fi

if command -v firewall-cmd >/dev/null 2>&1; then
  echo "[执行] 放行 ${PORT}/tcp ..."
  run_privileged firewall-cmd --permanent --add-port="${PORT}/tcp" &&
    run_privileged firewall-cmd --reload
  exit $?
fi

echo "[跳过] 未检测到 ufw 或 firewalld，无需额外放行。"
echo "       若手机仍打不开，请确认手机与电脑连接同一个 Wi-Fi，且路由器未开启 AP 隔离。"
