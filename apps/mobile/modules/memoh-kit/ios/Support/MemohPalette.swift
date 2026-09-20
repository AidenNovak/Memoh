import UIKit

/**
 原生侧的 Memoh 品牌色。

 ## 为什么原生不能直接用 `.label` / `.systemBackground`

 那些是 iOS 的系统色：`#000000` 配 `#FFFFFF`，冷调的纯黑纯白。而 Memoh 的品牌色是
 **暖白 `#FAF8F7` / 暖黑 `#191816` / 品牌紫 `#764BE5`**。原生列表如果继续用系统色，
 它和它上下的 RN 界面（已经用了品牌色）会拼成两种温度的白，一眼能看出是两套东西。

 ## 值从哪来

 和 RN 侧同一个来源——`tools/oklch.py` 从桌面端 `@felinic/ui` 的 `style.css` 转出来。
 **改颜色请改那个脚本**，然后同步 `tokens.ts` 与这个文件。两边不一致比两边都用系统色更糟：
 前者是"看起来像 bug"，后者至少是"看起来统一但不像品牌"。

 ## 为什么不用 UIColor(dynamicProvider:) 做动态色

 动态色需要 trait 变化时重绘，而这个列表在流式追加时频繁 reload，多一层 trait 依赖
 就多一个"某些情况下颜色没跟上"的隐患。这里显式按 trait 取，逻辑一眼可见。
 */
enum MemohPalette {
  /** 页面底 / 消息流的底。暖白、近黑。 */
  static func background(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkBackground : Palette.lightBackground
  }

  /** 卡片 / 用户气泡之外的容器底。 */
  static func card(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkCard : Palette.lightCard
  }

  /** 用户气泡底：品牌色派生的淡紫（桌面端用相对颜色语法从 --brand 派生）。 */
  static func userBubble(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkUserBubble : Palette.lightUserBubble
  }

  /** 正文。暖黑 / 暖白。 */
  static func label(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkLabel : Palette.lightLabel
  }

  /** 次要文字。 */
  static func secondaryLabel(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkSecondaryLabel : Palette.lightSecondaryLabel
  }

  /** 描边与分隔线。 */
  static func separator(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkSeparator : Palette.lightSeparator
  }

  /** 危险 / 错误正文。 */
  static func destructive(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkDestructive : Palette.lightDestructive
  }

  /** 下沉面（代码块、内嵌容器）。 */
  static func inset(_ traits: UITraitCollection) -> UIColor {
    traits.userInterfaceStyle == .dark ? Palette.darkInset : Palette.lightInset
  }

  /**
   机器活动卡片的容器。

   ⚠️ 必须与 `userBubble` **不同**——曾经两者都是同一个灰，实测一张工具场景截图里
   那种灰占了 49% 的像素，整屏没有层级。见 `MessageListMetrics` 里的说明。

   这里用 `inset`（比页面深一档的中性色）而用户气泡用品牌淡紫，两者天然不同。
   */
  static func activitySurface(_ traits: UITraitCollection) -> UIColor {
    inset(traits)
  }

  /** 值取自 `tools/oklch.py` 的输出。 */
  private enum Palette {
    static let lightBackground = UIColor(hex: 0xFAF8F7)
    static let lightCard = UIColor(hex: 0xFFFFFF)
    static let lightLabel = UIColor(hex: 0x191816)
    static let lightSecondaryLabel = UIColor(hex: 0x6A6965)
    static let lightSeparator = UIColor(hex: 0xE5E2E0)
    static let lightDestructive = UIColor(hex: 0xE7000B)
    static let lightInset = UIColor(hex: 0xF4F4F4)
    static let lightUserBubble = UIColor(hex: 0xEEE5FE)

    static let darkBackground = UIColor(hex: 0x060606)
    static let darkCard = UIColor(hex: 0x181818)
    static let darkLabel = UIColor(hex: 0xDEDEDE)
    static let darkSecondaryLabel = UIColor(hex: 0x9E9E9E)
    static let darkSeparator = UIColor(white: 1, alpha: 0.08)
    static let darkDestructive = UIColor(hex: 0xFF6467)
    static let darkInset = UIColor(hex: 0x242424)
    static let darkUserBubble = UIColor(hex: 0x532D8D)
  }
}

private extension UIColor {
  /// 从 `0xRRGGBB` 构造。比 `UIColor(red:green:blue:)` 少一行除法，也少一次抄错的机会。
  convenience init(hex: Int) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1
    )
  }
}
