import UIKit

// Shared bubble geometry and accessibility; each reuse type owns its presentation.
class MessageBlockCell: UICollectionViewCell {
  let body = UILabel()
  let heading = UILabel()
  let symbol = UIImageView()
  let stack = UIStackView()
  let header = UIStackView()
  var headingTextStyle: UIFont.TextStyle { .headline }
  private var leading: NSLayoutConstraint!
  private var userWidth: NSLayoutConstraint!
  private var user = false
  /**
   活动行（工具/思考）相对正文的**左内缩**。

   对齐 lody-ios 的 `ChatCell.leading`：正文（text）贴左 0，活动行（thought/
   tool）缩进后相对屏幕约 24pt。本列表的 section inset 已是 16，所以 cell 内
   加 8pt 即可。正文 16 / 活动 24 的错位让「工具与思考属于这轮 agent 的干活
   过程、正文是它的结论」一眼可读（R2 评审第 2 项）。
   */
  var leadingInset: CGFloat = 0 {
    didSet { leading?.constant = leadingInset }
  }
  private var borderColor: UIColor = .clear

  override init(frame: CGRect) {
    super.init(frame: frame)
    stack.axis = .vertical
    stack.spacing = 10
    stack.isLayoutMarginsRelativeArrangement = true
    stack.layer.cornerRadius = 16
    stack.layer.cornerCurve = .continuous
    header.axis = .horizontal
    header.alignment = .top
    header.spacing = 8
    symbol.contentMode = .scaleAspectFit
    symbol.setContentHuggingPriority(.required, for: .horizontal)
    symbol.setContentCompressionResistancePriority(.required, for: .horizontal)
    symbol.isAccessibilityElement = false
    header.addArrangedSubview(symbol)
    header.addArrangedSubview(heading)
    style(heading, .headline)
    style(body, .body)
    stack.addArrangedSubview(header)
    stack.addArrangedSubview(body)
    stack.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(stack)
    leading = stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: leadingInset)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: contentView.topAnchor),
      stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor),
    ])
    updateWidth()
    isAccessibilityElement = true
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self,
                            UITraitAccessibilityContrast.self]) {
      (cell: MessageBlockCell, _: UITraitCollection) in
      cell.updateWidth()
      cell.stack.layer.borderColor = cell.borderColor.resolvedColor(with: cell.traitCollection).cgColor
      cell.symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(font: .preferredFont(forTextStyle: cell.headingTextStyle))
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /**
   给 label 上字体与颜色。
   
   `color` 传 `nil` 表示"品牌正文色"——不能把 `MemohPalette.label(traitCollection)`
   写成默认参数，因为默认参数在编译期求值，拿不到当前 trait。
   */
  func style(_ label: UILabel, _ textStyle: UIFont.TextStyle, color: UIColor? = nil) {
    label.font = .preferredFont(forTextStyle: textStyle)
    label.adjustsFontForContentSizeCategory = true
    label.numberOfLines = 0
    label.textColor = color ?? MemohPalette.label(traitCollection)
  }

  private func updateWidth() {
    userWidth?.isActive = false
    let fraction = MessageListMetrics.userWidthFraction(
      accessibilitySize: traitCollection.preferredContentSizeCategory.isAccessibilityCategory)
    userWidth = stack.widthAnchor.constraint(equalTo: contentView.widthAnchor, multiplier: CGFloat(fraction))
    leading.isActive = !user
    userWidth.isActive = user
  }

  /**
   机器活动的容器样式。
   
   ⚠️ 这个表面必须与**用户气泡**不同色。两者同为系统灰时，整屏会变成一片
   同色的板子，没有层级。
   
   现在两者的区分有两层，任一层单独成立：
   
   - **色相**：用户气泡是品牌紫派生的淡紫（`MemohPalette.userBubble`），
     这里的中性下沉面（`MemohPalette.activitySurface`）一点紫都不带；
   - **形态**：用户气泡是实心块，这里是带描边的容器。
   
   用中性下沉面而不是"描边白"，是因为 Memoh 的页面底本身是暖白 `#FAF8F7`，
   卡片白 `#FFFFFF` 与它的差别在手机上几乎看不出来，纯靠描边会显得单薄。
   */
  func card(border: UIColor? = nil) {
    stack.backgroundColor = MessageBlockCell.color(for: MessageListMetrics.activitySurface, traits: traitCollection)
    stack.directionalLayoutMargins = .init(top: 14, leading: 16, bottom: 14, trailing: 16)
    borderColor = border ?? MemohPalette.separator(traitCollection)
    stack.layer.borderWidth = 1
    stack.layer.borderColor = borderColor.resolvedColor(with: traitCollection).cgColor
  }

  /**
   语义表面 → 具体颜色。**唯一**的转换点，两边取值必须不同。
   
   政策在 `SurfaceToken`（Foundation-only），这里只负责把它落到 UIColor。
   */
  static func color(for surface: SurfaceToken, traits: UITraitCollection) -> UIColor {
    switch surface {
    case .secondary: return MemohPalette.userBubble(traits)
    case .tertiary: return MemohPalette.activitySurface(traits)
    }
  }

  func setHeading(_ text: String?, symbol name: String? = nil, color: UIColor? = nil) {
    let color = color ?? MemohPalette.label(traitCollection)
    heading.text = text
    heading.textColor = color
    header.isHidden = text?.isEmpty != false
    symbol.image = name.flatMap { UIImage(systemName: $0) }
    symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(font: .preferredFont(forTextStyle: headingTextStyle))
    symbol.tintColor = color
    symbol.isHidden = name == nil
  }

  func configure(_ row: TranscriptRow) {
    user = row.id.role == "user"
    updateWidth()
    stack.backgroundColor = user ? MessageBlockCell.color(for: MessageListMetrics.userSurface, traits: traitCollection) : .clear
    stack.directionalLayoutMargins = .init(top: 12, leading: 16, bottom: 12, trailing: 16)
    if !user { stack.directionalLayoutMargins = .init(top: 4, leading: 0, bottom: 4, trailing: 0) }
    borderColor = .clear
    stack.layer.borderWidth = 0
    style(body, .body)
    body.lineBreakMode = .byWordWrapping
    body.text = row.block.text
    body.isHidden = body.text?.isEmpty != false
    // 用户气泡上**不写 "You"**。
    //
    // 右对齐 + 一致的实心气泡已经说明"这是你说的"；再贴一个 headline 字号的
    // "You" 只会比你自己写的话还显眼——这是最典型的层级倒挂。iOS 上没有任何
    // 一款像样的聊天客户端这么做（Messages / ChatGPT / Claude 都没有）。
    // 屏幕阅读器仍然会念角色（见 updateAccessibility），信息没有丢，只是不该
    // 在视觉上占那么大位置。
    setHeading(nil)
    accessibilityTraits = .staticText
    accessibilityValue = nil
    accessibilityHint = nil
    accessibilityCustomActions = nil
    accessibilityIdentifier = "message-block-\(row.id.block)"
    updateAccessibility(row, content: [body.text])
  }

  func updateAccessibility(_ row: TranscriptRow, content: [String?]) {
    let roles = ["user": MemohStrings.text("You"), "assistant": MemohStrings.text("Assistant"),
                 "system": MemohStrings.text("System")]
    accessibilityLabel = ([roles[row.id.role]] + content).compactMap { $0 }
      .filter { !$0.isEmpty }.joined(separator: ". ")
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    body.text = nil
    body.numberOfLines = 0
    heading.text = nil
    symbol.image = nil
    accessibilityLabel = nil
    accessibilityValue = nil
    accessibilityHint = nil
    accessibilityIdentifier = nil
    accessibilityCustomActions = nil
  }
}

/**
 助手正文：**Markdown 渲染**。

 ## 为什么正文要解析成 span 再画
 直接把源文本塞进 `UILabel` 的结果 aiden 已经看过了：`# A History of the Internet` 原样上屏、
 看不到层级。渲染管线现在是：`MarkdownDocument`（解析，见 `Markdown.swift`）→ 属性字符串
 （`MarkdownStyle`）→ 每块一个视图（正文 / 等宽代码 / 分隔线）。

 ## 三件事都在这一层收口
 - **流式**：解析带 `tolerant`（只对最后一行），半截语法不闪原始符号；解析是**增量**的，
   追加只重解析最后一个块，前面块的属性字符串也一起复用（`attributedCache`）。
 - **可复制**：长按出菜单、读屏有自定义动作，复制的是**渲染后的纯文本**
   （`MarkdownDocument.plainText`）。
 - **无障碍**：cell 是单个元素，标签是"角色 + 正常句子"（`accessibilityText`，不念 `#`、
   `•`、`---` 这些排版符号）；链接另给自定义动作。

 ## 用户气泡不做 Markdown
 用户敲的就是他要发出去的原文。把 `*`、`_` 当语法吃掉是**改用户的话**——而且用户气泡里
 那些字符更可能是字面意思（`snake_case`、`2*3`）。所以用户文本走"单块纯文本"，与助手
 正文共用同一套视图与复制路径。
 */
final class TextMessageCell: MessageBlockCell {
  /// 复制这条消息。粘贴板、确认反馈、上报事件都归列表管（`NativeMessageList`）。
  var onCopy: ((String) -> Void)?
  /// 打开链接。终态由列表决定（只开 http/https/mailto）。
  var onOpenLink: ((URL) -> Void)?

  private let markdown = UIStackView()
  private var blockViews: [UIView] = []
  private var pool: [MarkdownViewKind: [UIView]] = [:]
  private var attributedCache: [Int: NSAttributedString] = [:]
  private var document: MarkdownDocument?
  private var source: String?
  private var tolerant = false
  private var blockKey: String?
  private var copyText: String?
  private var lastRow: TranscriptRow?
  private var linkActions: [(name: String, destination: String)] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    // 正文由 `markdown` 里的块视图画；基类那个 `body` 标签退役（留着是为了不破坏基类的
    // 布局约束与颜色逻辑，但永远不显示）。
    body.isHidden = true
    markdown.axis = .vertical
    markdown.alignment = .fill
    markdown.spacing = 0
    stack.addArrangedSubview(markdown)
    addInteraction(UIContextMenuInteraction(delegate: self))
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self,
                             UITraitAccessibilityContrast.self]) {
      (cell: TextMessageCell, _: UITraitCollection) in
      // 字号/配色一变，属性字符串全部作废：重画一遍（解析结果还能用，见 `configure`）。
      cell.attributedCache.removeAll()
      guard let row = cell.lastRow else { return }
      cell.configure(row)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func configure(_ row: TranscriptRow) {
    super.configure(row)
    lastRow = row
    body.isHidden = true
    let text = row.block.text ?? ""
    let isAssistant = row.id.role == "assistant"
    let tolerantNow = isAssistant && row.block.streaming == true
    let parsed = isAssistant ? markdownDocument(for: text, tolerant: tolerantNow)
                             : MarkdownDocument.literal(text)
    render(parsed, tolerant: tolerantNow)
    updateAccessibility(row, content: [spokenText(for: row)])
    accessibilityCustomActions = customActions()
  }

  /**
   解析（带增量）。三条前提缺一不可：**还是这条块** + **还是这类解析模式** + **新文本以旧文本
   为前缀**。少了任何一条就是全量重解析——宁可多花一次，也不能拿旧结果拼错。
   */
  private func markdownDocument(for text: String, tolerant next: Bool) -> MarkdownDocument {
    guard let document, let source, blockKey == lastRow?.id.block, tolerant == next,
          text.hasPrefix(source) else {
      return MarkdownDocument.parse(text, tolerantLastLine: next)
    }
    return document.updated(with: text, tolerantLastLine: next)
  }

  private func render(_ next: MarkdownDocument, tolerant nextTolerant: Bool) {
    document = next
    source = next.text
    tolerant = nextTolerant
    blockKey = lastRow?.id.block
    if next.reusedBlocks == 0 {
      attributedCache.removeAll()
    } else {
      attributedCache = attributedCache.filter { $0.key < next.reusedBlocks }
    }
    for (position, block) in next.blocks.enumerated() {
      let kind = MarkdownStyle.viewKind(block)
      let view = view(at: position, kind: kind)
      configure(view, block: block, position: position)
      let previous = position > 0 ? next.blocks[position - 1].kind : nil
      markdown.setCustomSpacing(MarkdownStyle.spacing(previous: previous, next: block.kind), after: view)
    }
    trim(from: next.blocks.count)
    copyText = next.plainText
  }

  private func configure(_ view: UIView, block: MarkdownBlock, position: Int) {
    switch view {
    case let text as MarkdownTextBlockView:
      let attributed = attributedCache[position] ?? MarkdownStyle.attributed(block, traits: traitCollection)
      attributedCache[position] = attributed
      text.configure(block, attributed: attributed, traits: traitCollection)
    case let code as MarkdownCodeBlockView:
      code.configure(lines: block.lines, traits: traitCollection)
    case let rule as MarkdownRuleView:
      rule.configure(traits: traitCollection)
    default:
      break
    }
  }

  private func view(at position: Int, kind: MarkdownViewKind) -> UIView {
    if position < blockViews.count, kindOf(blockViews[position]) == kind { return blockViews[position] }
    let replacement = dequeue(kind)
    if position < blockViews.count {
      let old = blockViews[position]
      markdown.removeArrangedSubview(old)
      old.removeFromSuperview()
      recycle(old)
      blockViews[position] = replacement
      markdown.insertArrangedSubview(replacement, at: position)
    } else {
      blockViews.append(replacement)
      markdown.addArrangedSubview(replacement)
    }
    return replacement
  }

  private func trim(from count: Int) {
    guard blockViews.count > count else { return }
    let extra = Array(blockViews[count...])
    for view in extra {
      markdown.removeArrangedSubview(view)
      view.removeFromSuperview()
    }
    blockViews.removeSubrange(count...)
    for view in extra { recycle(view) }
  }

  private func kindOf(_ view: UIView) -> MarkdownViewKind {
    if view is MarkdownTextBlockView { return .text }
    if view is MarkdownCodeBlockView { return .code }
    return .rule
  }

  private func dequeue(_ kind: MarkdownViewKind) -> UIView {
    if var candidates = pool[kind], let reused = candidates.popLast() {
      pool[kind] = candidates
      return reused
    }
    switch kind {
    case .text:
      let view = MarkdownTextBlockView()
      view.label.onLinkTap = { [weak self] url in self?.onOpenLink?(url) }
      return view
    case .code:
      return MarkdownCodeBlockView()
    case .rule:
      return MarkdownRuleView()
    }
  }

  private func recycle(_ view: UIView) {
    guard blockViews.contains(where: { $0 === view }) == false else { return }
    pool[kindOf(view), default: []].append(view)
  }

  private func spokenText(for row: TranscriptRow) -> String {
    guard row.id.role == "assistant" else { return row.block.text ?? "" }
    return document?.accessibilityText ?? ""
  }

  private func customActions() -> [UIAccessibilityCustomAction]? {
    var actions: [UIAccessibilityCustomAction] = []
    linkActions = []
    if copyText?.isEmpty == false {
      actions.append(UIAccessibilityCustomAction(name: MemohStrings.text("Copy"), target: self,
                                                 selector: #selector(copyMessage)))
    }
    for link in document?.links ?? [] {
      guard MarkdownLinkPolicy.openableURL(link.destination) != nil else { continue }
      let name = "\(MemohStrings.text("Open link")): \(link.text)"
      linkActions.append((name, link.destination))
      actions.append(UIAccessibilityCustomAction(name: name, target: self,
                                                 selector: #selector(openLink(_:))))
    }
    return actions.isEmpty ? nil : actions
  }

  @objc func copyMessage() -> Bool {
    guard let text = copyText, !text.isEmpty else { return false }
    onCopy?(text)
    return true
  }
  @objc private func openLink(_ action: UIAccessibilityCustomAction) -> Bool {
    guard let link = linkActions.first(where: { $0.name == action.name }),
          let url = MarkdownLinkPolicy.openableURL(link.destination) else { return false }
    onOpenLink?(url)
    return true
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    lastRow = nil
    onCopy = nil
    onOpenLink = nil
    // 解析缓存**故意不清**：同一行在流式更新里可能被判为"新 cell 再配置"，
    // 清掉就等于每次全量重解析。键（`blockKey`）不匹配时自然走全量那条路。
  }
}

extension TextMessageCell: UIContextMenuInteractionDelegate {
  /**
   长按出"复制"。

   为什么复制走长按而不是文本选择：正文是 `UILabel`（高度那条路不能动，见 `MarkdownText.swift`），
   没有现成的选择交互；而用户真正要的是"把这条回复拿走"，不是"选中第 3 行到第 7 行"。
   复制的是**渲染后的纯文本**——粘到别处是一段能读的话，不是带 `**` 的源码。
   */
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                              configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard copyText?.isEmpty == false else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      let copy = UIAction(title: MemohStrings.text("Copy"),
                          image: UIImage(systemName: "doc.on.doc")) { _ in
        _ = self?.copyMessage()
      }
      return UIMenu(title: "", children: [copy])
    }
  }
}

final class ReasoningMessageCell: MessageBlockCell {
  let disclosure = UIButton(type: .system)
  var onToggle: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    // 思考是过程不是结论，与工具活动同列缩进。
    leadingInset = MessageListMetrics.activityInset
    var configuration = UIButton.Configuration.plain()
    configuration.contentInsets = .zero
    configuration.imagePadding = 8
    configuration.titleLineBreakMode = .byWordWrapping
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = .preferredFont(forTextStyle: .subheadline)
      return result
    }
    disclosure.configuration = configuration
    disclosure.contentHorizontalAlignment = .leading
    disclosure.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
    disclosure.titleLabel?.adjustsFontForContentSizeCategory = true
    disclosure.titleLabel?.numberOfLines = 0
    disclosure.tintColor = .systemBlue
    let minimumHeight = disclosure.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
    // A hidden arranged subview gets a required zero-height constraint from UIStackView.
    minimumHeight.priority = UILayoutPriority(999)
    minimumHeight.isActive = true
    // The cell is one VoiceOver element; expose the same action as a custom action.
    disclosure.isAccessibilityElement = false
    disclosure.addTarget(self, action: #selector(toggle), for: .touchUpInside)
    stack.addArrangedSubview(disclosure)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func configure(_ row: TranscriptRow) { configure(row, expanded: false) }

  func configure(_ row: TranscriptRow, expanded: Bool) {
    super.configure(row)
    // 没有任何思考内容时**整套 UI 都不出现**：不空占位、不留空盒子、不显示"思考（空）"。
    // 正常路径上这一行根本不会走到这里（`TranscriptDisplayRow.shows` 已经把它去掉了），
    // 这里是第二道闸：cell 被别处直接配置时也不能画出一个空壳。
    let text = (row.block.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      stack.backgroundColor = .clear
      stack.layer.borderWidth = 0
      header.isHidden = true
      body.isHidden = true
      body.text = nil
      disclosure.isHidden = true
      accessibilityLabel = nil
      accessibilityValue = nil
      accessibilityHint = nil
      accessibilityCustomActions = nil
      return
    }
    card()
    // 标题带上时长（`Reasoning · 思考了 3 秒`）：折叠态也要看得见"想了多久"——
    // 什么时候该说、说到什么精度在 `Transcript.swift` 的 `ReasoningDuration`。
    setHeading(row.block.reasoningHeading, symbol: "text.bubble", color: MemohPalette.secondaryLabel(traitCollection))
    style(body, .callout, color: MemohPalette.secondaryLabel(traitCollection))
    body.numberOfLines = MessageListMetrics.reasoningLineLimit(expanded: expanded)
    body.lineBreakMode = .byTruncatingTail
    let action = MemohStrings.text(expanded ? "Collapse reasoning" : "Expand reasoning")
    var configuration = disclosure.configuration
    configuration?.title = action
    configuration?.image = UIImage(systemName: expanded ? "chevron.up" : "chevron.down")
    disclosure.configuration = configuration
    disclosure.isHidden = body.isHidden
    if !body.isHidden {
      accessibilityValue = MemohStrings.text(expanded ? "Expanded" : "Collapsed")
      accessibilityHint = action
      accessibilityCustomActions = [UIAccessibilityCustomAction(name: action, target: self, selector: #selector(toggle))]
    }
    // VoiceOver can read all reasoning even when its visual preview is clipped.
    updateAccessibility(row, content: [heading.text, body.text])
  }

  @objc private func toggle() -> Bool {
    guard let onToggle else { return false }
    onToggle()
    return true
  }

  override func accessibilityActivate() -> Bool { toggle() }

  override func prepareForReuse() {
    super.prepareForReuse()
    onToggle = nil
    body.numberOfLines = MessageListMetrics.reasoningLineLimit(expanded: false)
    var configuration = disclosure.configuration
    configuration?.title = nil
    configuration?.image = nil
    disclosure.configuration = configuration
    disclosure.isHidden = true
  }
}

final class ToolMessageCell: MessageBlockCell {
  let spinner = UIActivityIndicatorView(style: .medium)
  let disclosure = UIButton(type: .system)
  var onToggle: (() -> Void)?
  let detailStack = UIStackView()
  override var headingTextStyle: UIFont.TextStyle { .footnote }

  override init(frame: CGRect) {
    super.init(frame: frame)
    // 活动行缩进（对齐 lody-ios）：工具从属于这轮 agent 的干活过程。
    leadingInset = MessageListMetrics.activityInset
    header.alignment = .center
    style(heading, .footnote, color: MemohPalette.secondaryLabel(traitCollection))
    heading.lineBreakMode = .byWordWrapping
    // Reserve the trailing slot even when stopped: completion must not reflow the text.
    let spinnerSlot = UIView()
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinnerSlot.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinnerSlot.widthAnchor.constraint(equalToConstant: 20),
      spinnerSlot.heightAnchor.constraint(equalToConstant: 20),
      spinner.centerXAnchor.constraint(equalTo: spinnerSlot.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: spinnerSlot.centerYAnchor),
    ])
    spinnerSlot.isAccessibilityElement = false
    spinner.hidesWhenStopped = true
    spinner.isAccessibilityElement = false
    header.addArrangedSubview(spinnerSlot)

    // 展开箭头（详情流）。与 ReasoningMessageCell 同一套模式：cell 是单个
    // VoiceOver 元素，动作通过 custom action 暴露，箭头本身不可聚焦。
    var configuration = UIButton.Configuration.plain()
    configuration.contentInsets = .zero
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote)
    disclosure.configuration = configuration
    disclosure.tintColor = .systemBlue
    disclosure.isAccessibilityElement = false
    disclosure.addTarget(self, action: #selector(toggle), for: .touchUpInside)
    disclosure.setContentHuggingPriority(.required, for: .horizontal)
    header.addArrangedSubview(disclosure)

    // 展开后的详情容器：下沉面 + 圆角（对应上游 Capsule），但**不自己滚动**——
    // 过程体必须跟着主聊天滚动（memoh-desktop-parity.md §4.3）。
    detailStack.axis = .vertical
    detailStack.spacing = 10
    detailStack.isLayoutMarginsRelativeArrangement = true
    detailStack.directionalLayoutMargins = .init(top: 10, leading: 12, bottom: 10, trailing: 12)
    detailStack.layer.cornerRadius = 12
    detailStack.layer.cornerCurve = .continuous
    detailStack.isHidden = true
    stack.addArrangedSubview(detailStack)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func color(
    for foreground: ToolActivityGroup.Foreground, traits: UITraitCollection
  ) -> UIColor {
    switch foreground {
    // 工具活动行是**过程**，用次要文字色——它不是结论，不该和正文抢。
    case .secondary: return MemohPalette.secondaryLabel(traits)
    }
  }

  override func configure(_ row: TranscriptRow) { configure(ToolActivityGroup(row)) }

  func configure(_ group: ToolActivityGroup) { configure(group, expanded: false) }

  func configure(_ group: ToolActivityGroup, expanded: Bool) {
    super.configure(group.first)
    // This is an activity sentence, not a card. No status badge or error-colored detail.
    stack.backgroundColor = .clear
    stack.layer.borderWidth = 0
    stack.directionalLayoutMargins = .init(top: 4, leading: 0, bottom: 4, trailing: 0)
    body.isHidden = true
    let foreground = Self.color(for: group.foreground, traits: traitCollection)
    style(heading, .footnote, color: foreground)
    setHeading(group.text, symbol: group.symbolName, color: foreground)
    spinner.color = foreground
    if group.showsSpinner {
      spinner.startAnimating()
    } else {
      spinner.stopAnimating()
    }

    if group.expandable {
      renderDetail(group)
      detailStack.isHidden = !expanded
      var configuration = disclosure.configuration
      configuration?.image = UIImage(systemName: expanded ? "chevron.up" : "chevron.down")
      disclosure.configuration = configuration
      disclosure.isHidden = false
      let action = MemohStrings.text(expanded ? "Collapse details" : "Expand details")
      accessibilityValue = MemohStrings.text(expanded ? "Expanded" : "Collapsed")
      accessibilityHint = action
      accessibilityCustomActions = [UIAccessibilityCustomAction(name: action, target: self, selector: #selector(toggle))]
    } else {
      detailStack.isHidden = true
      disclosure.isHidden = true
      accessibilityValue = group.showsSpinner ? MemohStrings.text("Running") : nil
      accessibilityHint = nil
      accessibilityCustomActions = nil
    }
    // The first block's identifier stays stable; every member's name (including
    // repeated names) remains available to VoiceOver.
    updateAccessibility(group.first, content: [group.text] + group.accessibilityDescriptions.map { Optional($0) })
  }

  /** 重建展开内容：每个成员一个块（名字 · 位置 · 耗时 / 输入条目 / 诊断）。 */
  private func renderDetail(_ group: ToolActivityGroup) {
    detailStack.backgroundColor = MessageBlockCell.color(for: MessageListMetrics.activitySurface, traits: traitCollection)
    for view in detailStack.arrangedSubviews { view.removeFromSuperview() }
    for row in group.rows {
      detailStack.addArrangedSubview(memberDetail(row))
    }
  }

  private func memberDetail(_ row: TranscriptRow) -> UIStackView {
    let block = row.block
    let container = UIStackView()
    container.axis = .vertical
    container.spacing = 4
    container.alignment = .fill

    // 成员头：名字 · 执行位置 · 耗时（服务端给了才显示，不伪造）。
    var meta = [block.name?.isEmpty == false ? block.name! : MemohStrings.text("Tool")]
    if let location = block.location, !location.isEmpty { meta.append(location) }
    if let durationMs = block.durationMs, durationMs > 0 { meta.append(Self.formatDuration(durationMs)) }
    let metaLabel = UILabel()
    style(metaLabel, .footnote, color: MemohPalette.secondaryLabel(traitCollection))
    metaLabel.text = meta.joined(separator: " · ")
    container.addArrangedSubview(metaLabel)

    // 输入条目：key 次要色 / value 正文色（R2 评审第 3 项，对应上游 generic detail）。
    for entry in block.input?.entries ?? [] {
      container.addArrangedSubview(inputRow(key: entry.key, value: entry.value))
    }

    // 诊断：失败用危险红（标题保持中性——失败不是任务失败，见 ToolResultDiagnosis）。
    let diagnosis = ToolResultDiagnosis.read(block.output)
    if let text = diagnosis.text, !text.isEmpty {
      let color = diagnosis.isError
        ? MemohPalette.destructive(traitCollection)
        : MemohPalette.label(traitCollection)
      container.addArrangedSubview(monoLabel(text, color: color))
    } else if let error = block.error, !error.isEmpty {
      container.addArrangedSubview(monoLabel(error, color: MemohPalette.destructive(traitCollection)))
    }
    return container
  }

  private func inputRow(key: String, value: String) -> UIStackView {
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = 8
    row.alignment = .firstBaseline
    let keyLabel = monoLabel(key, color: MemohPalette.secondaryLabel(traitCollection))
    keyLabel.setContentHuggingPriority(.required, for: .horizontal)
    keyLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    let valueLabel = monoLabel(value, color: MemohPalette.label(traitCollection))
    valueLabel.lineBreakMode = .byCharWrapping
    valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(keyLabel)
    row.addArrangedSubview(valueLabel)
    return row
  }

  private func monoLabel(_ text: String, color: UIColor) -> UILabel {
    let label = UILabel()
    label.font = UIFontMetrics(forTextStyle: .footnote)
      .scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
    label.adjustsFontForContentSizeCategory = true
    label.numberOfLines = 0
    label.textColor = color
    label.text = text
    label.isAccessibilityElement = false
    return label
  }

  static func formatDuration(_ ms: Double) -> String {
    if ms >= 1000 { return String(format: "%.1fs", ms / 1000) }
    return "\(Int(ms))ms"
  }

  @objc private func toggle() -> Bool {
    guard let onToggle else { return false }
    onToggle()
    return true
  }

  override func accessibilityActivate() -> Bool { toggle() }

  override func prepareForReuse() {
    super.prepareForReuse()
    spinner.stopAnimating()
    onToggle = nil
    disclosure.configuration?.image = nil
    disclosure.isHidden = true
    detailStack.isHidden = true
    for view in detailStack.arrangedSubviews { view.removeFromSuperview() }
    accessibilityHint = nil
    accessibilityCustomActions = nil
  }
}

/**
 一条**回合级失败**在消息流里的样子：发生了什么 + 为什么 + （默认收起的技术细节）+ 能做什么。

 改之前那三行每行都错（标题写死 `"Error"`、服务端原文原样上屏、`Error code` 常驻且从不给
 动作），逐条判据在 `docs/research/ios-error-and-feedback.md` §10.3。
 */
final class ErrorMessageCell: MessageBlockCell {
  let disclosure = UIButton(type: .system)
  let action = UIButton(type: .system)
  /**
   动作单独占一行、**贴左、不撑满**（同 `ui/ErrorNotice.tsx` 的 `alignSelf: flex-start`）。
   
   为什么要这一层：`stack` 是 `.fill` 的竖直栈，直接塞进去按钮会被拉成整行宽——那样的
   "重试"抢的注意力比这一屏的任何东西都大，而 HIG 的判据是**反馈的分量要匹配信息的分量**。
   */
  let actionRow = UIStackView()
  let detailStack = UIStackView()
  private let detailLabel = UILabel()
  /** 展开/收起细节。同 reasoning / tool：状态在 list 里，cell 只报告动作。 */
  var onToggle: (() -> Void)?
  /** "再来一次"。由宿主（RN）执行——原生不认识会话，也不知道该重发什么。 */
  var onAction: (() -> Void)?
  private var presentation = ErrorBlockPresentation.read(code: nil, text: nil)
  private var actionEnabled = false

  override init(frame: CGRect) {
    super.init(frame: frame)

    // 展开箭头：与 reasoning / tool 同一套模式（cell 是单个 VoiceOver 元素，动作通过
    // custom action 暴露，箭头本身不可聚焦）。
    var disclosureConfiguration = UIButton.Configuration.plain()
    disclosureConfiguration.contentInsets = .zero
    disclosureConfiguration.imagePadding = 8
    disclosureConfiguration.titleLineBreakMode = .byWordWrapping
    disclosureConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = .preferredFont(forTextStyle: .subheadline)
      return result
    }
    disclosure.configuration = disclosureConfiguration
    disclosure.contentHorizontalAlignment = .leading
    disclosure.titleLabel?.adjustsFontForContentSizeCategory = true
    disclosure.titleLabel?.numberOfLines = 0
    disclosure.tintColor = .systemBlue
    // 断言与验收要用它：卡片在 VoiceOver 里是**一个**元素，控件本身不成为焦点，但它在
    // XCUITest 的视图树里是一个节点（`resource-id` 就是这里的 identifier），所以
    // `errors-chat-*` 那两条 flow 按 id 点/断，而不是按文字——按文字会先匹配到整句话的卡片。
    disclosure.accessibilityIdentifier = "message-error-details"
    // 触控 ≥44pt（Accessibility §Mobility，R49）。隐藏的 arranged subview 会被
    // UIStackView 加一条 required 的零高约束，所以这条要降一级优先级。
    activateMinimumSize(disclosure, height: 44, width: nil)
    disclosure.isAccessibilityElement = false
    disclosure.addTarget(self, action: #selector(toggle), for: .touchUpInside)
    stack.addArrangedSubview(disclosure)

    // 细节容器：与工具卡同一个下沉面 + 圆角，**不自己滚动**（跟着主聊天滚）。
    detailStack.axis = .vertical
    detailStack.isLayoutMarginsRelativeArrangement = true
    detailStack.directionalLayoutMargins = .init(top: 10, leading: 12, bottom: 10, trailing: 12)
    detailStack.layer.cornerRadius = 12
    detailStack.layer.cornerCurve = .continuous
    detailStack.isHidden = true
    detailLabel.font = UIFontMetrics(forTextStyle: .footnote)
      .scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
    detailLabel.adjustsFontForContentSizeCategory = true
    detailLabel.numberOfLines = 0
    detailLabel.lineBreakMode = .byCharWrapping
    detailLabel.isAccessibilityElement = false
    detailStack.addArrangedSubview(detailLabel)
    stack.addArrangedSubview(detailStack)

    // 动作：整块的 44pt 触控目标，不是一行小字链接（同 `ui/ErrorNotice.tsx`）。
    var actionConfiguration = UIButton.Configuration.plain()
    actionConfiguration.contentInsets = .init(top: 10, leading: 16, bottom: 10, trailing: 16)
    actionConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = .preferredFont(forTextStyle: .subheadline)
      return result
    }
    action.configuration = actionConfiguration
    action.tintColor = .systemBlue
    action.layer.borderWidth = 1
    action.layer.cornerRadius = 22
    action.layer.cornerCurve = .continuous
    action.titleLabel?.adjustsFontForContentSizeCategory = true
    action.titleLabel?.numberOfLines = 0
    // 读屏读的是**整块那个节点**（R30/R48）：按钮自己不成为焦点，动作以 custom action
    // 暴露，名字也写进整块的标签里（同 `ui/ErrorNotice.tsx` 的"标题 + 原因 + 动作"）。
    action.isAccessibilityElement = false
    action.accessibilityIdentifier = "message-error-action"
    action.addTarget(self, action: #selector(performAction), for: .touchUpInside)
    activateMinimumSize(action, height: 44, width: 120)
    action.setContentHuggingPriority(.required, for: .horizontal)
    let spacer = UIView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    spacer.isAccessibilityElement = false
    actionRow.axis = .horizontal
    actionRow.alignment = .fill
    actionRow.addArrangedSubview(action)
    actionRow.addArrangedSubview(spacer)
    stack.addArrangedSubview(actionRow)

    registerForTraitChanges([UITraitAccessibilityContrast.self, UITraitUserInterfaceStyle.self]) {
      (cell: ErrorMessageCell, _: UITraitCollection) in
      cell.action.layer.borderColor = MemohPalette.separator(cell.traitCollection).cgColor
      cell.detailStack.backgroundColor = MemohPalette.card(cell.traitCollection)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /** 隐藏时也要保住最小触控尺寸：优先级降到 999，让 UIStackView 的零高约束赢。 */
  private func activateMinimumSize(_ view: UIView, height: CGFloat, width: CGFloat?) {
    let heightConstraint = view.heightAnchor.constraint(greaterThanOrEqualToConstant: height)
    heightConstraint.priority = UILayoutPriority(999)
    heightConstraint.isActive = true
    guard let width else { return }
    let widthConstraint = view.widthAnchor.constraint(greaterThanOrEqualToConstant: width)
    widthConstraint.priority = UILayoutPriority(999)
    widthConstraint.isActive = true
  }

  override func configure(_ row: TranscriptRow) {
    configure(row, expanded: false, actionEnabled: false)
  }

  /**
   - `expanded`：技术细节（类型化 code）是否展开。**默认 false**（R47）。
   - `actionEnabled`：宿主（RN）有没有真的接上"再来一次"。没接上就不显示按钮——
     一个点了没反应的按钮比不给更糟。
   */
  func configure(_ row: TranscriptRow, expanded: Bool, actionEnabled: Bool) {
    super.configure(row)
    self.actionEnabled = actionEnabled
    card(border: MemohPalette.destructive(traitCollection))
    let presentation = ErrorBlockPresentation.read(code: row.block.code, text: row.block.text)
    self.presentation = presentation

    setHeading(presentation.title, symbol: "exclamationmark.octagon.fill",
               color: MemohPalette.destructive(traitCollection))
    // 原因：类型化 code + 非空 message 才是服务端原文，其余是我们的兜底句（R23/R25）。
    style(body, .callout, color: MemohPalette.secondaryLabel(traitCollection))
    body.text = presentation.reason
    body.isHidden = false

    let detail = presentation.detail
    renderDetail(detail)
    detailStack.isHidden = !(expanded && detail != nil)
    let canExpand = detail != nil
    let toggleName = canExpand ? MemohStrings.text(expanded ? "Collapse details" : "Expand details") : nil
    var disclosureConfiguration = disclosure.configuration
    disclosureConfiguration?.title = toggleName
    disclosureConfiguration?.image = canExpand
      ? UIImage(systemName: expanded ? "chevron.up" : "chevron.down") : nil
    disclosure.configuration = disclosureConfiguration
    disclosure.accessibilityLabel = toggleName
    disclosure.isHidden = !canExpand

    // 动作：只有在重试白名单上、且宿主接上了才出现（R19/R45）。
    let showsAction = presentation.showsAction && actionEnabled
    var actionConfiguration = action.configuration
    actionConfiguration?.title = showsAction ? MemohStrings.text("Try again") : nil
    action.configuration = actionConfiguration
    action.isHidden = !showsAction
    // 整行一起收起来：只藏按钮的话这一行会留一条空白（`spacer` 还在）。
    actionRow.isHidden = !showsAction
    action.layer.borderColor = MemohPalette.separator(traitCollection).cgColor

    updateErrorAccessibility(row, presentation: presentation, expanded: expanded, showsAction: showsAction)
  }

  /** 细节 = 类型化 code 本身（一个能拿去查日志的稳定标识），不是服务端原文。 */
  private func renderDetail(_ detail: String?) {
    guard let detail else {
      detailLabel.text = nil
      return
    }
    // ⚠️ 这块的下沉面**不能**用 `activitySurface`：错误卡自己的底就是 `activitySurface`
    //（`card()`），同色叠同色等于没有边界。工具卡能用它，是因为工具那一行本身没有底。
    detailStack.backgroundColor = MemohPalette.card(traitCollection)
    detailLabel.textColor = MemohPalette.secondaryLabel(traitCollection)
    detailLabel.text = MemohStrings.text("Error code") + ": " + detail
  }

  /**
   VoiceOver：**这一整块读成一句**（R30/R48）。

   顺序 = 角色 + 发生了什么 + 为什么 + 技术细节 + 能做什么。技术细节**跟着展开状态走**
   （收起时念不到那个错误码）：读到的和看到的是同一件事，用户不会听到屏幕上没有的东西；
   "还有细节可看"由 `accessibilityValue`（收起/已展开）与 custom action 交代。
   */
  private func updateErrorAccessibility(_ row: TranscriptRow, presentation: ErrorBlockPresentation,
                                        expanded: Bool, showsAction: Bool) {
    var content = [presentation.title, presentation.reason]
    if expanded, let detail = presentation.detail {
      content.append(MemohStrings.text("Error code") + ": " + detail)
    }
    if showsAction { content.append(MemohStrings.text("Try again")) }
    let canExpand = presentation.detail != nil
    let toggleName = canExpand ? MemohStrings.text(expanded ? "Collapse details" : "Expand details") : nil
    accessibilityValue = canExpand ? MemohStrings.text(expanded ? "Expanded" : "Collapsed") : nil
    accessibilityHint = toggleName
    var customActions: [UIAccessibilityCustomAction] = []
    if let toggleName {
      customActions.append(UIAccessibilityCustomAction(name: toggleName, target: self, selector: #selector(toggle)))
    }
    if showsAction {
      customActions.append(UIAccessibilityCustomAction(
        name: MemohStrings.text("Try again"), target: self, selector: #selector(performAction)))
    }
    accessibilityCustomActions = customActions.isEmpty ? nil : customActions
    updateAccessibility(row, content: content)
  }

  /** 双击：有动作就先做动作（标签里已经念过它），否则展开/收起细节。 */
  override func accessibilityActivate() -> Bool {
    if presentation.showsAction, actionEnabled { return performAction() }
    return toggle()
  }

  @objc private func toggle() -> Bool {
    guard presentation.detail != nil, let onToggle else { return false }
    onToggle()
    return true
  }

  @objc private func performAction() -> Bool {
    guard presentation.showsAction, actionEnabled, let onAction else { return false }
    onAction()
    return true
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    onToggle = nil
    onAction = nil
    actionEnabled = false
    presentation = ErrorBlockPresentation.read(code: nil, text: nil)
    var disclosureConfiguration = disclosure.configuration
    disclosureConfiguration?.title = nil
    disclosureConfiguration?.image = nil
    disclosure.configuration = disclosureConfiguration
    disclosure.isHidden = true
    var actionConfiguration = action.configuration
    actionConfiguration?.title = nil
    action.configuration = actionConfiguration
    action.isHidden = true
    actionRow.isHidden = true
    detailStack.isHidden = true
    detailLabel.text = nil
  }
}

final class NoticeMessageCell: MessageBlockCell {
  override func configure(_ row: TranscriptRow) {
    super.configure(row)
    setHeading(MemohStrings.text("Notice"), symbol: "info.circle", color: MemohPalette.secondaryLabel(traitCollection))
    style(body, .callout, color: MemohPalette.secondaryLabel(traitCollection))
    updateAccessibility(row, content: [heading.text, body.text])
  }
}

final class AttachmentsMessageCell: MessageBlockCell {
  private let files = UIStackView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    files.axis = .vertical
    files.spacing = 12
    stack.addArrangedSubview(files)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func clearFiles() {
    for view in files.arrangedSubviews {
      files.removeArrangedSubview(view)
      view.removeFromSuperview()
    }
  }

  override func configure(_ row: TranscriptRow) {
    super.configure(row)
    clearFiles()
    card()
    let items = row.block.items ?? []
    setHeading(MemohStrings.text("Attachments") + " (\(items.count))", symbol: "paperclip")
    body.isHidden = true
    var descriptions: [String?] = [heading.text]
    for item in items {
      let line = UIStackView()
      line.axis = .horizontal
      line.alignment = .top
      line.spacing = 12
      let icon = UIImageView(image: UIImage(systemName: item.symbolName))
      icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(font: .preferredFont(forTextStyle: .title3))
      icon.tintColor = MemohPalette.secondaryLabel(traitCollection)
      icon.contentMode = .scaleAspectFit
      icon.setContentHuggingPriority(.required, for: .horizontal)
      icon.setContentCompressionResistancePriority(.required, for: .horizontal)
      let details = UIStackView()
      details.axis = .vertical
      details.spacing = 4
      let name = UILabel()
      style(name, .body)
      name.text = item.name.isEmpty ? MemohStrings.text("Untitled attachment") : item.name
      let size = UILabel()
      style(size, .subheadline, color: MemohPalette.secondaryLabel(traitCollection))
      size.text = item.formattedSize ?? MemohStrings.text("Size unknown")
      details.addArrangedSubview(name)
      details.addArrangedSubview(size)
      line.addArrangedSubview(icon)
      line.addArrangedSubview(details)
      files.addArrangedSubview(line)
      descriptions.append([name.text, size.text].compactMap { $0 }.joined(separator: ", "))
    }
    files.isHidden = items.isEmpty
    updateAccessibility(row, content: descriptions)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    clearFiles()
  }
}
