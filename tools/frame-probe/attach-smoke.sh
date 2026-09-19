#!/bin/zsh
# xctrace 可行性冒烟测试：能不能 attach 到**模拟器里的 App 进程**。
# 用法：attach-smoke.sh <sim-udid> <pid> <template> <seconds> <out.trace>
#
# 存在理由：`xctrace record --attach <pid>`（不带 --device）在 macOS 26 上对模拟器进程
# 直接报 `Cannot find process for provided pid`；模拟器进程必须显式给 `--device`。
# 这条结论写进了 docs/research/ios-performance-practices.md。
set -u
udid="$1"
pid="$2"
template="${3:-Animation Hitches}"
seconds="${4:-4}"
out="$5"
rm -rf "$out"
xcrun xctrace record --device "$udid" --template "$template" --attach "$pid" \
  --time-limit "${seconds}s" --output "$out" 2>&1 | tail -20
echo "xctrace_exit=$?"
