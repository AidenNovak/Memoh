#!/usr/bin/env bash
# 对 MemohKit 里**只依赖 Foundation** 的 Swift 文件做类型检查。
#
# ## 为什么需要它（与 tools/typecheck-kit.sh 的分工）
#
# `typecheck-kit.sh` 覆盖 9 个文件，但它要 `xcrun --sdk iphonesimulator` —— **那个 SDK 只有
# Xcode 有**。在没有 Xcode 的机器上，UIKit 那 5 个文件确实查不了，但**这 4 个 Foundation-only
# 的文件查得了**：语法错、类型不匹配、成员不存在，在这里当场就红，不必 ssh 到构建机跑一遍
# `pnpm ios:test:swift` 才知道。
#
# ## 覆盖范围（别当成"Swift 都查了"）
#
# **查**：`Support/MemohStrings.swift`、`Chat/Transcript.swift`、`Chat/Markdown.swift`、
# `Notifications/NotificationContract.swift`——与 `typecheck-kit.sh` 里那 4 个是同一份清单。
#
# **不查**：`MemohPalette` / `MarkdownText` / `MessageCells` / `MessageListFrameProbe` /
# `MemohNotifications`——它们 `import UIKit`，只能在 iOS SDK 下查（`pnpm ios:typecheck:kit`，
# 要 Xcode）。那条由 `pnpm ios:typecheck:kit` 覆盖（见 memoh-ios-dev.md §2）。
#
# ## 与 `pnpm ios:test:swift` 的重叠是故意的
#
# 远端那条（`vultr-sg` 容器）会把同样这几个文件**连测试一起编译并运行**，覆盖面更广。
# 这里只是**本机快检**：约 2 秒、不联网、不占构建机。两者都留着——本机快检负责"提交前别把
# Swift 写坏"，远端那条负责"逻辑真的对"。
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
)

echo "对 ${#sources[@]} 个 Foundation-only 文件做类型检查（macOS SDK，不需要 Xcode）…"

swiftc \
  -typecheck \
  -parse-as-library \
  "${sources[@]}"

echo "类型检查通过（UIKit 那批不在这里：要 iOS SDK，跑 pnpm ios:typecheck:kit）"
