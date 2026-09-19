#!/bin/zsh
# 脱壳跑一次 iOS 构建（只为一件事：让探针的改动进到模拟器里的 App）。
# 前台跑会被工具的超时打断，而构建本身要 8 分钟左右。
set -u
cd "$(dirname "$0")/../../apps/mobile"
nohup /usr/bin/nice -n 19 python3 verification/build.py \
  --destination 'generic/platform=iOS Simulator' --json \
  > /tmp/fp-build.json 2> /tmp/fp-build.log &
echo "build started pid=$!"
