#!/bin/zsh
# 一把租约包住"装 App + 跑一整轮长会话电池"。
#
# **租约名与 `run-battery-leased.sh` 不同**（`frame-probe-long`）：同名会被租到**同一台设备**上，
# 两个 agent 同时装/起 App 会互相把对方的场景打断（而且两边的数字都作废）。
#
# 用法：run-battery-long-leased.sh <out-dir> <label-prefix> [传给 run-battery-long.sh 的参数…]
#   # 例：run-battery-long-leased.sh /tmp/fp-long/pair dim-long --pair --metro-port 8099
#
# App 路径走环境变量 `FRAME_PROBE_APP`（与 `run-battery-long.sh` 同一个口径），不占位置参数——
# 位置参数留给要转发的开关（踩过：把 `--metro-port` 当成 App 路径去 install）。
set -eu
OUT="$1"; PREFIX="$2"; shift 2
EXTRA="$*"
HERE=$(cd "$(dirname "$0")" && pwd)
MOBILE=$(cd "$HERE/../../apps/mobile" && pwd)
# App 路径默认取本仓库的构建产物（不再写死某台机器上的绝对路径）。
APP="${FRAME_PROBE_APP:-$MOBILE/verification/.artifacts/derived-data/Build/Products/Debug-iphonesimulator/Memoh.app}"
mkdir -p "$OUT"

cd "$MOBILE"
exec pnpm verify:simulator --name 'frame-probe-long' -- zsh -euc "
  set -eu
  echo \"device \$MEMOH_VERIFY_UDID\" | tee -a '$OUT/lease.txt'
  # 满载时 install 会偶发被 SpringBoard 拒（文档里有记录）。**不让它把整轮拖死**：
  # 每个场景开始时 measure.py 自己还会用 --app 重装一次，那里有针对性的重试。
  # `FRAME_PROBE_APP=none`（或设备上已经有这个 App）时跳过：一次 install 在满载时是分钟级。
  if [ '$APP' != none ]; then
    xcrun simctl install \$MEMOH_VERIFY_UDID '$APP' || echo 'install 失败，交给 measure.py 自己重装'
  fi
  xcrun simctl terminate \$MEMOH_VERIFY_UDID ai.memoh.ios 2>/dev/null || true
  FRAME_PROBE_APP='$APP' '$HERE/run-battery-long.sh' \$MEMOH_VERIFY_UDID '$OUT' '$PREFIX' $EXTRA"
