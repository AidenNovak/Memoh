import SwiftUI
import UIKit

/// 主题模式（`system | light | dark | oled`）在原生侧的三个投影。
///
/// 权威状态仍由 RN `ThemeProvider` 持有（`src/lib/theme/context.tsx`）：这里只把下发的
/// 字符串翻成 SwiftUI 要的三样东西——校验、配色方案、表单底色。外观页、设置页、通知页
/// 用的是同一份判断，所以放在 Support 里只有一份。
///
/// `oled` 是**暗色的变体**（纯黑底），不是第四种并列模式——所以它的配色方案是 `.dark`。
enum MemohAppearanceMode {
  static let valid: Set<String> = ["system", "light", "dark", "oled"]

  /// 认不出的值一律当"跟随系统"：宁可跟随系统，也不要停在一个编出来的模式上。
  static func normalized(_ value: String) -> String {
    valid.contains(value) ? value : "system"
  }

  /// `nil` = 跟随系统。
  static func colorScheme(_ mode: String) -> ColorScheme? {
    switch normalized(mode) {
    case "light": return .light
    case "dark", "oled": return .dark
    default: return nil
    }
  }

  static func formBackground(_ mode: String) -> Color {
    switch normalized(mode) {
    case "oled": return .black
    case "light": return Color(uiColor: MemohPalette.background(.init(userInterfaceStyle: .light)))
    case "dark": return Color(uiColor: MemohPalette.background(.init(userInterfaceStyle: .dark)))
    default: return Color(uiColor: UIColor { MemohPalette.background($0) })
    }
  }
}
