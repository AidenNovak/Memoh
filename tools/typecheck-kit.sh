#!/usr/bin/env bash
# 对 MemohKit 里**只依赖 UIKit** 的 Swift 文件做类型检查（`swiftc -typecheck`）。
#
# ## 为什么需要它
#
# UIKit 文件里的类型错误通常要到完整 Xcode 构建才暴露。这里用 `swiftc -typecheck`
# 提前检查，避免为一个简单错误等待整轮构建。
#
# `-typecheck` 走完整类型检查但不生成代码、不链接、不需要模拟器，几秒出结果。
# 比 `-parse`（只看语法）强得多：类型不匹配、成员不存在、可变性错误都能抓到。
#
# ## 覆盖范围（重要，别当成"Swift 都检查了"）
#
# **检查**：`MessageCells.swift`——六种 cell 的全部渲染逻辑。它是纯 UIKit，不需要 Expo。
#
# **不检查**：`NativeMessageList.swift`——它 `import ExpoModulesCore`，而 Pods 里
# 那份预编译 xcframework 是用稍旧的 Swift 编译器构建的
# （SDK 6.3.1 vs 本机 6.3.3），本机 `swiftc` 无法解析它的 swiftinterface。
# 于是列表调度那一块只能靠真正的 xcodebuild 兜底。
#
# ## 它做不到什么
#
# 不验证链接、不验证 Expo 模块注册、不验证运行时行为。类型检查通过 ≠ App 能构建。
# 真正的构建仍然要用生成后的 Xcode 工程完成。
#
# 用法：
#     Tools/typecheck-kit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$ROOT/apps/mobile/modules/memoh-kit/ios"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

sources=(
  "$KIT/Support/MemohStrings.swift"
  "$KIT/Support/MemohPalette.swift"
  "$KIT/Chat/Transcript.swift"
  # Markdown 解析层只用 Foundation，本机这几秒的 `-typecheck` 也能覆盖它。
  "$KIT/Chat/Markdown.swift"
  # Markdown 视觉层：属性字符串、代码块横滚、链接命中、复制。
  "$KIT/Chat/MarkdownText.swift"
  "$KIT/Chat/MessageCells.swift"
  # 通知桥：只依赖 Foundation + UIKit + UserNotifications（不 import ExpoModulesCore），
  # 所以能在本机几秒内类型检查。模块注册那一侧（MemohKitModule.swift）仍然只能靠
  # 真构建兜底——见文件头"不检查"那一段。
  "$KIT/Notifications/NotificationContract.swift"
  "$KIT/Notifications/MemohNotifications.swift"
)

echo "对 ${#sources[@]} 个 MemohKit 文件做类型检查（iphonesimulator SDK，DEBUG）…"

xcrun -sdk iphonesimulator swiftc \
  -typecheck \
  -parse-as-library \
  -target arm64-apple-ios26.0-simulator \
  -sdk "$SDK" \
  -D DEBUG \
  "${sources[@]}"

# 新增文件必须同步进 Pods 工程，否则**真机构建会找不到**，而上面这几行类型检查发现
# 不了——它是显式列文件的，绕过了 Xcode 的工程文件列表。
#
# 踩过：加了 `MemohPalette.swift`，typecheck 通过、构建报
# "cannot find 'MemohPalette' in scope"（Pods 缓存的文件清单里没有它）。
# 所以这里加一道检查：把 `ios/` 下的 Swift 文件与 Pods 工程里记录的对比。
if [[ -f "$ROOT/apps/mobile/ios/Pods/Pods.xcodeproj/project.pbxproj" ]]; then
  missing=()
  while IFS= read -r file; do
    name="$(basename "$file")"
    if ! grep -q "\b${name%.swift}\b" "$ROOT/apps/mobile/ios/Pods/Pods.xcodeproj/project.pbxproj"; then
      missing+=("$name")
    fi
  done < <(find "$KIT" -name '*.swift')
  if (( ${#missing[@]} > 0 )); then
    echo "⚠️  这些文件不在 Pods 工程里：${missing[*]}" >&2
    echo "    跑一下 pnpm pods（apps/mobile），否则真机构建会报 cannot find in scope。" >&2
    exit 1
  fi
fi

echo "类型检查通过（不含 NativeMessageList.swift：见本脚本头部说明）"
