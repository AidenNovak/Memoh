#!/bin/zsh
# 一把租约包住"装 App + 跑一整轮电池"：租约一断，别人就可能把设备拿走。
# 用法：run-battery-leased.sh <out-dir> <label-prefix> [app-path]
set -eu
OUT="$1"; PREFIX="$2"
APP="${3:-/Users/lijixiang/projects/memoh-ios/apps/mobile/verification/.artifacts/derived-data/Build/Products/Debug-iphonesimulator/Memoh.app}"
HERE=$(cd "$(dirname "$0")" && pwd)
MOBILE=$(cd "$HERE/../../apps/mobile" && pwd)

cd "$MOBILE"
exec pnpm verify:simulator --name 'frame-probe' -- zsh -euc "
  set -eu
  echo \"device \$MEMOH_VERIFY_UDID\" | tee -a '$OUT/lease.txt'
  xcrun simctl install \$MEMOH_VERIFY_UDID '$APP'
  xcrun simctl terminate \$MEMOH_VERIFY_UDID ai.memoh.ios 2>/dev/null || true
  '$HERE/run-battery.sh' \$MEMOH_VERIFY_UDID '$OUT' '$PREFIX'
"
