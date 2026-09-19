import UIKit

/**
 Markdown 的**视觉层**（UIKit）：把 `MarkdownBlock` 变成能画的东西。

 ## 分工
 `Markdown.swift` 负责"是什么"（Foundation-only，可在构建机上单测）；这里只负责"长什么样"。
 一条纪律：**屏幕上画的字必须与 `MarkdownDocument.renderedText` 同源**——渲染只读
 `block.spans` / `block.lines`，绝不再去看原始字符。这样"不闪原始符号"那条断言才对着用户
 真看得见的东西（见 `docs/CHAT-RENDERING.md`）。

 ## 三种块视图
 - `MarkdownTextBlockView`（标题 / 段落 / 列表项 / 引用）：一个 `UILabel`，用属性字符串一次
   画完行内样式；
 - `MarkdownCodeBlockView`（围栏代码 / 表格兜底）：等宽、**逐行不换行**、外层横向滚动，
   长行不撑爆气泡；
 - `MarkdownRuleView`：一条发丝线。

 ## 为什么用 `UILabel` 而不是 `UITextView`
 高度。`UILabel` 的自适应高度是列表里跑了很久、被量过的那条路（`estimated(80)` + 自撑开），
 换成 `UITextView` 就要重新趟一遍"自撑开在 diffable 更新里的收敛"，而这一轮的预算该花在
 渲染上。代价是**文本选择**不免费：复制走"长按菜单 + 读屏自定义动作"（见 `MessageCells.swift`
 的 `TextMessageCell`），链接点击自己命中原子的字形范围（`MarkdownTextLabel`）。
 */
enum MarkdownViewKind: Equatable {
  case text
  case code
  case rule
}

enum MarkdownStyle {
  // MARK: - 分类

  static func viewKind(_ block: MarkdownBlock) -> MarkdownViewKind {
    switch block.kind {
    case .heading, .paragraph, .bullet, .ordered, .quote: return .text
    case .code, .table: return .code
    case .rule: return .rule
    }
  }

  static func isList(_ kind: MarkdownBlockKind) -> Bool {
    switch kind {
    case .bullet, .ordered: return true
    default: return false
    }
  }

  // MARK: - 字体

  /**
   标题 H1–H3 的字号分级（H4–H6 收到 H3 以下，不再细分——聊天里很少用到那么深）。

   全部走 `UIFont.preferredFont(forTextStyle:)` + `adjustsFontForContentSizeCategory`：
   最大辅助字号下标题跟着长，不靠固定磅值（那是"AX XXXL 全坏"的成因之一）。
   */
  static func font(_ kind: MarkdownBlockKind) -> UIFont {
    switch kind {
    case .heading(let level):
      if level <= 1 { return bold(.title2) }
      if level == 2 { return bold(.title3) }
      if level == 3 { return bold(.headline) }
      return bold(.subheadline)
    case .paragraph, .bullet, .ordered, .quote, .rule:
      return UIFont.preferredFont(forTextStyle: .body)
    case .code, .table:
      return monospaced(.callout)
    }
  }

  /// 等宽字体（SF Mono）。`size` 传 nil 时按文字样式取，传值时给"行内代码跟正文同号"用。
  static func monospaced(_ style: UIFont.TextStyle, size: CGFloat? = nil) -> UIFont {
    let base = UIFont.monospacedSystemFont(
      ofSize: size ?? UIFont.preferredFont(forTextStyle: style).pointSize, weight: .regular)
    return UIFontMetrics(forTextStyle: style).scaledFont(for: base)
  }

  private static func bold(_ style: UIFont.TextStyle) -> UIFont {
    let base = UIFont.preferredFont(forTextStyle: style)
    guard let descriptor = base.fontDescriptor.withSymbolicTraits(.traitBold) else { return base }
    return UIFont(descriptor: descriptor, size: 0)
  }

  // MARK: - 块间距

  /**
   块间距：标题**前**留得最多（它是新一节的开头），列表项之间最紧（它们是同一个东西的条目）。

   间距是"层级"的一半：只靠字号分级、上下间距一样，读起来还是一坨。
   */
  static func spacing(previous: MarkdownBlockKind?, next: MarkdownBlockKind) -> CGFloat {
    guard let previous else { return 0 }
    switch next {
    case .heading(let level):
      return level <= 1 ? 22 : (level == 2 ? 18 : 14)
    case .rule:
      return 16
    case .code, .table:
      return 12
    default:
      break
    }
    if case .heading = previous { return 8 }
    if isList(previous), isList(next) { return 6 }
    return 12
  }

  // MARK: - 属性字符串

  static func attributed(_ block: MarkdownBlock, traits: UITraitCollection) -> NSAttributedString {
    let base = font(block.kind)
    let text = NSMutableAttributedString()
    let paragraph = paragraphStyle(block.kind)
    let secondary = MemohPalette.secondaryLabel(traits)
    let color: UIColor
    switch block.kind {
    case .quote:
      color = secondary
    default:
      color = MemohPalette.label(traits)
    }
    if case .bullet = block.kind {
      text.append(NSAttributedString(string: "•\t", attributes: [
        .font: base, .foregroundColor: secondary, .paragraphStyle: paragraph,
      ]))
    }
    if case .ordered(let index, _) = block.kind {
      text.append(NSAttributedString(string: "\(index).\t", attributes: [
        .font: base, .foregroundColor: secondary, .paragraphStyle: paragraph,
      ]))
    }
    for span in block.spans {
      text.append(piece(span, base: base, color: color, traits: traits, paragraph: paragraph))
    }
    return text
  }

  private static func piece(_ span: MarkdownSpan, base: UIFont, color: UIColor,
                            traits: UITraitCollection, paragraph: NSParagraphStyle) -> NSAttributedString {
    var attributes: [NSAttributedString.Key: Any] = [
      .font: font(for: span.style, base: base),
      .foregroundColor: color,
      .paragraphStyle: paragraph,
    ]
    if span.style.contains(.strikethrough) {
      attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
    }
    if span.style.contains(.code) {
      attributes[.backgroundColor] = MemohPalette.inset(traits)
    }
    if span.style.contains(.link) {
      attributes[.foregroundColor] = linkColor
      // 只有**真的是可开的**目标才挂 `.link`：半截 URL（流式中间态）只上色，点不开——
      // 一个点了报错的链接比一个还不能点的链接更糟。
      if let destination = span.destination, let url = MarkdownLinkPolicy.openableURL(destination) {
        attributes[.link] = url
      }
    }
    return NSAttributedString(string: span.text, attributes: attributes)
  }

  private static func font(for style: MarkdownInlineStyle, base: UIFont) -> UIFont {
    if style.contains(.code) { return monospaced(.body, size: base.pointSize) }
    var descriptor = base.fontDescriptor
    if style.contains(.bold), let bolded = descriptor.withSymbolicTraits(
      descriptor.symbolicTraits.union(.traitBold)) {
      descriptor = bolded
    }
    if style.contains(.italic), let italic = descriptor.withSymbolicTraits(
      descriptor.symbolicTraits.union(.traitItalic)) {
      descriptor = italic
    }
    return UIFont(descriptor: descriptor, size: base.pointSize)
  }

  private static func paragraphStyle(_ kind: MarkdownBlockKind) -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    switch kind {
    case .bullet(let depth):
      applyHangingIndent(style, depth: depth, markerWidth: 22)
      style.lineSpacing = 3
    case .ordered(_, let depth):
      applyHangingIndent(style, depth: depth, markerWidth: 26)
      style.lineSpacing = 3
    case .quote:
      style.firstLineHeadIndent = 14
      style.headIndent = 14
      style.lineSpacing = 3
    case .heading, .paragraph:
      style.lineSpacing = 3
    case .rule, .code, .table:
      break
    }
    return style
  }

  private static func applyHangingIndent(_ style: NSMutableParagraphStyle, depth: Int,
                                         markerWidth: CGFloat) {
    let indent = CGFloat(min(max(depth, 0), 2)) * 22
    style.firstLineHeadIndent = indent
    style.headIndent = indent + markerWidth
    style.tabStops = [NSTextTab(textAlignment: .left, location: indent + markerWidth)]
  }

  // MARK: - 链接

  /// 链接色：动作用系统蓝（AGENTS.md 的 UI 基线），不自定义品牌色。
  static let linkColor = UIColor.systemBlue
}

// MARK: - 正文块（标题 / 段落 / 列表项 / 引用）

/**
 一块正文。引用块左边那条竖线是**子视图**，不是文字的一部分——它不该被复制、不该被读屏念。
 */
final class MarkdownTextBlockView: UIView {
  let label = MarkdownTextLabel()
  private let bar = UIView()
  private var barWidth: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.numberOfLines = 0
    label.adjustsFontForContentSizeCategory = true
    label.lineBreakMode = .byWordWrapping
    label.isAccessibilityElement = false
    addSubview(label)
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.layer.cornerRadius = 1.5
    bar.isHidden = true
    bar.isAccessibilityElement = false
    addSubview(bar)
    barWidth = bar.widthAnchor.constraint(equalToConstant: 3)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: topAnchor),
      label.bottomAnchor.constraint(equalTo: bottomAnchor),
      label.leadingAnchor.constraint(equalTo: leadingAnchor),
      label.trailingAnchor.constraint(equalTo: trailingAnchor),
      bar.leadingAnchor.constraint(equalTo: leadingAnchor),
      bar.topAnchor.constraint(equalTo: topAnchor, constant: 2),
      bar.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -2),
      barWidth,
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /**
   已经把属性字符串算好了（cell 会缓存它）——这里只挂上去，不再重算。

   引用块左边那条竖线是**子视图**：它不该出现在复制的文本里，也不该被读屏念。
   */
  func configure(_ block: MarkdownBlock, attributed: NSAttributedString, traits: UITraitCollection) {
    label.storedAttributed = attributed
    label.attributedText = attributed
    let quoted = isQuote(block.kind)
    bar.isHidden = !quoted
    bar.backgroundColor = MemohPalette.separator(traits)
  }

  private func isQuote(_ kind: MarkdownBlockKind) -> Bool {
    if case .quote = kind { return true }
    return false
  }
}

/**
 正文标签：负责**链接点击**与"点到了"的反馈。

 为什么自己做命中：`UILabel` 不会替我们处理链接（iOS 上只有 `UITextView` 会）。用 TextKit
 自己排版一次、按点取字符下标，是"用 UILabel 拿高度、又要点得开链接"的标准代价。
 */
final class MarkdownTextLabel: UILabel {
  var onLinkTap: ((URL) -> Void)?
  /// 配置时存下的属性字符串：点按高亮之后要还原。
  var storedAttributed: NSAttributedString?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = true
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleTap(_:))))
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
    guard let (range, url) = link(at: recognizer.location(in: self)) else { return }
    flash(range)
    onLinkTap?(url)
  }

  /**
   点到的字符下标 → `.link` 属性。

   排版参数必须与 `UILabel` 自己那套一致（同宽、同 `lineBreakMode`、`lineFragmentPadding = 0`），
   否则点中的位置会偏——这是这条路唯一的坑。
   */
  private func link(at point: CGPoint) -> (NSRange, URL)? {
    guard let attributed = attributedText, attributed.length > 0, bounds.width > 0,
          bounds.height > 0 else { return nil }
    let storage = NSTextStorage(attributedString: attributed)
    let manager = NSLayoutManager()
    let container = NSTextContainer(size: CGSize(width: bounds.width, height: bounds.height))
    container.lineFragmentPadding = 0
    container.maximumNumberOfLines = numberOfLines
    container.lineBreakMode = lineBreakMode
    storage.addLayoutManager(manager)
    manager.addTextContainer(container)
    manager.ensureLayout(for: container)
    let used = manager.usedRect(for: container)
    let adjusted = CGPoint(x: point.x, y: point.y - max((bounds.height - used.height) / 2, 0))
    guard used.contains(adjusted) else { return nil }
    let index = manager.characterIndex(for: adjusted, in: container,
                                       fractionOfDistanceBetweenInsertionPoints: nil)
    guard index < storage.length else { return nil }
    var range = NSRange()
    guard let url = storage.attribute(.link, at: index, effectiveRange: &range) as? URL else {
      return nil
    }
    return (range, url)
  }

  /// "点到了"的反馈：短暂给这一段的字形加底。终态由系统打开（Safari / Mail）。
  private func flash(_ range: NSRange) {
    guard let stored = storedAttributed?.mutableCopy() as? NSMutableAttributedString,
          range.location + range.length <= stored.length else { return }
    stored.addAttribute(.backgroundColor, value: MarkdownStyle.linkColor.withAlphaComponent(0.18),
                        range: range)
    attributedText = stored
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
      guard let self, let restore = self.storedAttributed else { return }
      self.attributedText = restore
    }
  }
}

// MARK: - 代码 / 表格块

/**
 等宽块：逐行**不换行**，外层横向滚动。

 为什么不换行：代码的缩进和列对齐是它的一半信息，折行会把 `if` 的下一层折到行首。
 代价是长行要横着看——所以必须有横向滚动，而不是裁掉（裁掉就等于内容没了）。

 为什么不换行还能撑得住气泡：每行是**独立的一行标签**（`numberOfLines = 1` + `.byClipping`），
 它们的固有宽度就是文字宽度，滚动视图的内容宽度取最大值。不需要自己量字号宽度。
 */
final class MarkdownCodeBlockView: UIView {
  private let scroll = HorizontalPanScrollView()
  private let lines = UIStackView()
  private var labels: [UILabel] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.showsHorizontalScrollIndicator = true
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceVertical = false
    scroll.layer.cornerRadius = 10
    scroll.layer.cornerCurve = .continuous
    // 标识打在**块视图本身**上：它才是"一个代码块"，测试与 UI 查询都按它找。
    // （内层 `scroll` 是横滚容器，属实现细节；标识留在那儿会让 `MarkdownCodeBlockView`
    // 自己看起来没有标识——2026-09-17 实测：hosted 测试因此红了一条。）
    accessibilityIdentifier = "markdown-code-block"
    addSubview(scroll)

    lines.axis = .vertical
    lines.alignment = .leading
    lines.spacing = 2
    lines.isLayoutMarginsRelativeArrangement = true
    lines.directionalLayoutMargins = .init(top: 10, leading: 12, bottom: 10, trailing: 12)
    lines.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(lines)

    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      lines.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      lines.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      lines.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      lines.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      // 高度由内容决定：滚动视图自己不会因为内容变高，这一步是必须的。
      heightAnchor.constraint(equalTo: lines.heightAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(lines textLines: [String], traits: UITraitCollection) {
    let font = MarkdownStyle.monospaced(.callout)
    let color = MemohPalette.label(traits)
    scroll.backgroundColor = MemohPalette.inset(traits)
    let visible = textLines.isEmpty ? [""] : textLines
    while labels.count < visible.count {
      let label = UILabel()
      label.numberOfLines = 1
      label.lineBreakMode = .byClipping
      label.font = font
      label.adjustsFontForContentSizeCategory = true
      label.setContentCompressionResistancePriority(.required, for: .horizontal)
      label.isAccessibilityElement = false
      labels.append(label)
      lines.addArrangedSubview(label)
    }
    for (index, label) in labels.enumerated() {
      let isVisible = index < visible.count
      label.isHidden = !isVisible
      guard isVisible else { continue }
      // 行首空格是代码的一部分（缩进），不 trim。
      label.text = visible[index].isEmpty ? " " : visible[index]
      label.textColor = color
      label.font = font
    }
  }
}

/**
 横向滚动视图：只在**横向**拖动时接管手势。

 不这么做的话，手指落在代码块上往下拖，列表不滚（手势被内层滚动视图吃掉），
 那比没有滚动更让人恼火。方向不对就把手势让给父滚动视图。
 */
final class HorizontalPanScrollView: UIScrollView, UIGestureRecognizerDelegate {
  override init(frame: CGRect) {
    super.init(frame: frame)
    panGestureRecognizer.delegate = self
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
    let velocity = pan.velocity(in: self)
    return abs(velocity.x) > abs(velocity.y)
  }
}

// MARK: - 分隔线

final class MarkdownRuleView: UIView {
  private let hairline = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    hairline.translatesAutoresizingMaskIntoConstraints = false
    addSubview(hairline)
    NSLayoutConstraint.activate([
      hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
      hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
      hairline.centerYAnchor.constraint(equalTo: centerYAnchor),
      hairline.heightAnchor.constraint(equalToConstant: 1),
      heightAnchor.constraint(equalToConstant: 13),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(traits: UITraitCollection) {
    hairline.backgroundColor = MemohPalette.separator(traits)
  }
}
