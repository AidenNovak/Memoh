#!/bin/zsh
# 在后台（脱壳）跑一次 xctrace 录制，日志写文件，自己回来读。
# 用法：detached-xctrace.sh <log> <udid> <pid> <template> <seconds> <out.trace>
#
# 为什么要脱壳：xctrace 对模拟器进程有时不按 --time-limit 收尾（实测挂住），
# 前台跑会把整个调用拖死；脱壳后我们能一边做别的、一边看它到底出不出结果。
set -u
log="$1"; udid="$2"; pid="$3"; template="$4"; seconds="$5"; out="$6"
rm -rf "$out" "$log"
nohup xcrun xctrace record --device "$udid" --template "$template" --attach "$pid" \
  --time-limit "${seconds}s" --output "$out" > "$log" 2>&1 &
echo "started pid=$!"
