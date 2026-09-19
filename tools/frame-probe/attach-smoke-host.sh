#!/bin/zsh
# 在一个**本机普通进程**上冒烟 xctrace attach，用来区分"attach 机制不可用"和
# "模拟器里的 App 进程不可 attach"。用完自己收尸。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
nohup sleep 600 >/dev/null 2>&1 &
sleep_pid=$!
sleep 1
echo "sleep pid=$sleep_pid"
rm -rf /tmp/xctrace-smoke.trace
xcrun xctrace record --template 'Time Profiler' --attach "$sleep_pid" \
  --time-limit 3s --output /tmp/xctrace-smoke.trace 2>&1 | tail -10
echo "xctrace_exit=$?"
ls -la /tmp/xctrace-smoke.trace 2>&1 | head -3
kill "$sleep_pid" 2>/dev/null
