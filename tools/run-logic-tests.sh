#!/usr/bin/env bash
# 在构建机上跑 MemohKit 的**纯逻辑**测试（不需要 UIKit / 模拟器）。
#
# 为什么在远端跑：本机 Mac 被 iOS 构建压到过 load 165+，而这类测试只是编译几个
# Swift 文件，放在 vultr-sg 上不占本机。这也让"纯逻辑测试"成为一条谁都能复现的
# 命令，而不是某台机器上的私人操作。
#
# ## 为什么不用本机 swiftc
#
# 本机能编译，但 `XCTMain` 在 macOS 的 XCTest 里对命令行 runner 不友好（需要
# libXCTestSwiftSupport 的运行时环境），折腾这些只为跑几个纯函数不值得。Linux 上
# 的 swift-corelibs-xctest 对这套 runner 是一等公民，而且和 CI 的行为一致。
#
# 用法：
#     Tools/run-logic-tests.sh            # 跑默认的纯逻辑测试
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${MEMOH_BUILD_HOST:-vultr-sg}"
# 远端工作目录。**可以用环境变量换一个**：多 agent 同时跑这条命令时共用一个目录会互相
# 覆盖源码，症状是 `input file 'X.swift' was modified during the build`（2026-09-17 实测）。
REMOTE_DIR="${MEMOH_KIT_TEST_DIR:-/opt/memoh-kit-tests}"
IMAGE="swift:6.2-noble"

# 只传需要的文件：Transcript.swift（政策与数据）、MemohStrings.swift（纯逻辑测试
# 也要拼状态文案）、NotificationContract.swift（通知负载解析与 device token 编码，
# Foundation-only）、以及两个测试文件。顺便把 `#if canImport(MemohKit)` 关掉——
# 远端没有那个模块，也不需要。
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
scp -q "$ROOT/apps/mobile/modules/memoh-kit/ios/Chat/Transcript.swift" \
       "$ROOT/apps/mobile/modules/memoh-kit/ios/Chat/Markdown.swift" \
       "$ROOT/apps/mobile/modules/memoh-kit/ios/Support/MemohStrings.swift" \
       "$ROOT/apps/mobile/modules/memoh-kit/ios/Notifications/NotificationContract.swift" \
       "$ROOT/apps/mobile/modules/memoh-kit/verification/MessageListTests.swift" \
       "$ROOT/apps/mobile/modules/memoh-kit/verification/NotificationContractTests.swift" \
       "$REMOTE:$REMOTE_DIR/"

ssh "$REMOTE" "docker run --rm --memory=2g --cpus=2 -v $REMOTE_DIR:/src -w /src $IMAGE bash -lc '
set -e
sed -i \"s/#if canImport(MemohKit)/#if false/\" MessageListTests.swift
swiftc -O Transcript.swift Markdown.swift MemohStrings.swift NotificationContract.swift MessageListTests.swift NotificationContractTests.swift -o logic-tests
./logic-tests
'"
