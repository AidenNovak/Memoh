#!/usr/bin/env bash
# 在模拟器上跑 MemohKit 的 **hosted 单元测试**（MemohKitTests target）。
#
# 与 `pnpm ios:test:swift`（纯逻辑、跑在 vultr-sg 构建机）互补：这一半断言依赖 UIKit
# （cell 复用、颜色映射、无障碍、事件），必须跑在 iOS 模拟器上、宿主为真 App。
#
# 前置：`pnpm ios:prebuild` 已跑过（plugins/withKitTests.js 已把测试 target 注入
# ios/ 工程），且 `pnpm pods` 已完成。首次会全量编译 pods（约 8-10 分钟）。
#
# 为什么用专用模拟器：测试要安装/启动 App 宿主，占用默认设备会和别的构建冲突；
# 用 simctl 建一个独立设备，用完可留（脚本幂等，下次复用）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE="$ROOT/apps/mobile"

DEVICE_NAME="Memoh KitHosted"
RUNTIME="com.apple.CoreSimulator.SimRuntime.iOS-26-5"
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"

# CI / verify:simulator 租约：用租来的设备（不新建，设备管理只属于 simulator.py）。
if [[ -n "${MEMOH_VERIFY_UDID:-}" ]]; then
  UDID="$MEMOH_VERIFY_UDID"
  echo "使用租约设备 $UDID"
else
  # 本地便捷路径：复用已创建的专用设备；不存在才建（模拟器设备是持久资源）。
  UDID="$(xcrun simctl list devices available | awk -v name="$DEVICE_NAME" '$3 == name {print $1}' | head -1)"
  if [[ -z "$UDID" ]]; then
    # ⚠️ 别写成 `$DEVICE_NAME…`：UTF-8 locale 下 bash 会把那个多字节省略号当成变量名的一部分，
    # `set -u` 直接报 `DEVICE_NAME<0xE2>: unbound variable`（2026-09-17 实测：本地这条**不经租约**
    # 的路径一进来就死；CI 那条带 MEMOH_VERIFY_UDID 的路绕过了它，所以一直没暴露）。
    echo "创建设备 ${DEVICE_NAME}..."
    UDID="$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
  fi
  echo "设备 $DEVICE_NAME ($UDID)"
fi

cd "$MOBILE"
xcodebuild test \
  -workspace ios/Memoh.xcworkspace \
  -scheme Memoh \
  -destination "id=$UDID" \
  -only-testing:MemohKitTests \
  -derivedDataPath /tmp/memoh-hosted-dd
