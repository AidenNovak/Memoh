#!/bin/zsh
# 脱壳跑一整轮电池（前台会被调用工具的超时打断，而一轮要十几分钟）。
# 用法：detached-battery.sh <out-dir> <label-prefix>
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$1"; PREFIX="$2"
mkdir -p "$OUT"
nohup "$HERE/run-battery-leased.sh" "$OUT" "$PREFIX" > "$OUT/battery-run.log" 2>&1 &
echo "battery started pid=$! log=$OUT/battery-run.log"
