#!/usr/bin/env bash
# 对 MemohKit 里**只依赖 Foundation** 的 Swift 文件做类型检查。
#
# ## 为什么需要它（与 tools/typecheck-kit.sh 的分工）
#
# `typecheck-kit.sh` 覆盖 8 个文件，但它要 `xcrun --sdk iphonesimulator` —— **那个 SDK 只有
# Xcode 有**。在没有 Xcode 的机器上，UIKit 那 4 个文件确实查不了，但**这 4 个 Foundation-only
# 的文件查得了**：语法错、类型不匹配、成员不存在，在这里当场就能发现。
#
# ## 覆盖范围（别当成"Swift 都查了"）
#
# **查**：`Support/MemohStrings.swift`、`Chat/Transcript.swift`、`Chat/Markdown.swift`、
# `Notifications/NotificationContract.swift`、`Authentication/AuthContract.swift`。
#
# **不查**：`MemohPalette` / `MarkdownText` / `MessageCells` /
# `MemohNotifications`——它们 `import UIKit`，只能在 iOS SDK 下查（`pnpm ios:typecheck:kit`，
# 要 Xcode）。那条由 `pnpm ios:typecheck:kit` 覆盖（见 memoh-ios-dev.md §2）。
#
# 用法：
#     tools/typecheck-foundation.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$ROOT/apps/mobile/modules/memoh-kit/ios"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "找不到 swiftc：这台机器没有 Swift 工具链（装 Command Line Tools 即可，不需要 Xcode）。" >&2
  exit 1
fi

sources=(
  "$KIT/Support/MemohStrings.swift"
  "$KIT/Chat/Transcript.swift"
  "$KIT/Chat/Markdown.swift"
  "$KIT/Notifications/NotificationContract.swift"
  "$KIT/Authentication/AuthContract.swift"
)

echo "对 ${#sources[@]} 个 Foundation-only 文件做类型检查（macOS SDK，不需要 Xcode）…"

swiftc \
  -typecheck \
  -parse-as-library \
  "${sources[@]}"

# URL/候选顺序/邮箱形状/会话 JSON 是安全边界，不只做“能编译”：跑一份无网络的契约测试。
test_binary="$(mktemp "${TMPDIR:-/tmp}/memoh-auth-contract.XXXXXX")"
trap 'rm -f "$test_binary"' EXIT
swiftc \
  -parse-as-library \
  "$KIT/Authentication/AuthContract.swift" \
  "$ROOT/tools/test-auth-contract.swift" \
  -o "$test_binary"
"$test_binary"

echo "类型检查通过（UIKit 那批不在这里：要 iOS SDK，跑 pnpm ios:typecheck:kit）"
