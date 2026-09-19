#!/usr/bin/env bash
# 从本机经 SSH 隧道访问 vultr-sg 上的 Memoh dev 环境。
#
# 用法:
#   memoh-tunnel.sh start    # 建立 18080/18082 隧道（幂等）
#   memoh-tunnel.sh stop
#   memoh-tunnel.sh status
#
# 隧道建立后：Web UI http://127.0.0.1:18082 ，API http://127.0.0.1:18080
#
# 两个刻意的设计，都是被坑出来的：
#
# 1. **判断存活看端口，不看进程名。** SSH 连接复用（ControlMaster）会把进程标题
#    改写成 `ssh: host [mux]`，`pgrep -f` 匹配转发参数永远匹配不到——这曾经让脚本
#    一边报 stopped、一边隧道其实是通的。
# 2. **隧道不共享 mux（`ControlPath=none`）。** 共享时，别的会话把 master 关掉或
#    让它超时，隧道会跟着死，而且死得没有迹象。独立连接加上 ServerAlive 才是稳的。
set -euo pipefail

LOCAL_API=18080
LOCAL_WEB=18082
REMOTE_API=18080     # vultr 上 server 绑的本地端口
REMOTE_WEB=18082

# 隧道是否在服务（端口已监听且服务端有响应）。
port_listening() {
  lsof -nP -iTCP:"$LOCAL_API" -sTCP:LISTEN >/dev/null 2>&1
}

api_reachable() {
  # 401 也算通：说明服务端在响应，只是没带凭据。
  curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${LOCAL_API}/bots" 2>/dev/null | grep -qE '^(2|4)[0-9][0-9]$'
}

stop_tunnel() {
  # 只杀我们自己开的那两条转发，不动这台机器上别人（或别的 agent）的 ssh。
  local pids
  pids=$(lsof -nP -iTCP:"$LOCAL_API" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
  pids=$(lsof -nP -iTCP:"$LOCAL_WEB" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
}

case "${1:-status}" in
  start)
    if port_listening; then
      if api_reachable; then
        echo "already up: api http://127.0.0.1:${LOCAL_API}  web http://127.0.0.1:${LOCAL_WEB}"
        exit 0
      fi
      echo "端口在监听但服务端不回，重建隧道"
      stop_tunnel
      sleep 1
    fi

    ssh -f -N \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
      -o TCPKeepAlive=yes \
      -o ControlMaster=no -o ControlPath=none \
      -L "127.0.0.1:${LOCAL_API}:127.0.0.1:${REMOTE_API}" \
      -L "127.0.0.1:${LOCAL_WEB}:127.0.0.1:${REMOTE_WEB}" \
      vultr-sg

    sleep 2
    if ! port_listening; then
      echo "隧道没有建立：${LOCAL_API} 上没有监听。检查 ssh 配置与网络。" >&2
      exit 1
    fi
    if ! api_reachable; then
      echo "隧道建立了但服务端不回；确认 vultr-sg 上的 memoh-dev 在跑：" >&2
      echo "  ssh vultr-sg '/opt/memoh-dev/ops/memoh-dev.sh ps'" >&2
      exit 1
    fi
    echo "tunnel up: api http://127.0.0.1:${LOCAL_API}  web http://127.0.0.1:${LOCAL_WEB}"
    ;;
  stop)
    stop_tunnel
    sleep 1
    if port_listening; then
      echo "端口 ${LOCAL_API} 仍被占用" >&2
      exit 1
    fi
    echo "tunnel stopped"
    ;;
  status)
    if port_listening && api_reachable; then
      echo "up: api http://127.0.0.1:${LOCAL_API}  web http://127.0.0.1:${LOCAL_WEB}"
      curl -s -m 8 -o /dev/null -w "  api  %{http_code}\n" "http://127.0.0.1:${LOCAL_API}/bots" || true
      curl -s -m 8 -o /dev/null -w "  web  %{http_code}\n" "http://127.0.0.1:${LOCAL_WEB}/" || true
    elif port_listening; then
      echo "degraded: 端口在监听但服务端不回（vultr 上的 memoh-dev 可能停了）"
      exit 1
    else
      echo "stopped"
      exit 1
    fi
    ;;
  *) sed -n '2,10p' "$0" ;;
esac
