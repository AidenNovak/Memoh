import ExpoModulesCore
import QuartzCore
import UIKit

private final class MessageCollectionView: UICollectionView {
  var didLayout: (() -> Void)?
  var willAccessibilityScroll: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    #if DEBUG
    // 只加计数：量"每个 apply 之后列表被重新布局了几次"。改的是尺子，不是几何。
    MessageListFrameProbe.shared.recordLayoutPass()
    #endif
    didLayout?()
  }

  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    willAccessibilityScroll?()
    return super.accessibilityScroll(direction)
  }
}

final class NativeMessageList: ExpoView, UICollectionViewDelegate {
  /**
   列表底部**常驻**的余量。政策与判据在 `MessageListMetrics.bottomReserve`（那个文件能进
   测试 bundle，断言写得出来）；这里只负责取出来用。

   Debug 下可以用 `-MemohLegacyBottomOverlay 1` 把它当 0 用（产"改前"截图用，见
   `MessageListFrameProbe.legacyBottomOverlay`）。
   */
  static let bottomReserve = CGFloat(MessageListMetrics.bottomReserve)

  #if DEBUG
  static var legacyBottomOverlay: Bool { MessageListFrameProbe.legacyBottomOverlay }
  #else
  static let legacyBottomOverlay = false
  #endif

  let onReachTop = EventDispatcher()
  /**
   错误块里的"再来一次"。**动作不由原生执行**：原生不认识会话、也不知道该重发什么，
   它只把"哪一条错误块"报上去（`turn` + `block`），由 RN 侧按同一套判据重发那一轮的用户输入。
    */
  let onErrorAction = EventDispatcher()
  /**
   复制成功。**原生侧自己也会确认**（胶囊 + 读屏播报），这条事件是给宿主接
   `chat.message.copied` 那条 RN 文案用的——两个确认不冲突：原生那个贴着内容、
   宿主那个可以走它自己的提示组件。

   `text` 是**渲染后的纯文本**（与粘贴板里的一致），宿主不需要再自己拼。
   */
  let onMessageCopied = EventDispatcher()
  var emptyTitle = "" { didSet { updateEmptyState() } }
  var emptyBody = "" { didSet { updateEmptyState() } }
  /**
   宿主（RN）有没有接上 `onErrorAction`。
   
   没接上就不显示动作按钮：一个点了没反应的按钮比不给动作更糟（判据 R19/R45）。
   场景台（`SceneScreen`）就是这种宿主——它只回放本地帧，没有会话可重发。
   */
  var errorActionEnabled = false {
    didSet {
      guard errorActionEnabled != oldValue else { return }
      // 这个 prop 可能在首帧之后才到；把已有的错误行重新配置一遍，别让它们停在旧状态。
      expansionUpdates.formUnion(rows.keys)
      refreshExpansionIfNeeded()
    }
  }

  private let collection: MessageCollectionView
  private let bottomButton = UIButton(type: .system)
  /**
   复制成功的确认胶囊。

   为什么原生自己确认、不等 RN：确认要**贴着内容**、要跟读屏走，而这两件事原生都知道；
   走一趟 JS 再回来，中间隔着一次 bridge。宿主如果另外还想提示（`chat.message.copied`），
   那走 `onMessageCopied` 事件，两边互不影响。

   `isUserInteractionEnabled = false`：它是通知，不是控件——不能吃掉点击。
   */
  private let copiedBadge = UIButton(type: .system)
  private var copiedBadgeHide: DispatchWorkItem?
  /**
   空态交给系统的 `UIContentUnavailableView`（iOS 17+）。

   改前是自绘的一个 `UILabel`：两级文案（标题 + 正文）被 `"\n\n"` 拼成一段，字号、颜色、
   换行、Dynamic Type、无障碍全靠那几行手写。改成系统视图后**文字层次是系统的**
   （`text` / `secondaryText` 两级），Dynamic Type 与 VoiceOver 也由系统给——正是
   AGENTS.md 那句"系统有现成的东西就用现成的"。文案仍来自 prop 与 `MemohStrings`，没有搬走。
   */
  private let emptyView = UIContentUnavailableView(configuration: UIContentUnavailableConfiguration.empty())
  private var source: UICollectionViewDiffableDataSource<Int, TranscriptRow.ID>!
  private var rows: [TranscriptRow.ID: TranscriptDisplayRow] = [:]
  /**
   每行内容的**指纹**（在后台解码任务里算好，见 `TranscriptPayload`）。

   `changed` 集合靠它算：主线程从"逐行深比较整棵 JSON 树"降到"比 Int"。
   键集合与 `rows` 严丝合缝——两者只在 `apply` 里一起换。
   */
  private var rowHashes: [TranscriptRow.ID: Int] = [:]
  /**
   量测对照开关（仅 Debug）：`true` 时 `changedSet` 走**改动前**那条逐行深比较的路。
   口径与理由见 `MessageListFrameProbe.deepCompareEnabled`；Release 里恒为 `false`。
   */
  #if DEBUG
  private let deepCompare = MessageListFrameProbe.deepCompareEnabled
  #else
  private let deepCompare = false
  #endif
  private var following = true
  private var applying = false
  private var decoding = false
  private var reachedTop = false
  private var pendingJSON: String?
  private var updateScheduled = false
  private var lastSize = CGSize.zero
  private var decodeFailed = false
  private var expansion = ReasoningExpansionState()
  private var toolExpansion = ToolExpansionState()
  private var errorExpansion = ErrorExpansionState()
  private var expansionUpdates = Set<TranscriptRow.ID>()
  private var readingAnchor: (TranscriptRow.ID, CGFloat)?
  private var interactionRevision = 0
  private var restoringAnchor = false
  /** 等下一次 `apply` 收尾后再发布的载荷。连解码耗时一起带着，别把已经量到的数字丢掉。 */
  private struct PendingRows {
    let payload: TranscriptPayload
    let decodeMs: Double
  }
  private var pendingRows: PendingRows?

  required init(appContext: AppContext? = nil) {
    let layout = UICollectionViewCompositionalLayout { _, _ in
      let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(80))
      let item = NSCollectionLayoutItem(layoutSize: size)
      let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
      let section = NSCollectionLayoutSection(group: group)
      section.interGroupSpacing = CGFloat(MessageListMetrics.blockSpacing)
      section.contentInsets = .init(top: 16, leading: 16, bottom: 16, trailing: 16)
      return section
    }
    collection = MessageCollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(appContext: appContext)
    // 品牌页面底（暖白/近黑），不是 iOS 的系统白/黑。
    // 用系统色的话，这个原生列表和它上下的 RN 界面（已用品牌色）会拼成两种温度的白。
    backgroundColor = MemohPalette.background(traitCollection)
    collection.backgroundColor = MemohPalette.background(traitCollection)
    collection.delegate = self
    collection.alwaysBounceVertical = true
    collection.keyboardDismissMode = .interactive
    collection.accessibilityIdentifier = "native-message-list"
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(collection)

    let classes: [BlockKind: MessageBlockCell.Type] = [
      .text: TextMessageCell.self, .reasoning: ReasoningMessageCell.self,
      .tool: ToolMessageCell.self, .error: ErrorMessageCell.self,
      .notice: NoticeMessageCell.self, .attachments: AttachmentsMessageCell.self,
    ]
    for (kind, type) in classes {
      collection.register(type, forCellWithReuseIdentifier: kind.rawValue)
    }
    source = UICollectionViewDiffableDataSource<Int, TranscriptRow.ID>(collectionView: collection) {
      [weak self] collection, path, id in
      guard let self, let row = self.rows[id] else { return nil }
      let cell = collection.dequeueReusableCell(withReuseIdentifier: id.kind.rawValue, for: path)
      if case .tools(let group) = row, let tool = cell as? ToolMessageCell {
        tool.configure(group, expanded: self.toolExpansion.isExpanded(id))
        tool.onToggle = { [weak self] in self?.toggleTool(id) }
      } else if let reasoning = cell as? ReasoningMessageCell {
        reasoning.configure(row.first, expanded: self.expansion.isExpanded(id))
        reasoning.onToggle = { [weak self] in self?.toggleReasoning(id) }
      } else if let error = cell as? ErrorMessageCell {
        error.configure(row.first, expanded: self.errorExpansion.isExpanded(id),
                        actionEnabled: self.errorActionEnabled)
        error.onToggle = { [weak self] in self?.toggleError(id) }
        error.onAction = { [weak self] in self?.requestErrorAction(id) }
      } else if let text = cell as? TextMessageCell {
        text.onCopy = { [weak self] plain in self?.copyToPasteboard(plain, block: id.block) }
        // 链接的终态由列表决定：只开 http/https/mailto（判据在 `MarkdownLinkPolicy.openableURL`，Foundation 那一半）。
        text.onOpenLink = { url in UIApplication.shared.open(url) }
        text.configure(row.first)
      } else {
        (cell as? MessageBlockCell)?.configure(row.first)
      }
      return cell
    }
    // 背景视图挂在 collection 上（与改前同一个挂点）：它只覆盖列表区域，不影响上方 RN 的头部。
    collection.backgroundView = emptyView

    var buttonConfiguration = UIButton.Configuration.filled()
    // 半透明 + 描边：它是一个**浮在内容上**的东西，得让人看出它是浮的，而不是内容的一部分。
    // 真正保证它不盖住正文的是下面那条 contentInset（列表底部常驻 52pt 余量）。
    // 对照模式下换成不透明底，把"改前"那个形态原样复现出来。
    buttonConfiguration.baseBackgroundColor = Self.legacyBottomOverlay
      ? .secondarySystemBackground
      : UIColor.secondarySystemBackground.withAlphaComponent(0.92)
    buttonConfiguration.baseForegroundColor = .systemBlue
    buttonConfiguration.background.strokeColor = MemohPalette.separator(traitCollection)
    buttonConfiguration.background.strokeWidth = 1
    buttonConfiguration.image = UIImage(systemName: "arrow.down")
    buttonConfiguration.title = MemohStrings.text("Back to bottom")
    buttonConfiguration.imagePadding = 8
    buttonConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = .preferredFont(forTextStyle: .subheadline)
      return result
    }
    buttonConfiguration.cornerStyle = .capsule
    bottomButton.configuration = buttonConfiguration
    bottomButton.titleLabel?.adjustsFontForContentSizeCategory = true
    bottomButton.titleLabel?.numberOfLines = 0
    bottomButton.tintColor = .systemBlue
    bottomButton.accessibilityLabel = MemohStrings.text("Back to bottom")
    bottomButton.accessibilityIdentifier = "messages-back-to-bottom"
    bottomButton.addTarget(self, action: #selector(returnToBottom), for: .touchUpInside)
    bottomButton.translatesAutoresizingMaskIntoConstraints = false
    addSubview(bottomButton)
    NSLayoutConstraint.activate([
      bottomButton.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -16),
      bottomButton.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 16),
      bottomButton.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -12),
      bottomButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
      bottomButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
    bottomButton.isHidden = true

    var badgeConfiguration = UIButton.Configuration.filled()
    badgeConfiguration.baseBackgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.94)
    badgeConfiguration.baseForegroundColor = MemohPalette.label(traitCollection)
    badgeConfiguration.background.strokeColor = MemohPalette.separator(traitCollection)
    badgeConfiguration.background.strokeWidth = 1
    badgeConfiguration.cornerStyle = .capsule
    badgeConfiguration.title = MemohStrings.text("Copied")
    badgeConfiguration.contentInsets = .init(top: 8, leading: 16, bottom: 8, trailing: 16)
    badgeConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = .preferredFont(forTextStyle: .subheadline)
      return result
    }
    copiedBadge.configuration = badgeConfiguration
    copiedBadge.titleLabel?.adjustsFontForContentSizeCategory = true
    copiedBadge.titleLabel?.numberOfLines = 0
    copiedBadge.isUserInteractionEnabled = false
    copiedBadge.accessibilityIdentifier = "messages-copy-confirmation"
    copiedBadge.translatesAutoresizingMaskIntoConstraints = false
    addSubview(copiedBadge)
    NSLayoutConstraint.activate([
      copiedBadge.centerXAnchor.constraint(equalTo: safeAreaLayoutGuide.centerXAnchor),
      copiedBadge.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 16),
      copiedBadge.bottomAnchor.constraint(equalTo: bottomButton.topAnchor, constant: -8),
    ])
    copiedBadge.isHidden = true
    copiedBadge.alpha = 0
    // 列表底部常驻的余量：回底按钮与复制确认都住在这块余量里，谁也压不到正文。
    //
    // 为什么常驻而不是"按钮出现时再加"：inset 一变，贴底时的偏移跟着变，用户点完
    // "回到底部"内容会自己再跳一下。常驻的代价只是每个会话底部多一段空白。
    //
    // `MemohLegacyBottomOverlay`（仅 Debug）把这条余量关掉，用来产"改前"那张截图：
    // 同一个二进制、同一份内容，只差这一个数字。
    collection.contentInset.bottom = Self.legacyBottomOverlay ? 0 : NativeMessageList.bottomReserve
    collection.didLayout = { [weak self] in
      guard let self, !self.applying, !self.isInteracting else { return }
      // Estimated heights settle over more than one layout pass, especially on first load.
      if self.following { self.pinBottom() } else { self.restoreReadingAnchor() }
    }
    collection.willAccessibilityScroll = { [weak self] in self?.beginReading() }
    #if DEBUG
    // 逐帧几何探针（仅 Debug，且要启动参数打开）。口径、用途与"为什么不用 Instruments"
    // 见 MessageListFrameProbe；关掉时探针每一处都是早返回，这个闭包根本不会被调。
    MessageListFrameProbe.shared.attach(collection: collection) { [weak self] in
      guard let self else {
        // `rows: -1` 是"宿主没了"的哨兵：探针据此停采，而不是继续记一堆零。
        return MessageListProbeMetrics(
          offsetY: 0, contentHeight: 0, viewportHeight: 0, gap: 0, firstVisibleIndex: -1,
          firstVisibleTop: 0, rows: -1, following: false, dragging: false, decelerating: false,
          tracking: false)
      }
      return self.probeMetrics()
    }
    #endif
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
      (view: NativeMessageList, _: UITraitCollection) in
      #if DEBUG
      MessageListFrameProbe.shared.recordInvalidation()
      #endif
      view.collection.collectionViewLayout.invalidateLayout()
      view.bottomButton.setNeedsUpdateConfiguration()
      view.setNeedsLayout()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    collection.frame = bounds
    if lastSize != bounds.size {
      lastSize = bounds.size
      #if DEBUG
      MessageListFrameProbe.shared.recordInvalidation()
      #endif
      collection.collectionViewLayout.invalidateLayout()
      collection.layoutIfNeeded()
      if following { pinBottom() }
    }
  }

  // Expo view props are delivered on the UI queue. Collapse bursts before decoding/applying.
  func setTurnsJSON(_ json: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    pendingJSON = json
    scheduleUpdate()
  }

  private func scheduleUpdate() {
    guard !updateScheduled, !applying, !decoding, pendingJSON != nil else { return }
    updateScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 30.0) { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      guard let json = self.pendingJSON else { return }
      self.pendingJSON = nil
      self.decoding = true
      // 解码这件事的优先级是 `userInitiated`（与改前 `Task.detached(priority:)` 逐字一致）——
      // 现在它写在**包住解码的那个任务**上，由 `@concurrent` 的函数继承下去。见 `decodeTranscript`。
      Task(priority: .userInitiated) { @MainActor [weak self] in
        // 解码往返（排队 + 后台解析 + 取回）也算一次追加的花费：整份转录越大越贵，
        // 这是「每个 token 的成本是 O(整份转录)」在原生这一侧的可见部分。
        let decodeStarted = CACurrentMediaTime()
        let result = await Self.decodeTranscript(json)
        let decodeMs = (CACurrentMediaTime() - decodeStarted) * 1000
        guard let self else { return }
        self.decoding = false
        // Publish this completed frame even if newer JSON is waiting; otherwise a busy
        // long transcript could starve rendering indefinitely.
        switch result {
        case .success(let payload):
          self.decodeFailed = false
          self.apply(payload, decodeMs: decodeMs)
        case .failure:
          // Keep the last valid transcript; never log potentially private message data.
          self.decodeFailed = true
        }
        self.updateEmptyState()
        self.scheduleUpdate()
      }
    }
  }

  /**
   在**并发执行器**上解码整份转录（不在主线程）。

   为什么不是 `Task.detached`：`detached` 的字面意思就是"这件事与父任务无关"——它**丢掉**
   父任务的优先级与取消传播。改前这两件事靠调用处再写一遍（`priority: .userInitiated`），
   一旦上层将来要取消这一趟解码（会话切走、模块卸载），取消传不进来、旧任务照样把整份转录取回；
   优先级也只能靠"每个 `detached` 处都记得写"。

   `@concurrent` 换的只是**执行器**（照样跑在并发执行器上、不占主线程），但优先级与取消都
   沿着任务树走：上面那个 `Task(priority: .userInitiated)` 就是"这一趟解码的优先级"，
   现在只写在**一处**。

   诚实的一句：**今天这两者在行为上没有可观测差别**——包住它的那个任务现在没有任何人会取消。
   改的是"将来会不会因为这个断开的链踩坑"，不是当下省了什么。
   */
  @concurrent
  private static func decodeTranscript(_ json: String) async -> Result<TranscriptPayload, Error> {
    Result { try TranscriptPayload.decode(json) }
  }

  /**
   这一帧要 reconfigure 哪些行（`apply` 的同步段里最贵的那一步的**入口**）。

   两条路：

   - 默认（改动后）：只比 `Int`——内容变没变由后台解码任务算好的指纹回答
     （口径与碰撞的代价写在 `TranscriptPayload`）。
   - 量测对照（`MemohFrameProbeDeepCompare`，仅 Debug）：**逐行深比较**整棵 JSON 树，
     也就是改动前那一行**原样**。留着它是为了"同一个二进制、同一个场景"下能拿到配对数字
     （见 `MessageListFrameProbe.deepCompareEnabled`）。

   两者的**语义必须一致**：只有展开状态变更（`expansionUpdates`）时内容没变也要 reconfigure，
   首次出现的行走 insert 不算 changed——`pnpm ios:test:swift` 那条 `testChangedSetKeepsTheOldDeepCompareSemantics` 钉的就是这个。
   */
  private func changedSet(ids: [TranscriptRow.ID],
                          next: [TranscriptRow.ID: TranscriptDisplayRow],
                          hashes: [TranscriptRow.ID: Int]) -> [TranscriptRow.ID] {
    #if DEBUG
    if deepCompare {
      return ids.filter { rows[$0] != nil && (rows[$0] != next[$0] || expansionUpdates.contains($0)) }
    }
    #endif
    return TranscriptDiff.changedIDs(ids: ids, previous: rowHashes, next: hashes,
                                     expansionUpdates: expansionUpdates)
  }

  private func apply(_ payload: TranscriptPayload, decodeMs: Double = 0) {
    // A decode can finish while a disclosure-triggered snapshot is still applying.
    guard !applying else { pendingRows = PendingRows(payload: payload, decodeMs: decodeMs); return }
    // 同步段从这里算起：建行表 + 变更集合 + 组装快照。这是"每个 token 在主线程上的单价"。
    let applyStarted = CACurrentMediaTime()
    let old = source.snapshot()
    let incoming = payload.rows
    let hashes = payload.hashes
    let ids = incoming.map(\.id)
    let next = Dictionary(uniqueKeysWithValues: incoming.map { ($0.id, $0) })
    expansionUpdates.formIntersection(ids)
    let changed = changedSet(ids: ids, next: next, hashes: hashes)
    guard old.itemIdentifiers != ids || !changed.isEmpty else { return }
    let previousIds = Set(old.itemIdentifiers)
    let added = ids.filter { !previousIds.contains($0) }.count
    let anchor = visibleAnchor()
    let revision = interactionRevision
    expansion.retain(ids)
    toolExpansion.retain(ids)
    // 错误块的展开状态**不参与** retain：见 `ErrorExpansionState` 的说明（实测它会因为
    // 实时投影与 REST 历史之间短暂缺块而被丢掉，用户刚点开的细节会自己合上）。
    expansionUpdates.removeAll()
    readingAnchor = nil
    rows = next
    rowHashes = hashes
    var snapshot = NSDiffableDataSourceSnapshot<Int, TranscriptRow.ID>()
    snapshot.appendSections([0])
    snapshot.appendItems(ids)
    snapshot.reconfigureItems(changed)
    applying = true
    // 同步段到此为止（`source.apply` 只是提交，diff 与布局在后面的 runloop 上）。
    let applyMs = (CACurrentMediaTime() - applyStarted) * 1000
    // No reloadData and no insertion/height animations on streaming updates.
    source.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self else { return }
      self.collection.layoutIfNeeded()
      if self.following {
        self.pinBottom()
      } else if MessageListMetrics.canRestoreAnchor(capturedRevision: revision,
                  currentRevision: self.interactionRevision, isInteracting: self.isInteracting) {
        // Never restore an anchor captured before a new user gesture or disclosure action.
        self.readingAnchor = anchor
        self.restoreReadingAnchor()
      }
      self.applying = false
      self.updateBottomButton()
      #if DEBUG
      MessageListFrameProbe.shared.recordApply(
        rows: ids.count, added: added, changed: changed.count,
        offsetY: Double(self.collection.contentOffset.y),
        contentHeight: Double(self.collection.contentSize.height),
        gap: Double(self.bottomOffset - self.collection.contentOffset.y),
        applyMs: applyMs, decodeMs: decodeMs)
      // 一次性（只报一次）：系统对滚动边缘到底做了什么。见 recordEdgeState 的说明。
      MessageListFrameProbe.shared.recordEdgeState(self.collection)
      #endif
      if let pending = self.pendingRows {
        self.pendingRows = nil
        self.apply(pending.payload, decodeMs: pending.decodeMs)
      } else {
        self.refreshExpansionIfNeeded()
      }
      self.scheduleUpdate()
    }
  }

  /**
   复制一条消息：粘贴板 + 原生确认 + 上报宿主。

   顺序有意为之：**先落粘贴板**（这是用户要的结果），再做确认与上报。确认或上报出问题
   都不能让"复制"这件事本身失败。

   确认与上报都带上**渲染后的纯文本**（`MarkdownDocument.plainText`）：粘出去的是能读的话，
   不是带 `**` 的源码；宿主也不需要自己去理解 Markdown。
   */
  private func copyToPasteboard(_ text: String, block: String) {
    guard !text.isEmpty else { return }
    UIPasteboard.general.string = text
    showCopiedBadge()
    // 读屏用户看不到胶囊：播报一次，让"复制成功"这件事也被听见。
    UIAccessibility.post(notification: .announcement, argument: MemohStrings.text("Copied"))
    onMessageCopied(["block": block, "text": text])
  }

  private func showCopiedBadge() {
    copiedBadgeHide?.cancel()
    copiedBadge.isHidden = false
    copiedBadge.alpha = 0
    UIView.animate(withDuration: 0.15) { [weak self] in self?.copiedBadge.alpha = 1 }
    let hide = DispatchWorkItem { [weak self] in
      guard let self else { return }
      UIView.animate(withDuration: 0.2) { self.copiedBadge.alpha = 0 } completion: { _ in
        self.copiedBadge.isHidden = true
      }
    }
    copiedBadgeHide = hide
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: hide)
  }

  private func toggleReasoning(_ id: TranscriptRow.ID) {
    guard rows[id]?.id.kind == .reasoning else { return }
    // Expanding content is an explicit reading action, even if the list was following.
    beginReading()
    expansion.toggle(id)
    expansionUpdates.insert(id)
    refreshExpansionIfNeeded()
  }

  private func toggleTool(_ id: TranscriptRow.ID) {
    guard rows[id]?.id.kind == .tool else { return }
    // 展开/收起工具详情是显式阅读动作，即使列表正在跟随也要停。
    beginReading()
    toolExpansion.toggle(id)
    expansionUpdates.insert(id)
    refreshExpansionIfNeeded()
  }

  private func toggleError(_ id: TranscriptRow.ID) {
    guard rows[id]?.id.kind == .error else { return }
    // 展开错误的技术细节同样是显式阅读动作（详情不该在用户没看时自己弹出来）。
    beginReading()
    errorExpansion.toggle(id)
    expansionUpdates.insert(id)
    refreshExpansionIfNeeded()
  }

  /**
   把"再来一次"报给 RN：哪一条 + **那一轮的用户输入**。
   
   刻意**不** beginReading()：这不是阅读动作，而是一次把新内容送进这一屏的写操作，
   列表继续跟随底部才符合用户预期（与"展开详情"相反）。
   
   正文取"屏幕上这条错误**上方最近的那条用户正文**"，而**不是**按轮次 key 去找：这一屏的行
   可能来自两条投影——已完成的 REST 历史，与当前这一轮的实时流水；实时那条的轮次 key 是
   合成的 `__live__`，与用户那句话所在的轮次**不是一个 key**。2026-09-16 实测：按轮次 key 找时
   原生和 RN 两边都找不到，于是点下去界面毫无反应（错误块是实时那条、用户正文是历史那条）。
   按屏幕顺序往上找，找的就是**用户看到的那件事**。
   */
  private func requestErrorAction(_ id: TranscriptRow.ID) {
    guard rows[id]?.id.kind == .error else { return }
    onErrorAction(["turn": id.turn, "block": id.block, "text": userText(above: id)])
  }

  /** 屏幕上这条错误上方最近的一条用户正文（只取 `text` 块，附件与技能请求随正文重建）。 */
  private func userText(above id: TranscriptRow.ID) -> String {
    let order = source.snapshot().itemIdentifiers
    guard let index = order.firstIndex(of: id), index > 0 else { return "" }
    for candidate in order[..<index].reversed() {
      guard let row = rows[candidate]?.first, row.id.role == "user", row.block.kind == .text else { continue }
      let text = (row.block.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty { return text }
    }
    return ""
  }

  private func refreshExpansionIfNeeded() {
    guard !applying, !expansionUpdates.isEmpty else { return }
    // 展开态重放：行来自当前 `rows`，指纹原样带上（内容没变，只有展开状态变了）。
    apply(TranscriptPayload(rows: source.snapshot().itemIdentifiers.compactMap { rows[$0] },
                            hashes: rowHashes))
  }

  private var isInteracting: Bool {
    collection.isDragging || collection.isDecelerating || collection.isTracking
  }

  private func beginReading() {
    interactionRevision += 1
    following = false
    readingAnchor = nil
    updateBottomButton()
  }

  private func updateBottomButton() {
    bottomButton.isHidden = following || rows.isEmpty
  }

  private func restoreReadingAnchor() {
    guard !restoringAnchor, !isInteracting, let (id, distance) = readingAnchor,
          let path = source.indexPath(for: id),
          let frame = collection.layoutAttributesForItem(at: path)?.frame else { return }
    let offset = CGFloat(MessageListMetrics.anchoredOffset(
      itemTop: Double(frame.minY), distance: Double(distance),
      topInset: Double(collection.adjustedContentInset.top), bottomOffset: Double(bottomOffset)))
    guard abs(collection.contentOffset.y - offset) > 0.5 else { return }
    restoringAnchor = true
    let before = collection.contentOffset.y
    collection.contentOffset.y = offset
    restoringAnchor = false
    #if DEBUG
    MessageListFrameProbe.shared.recordOffsetChange(
      "anchor", from: Double(before), to: Double(offset), distance: Double(distance))
    #endif
  }

  private func visibleAnchor() -> (TranscriptRow.ID, CGFloat)? {
    let paths = collection.indexPathsForVisibleItems.sorted()
    for path in paths {
      if let id = source.itemIdentifier(for: path),
         let frame = collection.layoutAttributesForItem(at: path)?.frame {
        return (id, frame.minY - collection.contentOffset.y)
      }
    }
    return nil
  }

  private var bottomOffset: CGFloat {
    CGFloat(MessageListMetrics.bottomOffset(
      contentHeight: Double(collection.contentSize.height), viewportHeight: Double(collection.bounds.height),
      topInset: Double(collection.adjustedContentInset.top), bottomInset: Double(collection.adjustedContentInset.bottom)))
  }

  private func pinBottom(force: Bool = false) {
    guard force || !isInteracting else { return }
    guard abs(collection.contentOffset.y - bottomOffset) > 0.5 else { return }
    let before = collection.contentOffset.y
    collection.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: false)
    #if DEBUG
    MessageListFrameProbe.shared.recordOffsetChange(
      "pin", from: Double(before), to: Double(bottomOffset))
    #endif
  }

  #if DEBUG
  /**
   每帧被探针读一次的几何。**必须常数时间**：这里每多一次布局，量的就是探针自己了。
   `layoutAttributesForItem` 在布局已到期时是查表，不会触发重排。
   */
  private func probeMetrics() -> MessageListProbeMetrics {
    let path = collection.indexPathsForVisibleItems.sorted().first
    let attributes = path.flatMap { collection.layoutAttributesForItem(at: $0) }
    return MessageListProbeMetrics(
      offsetY: Double(collection.contentOffset.y),
      contentHeight: Double(collection.contentSize.height),
      viewportHeight: Double(collection.bounds.height),
      gap: Double(bottomOffset - collection.contentOffset.y),
      // 只有一个 section，所以 `path.item` 就是快照里的序号——不用再回查 identity。
      firstVisibleIndex: path?.item ?? -1,
      firstVisibleTop: Double((attributes?.frame.minY ?? 0) - collection.contentOffset.y),
      rows: rows.count,
      following: following,
      dragging: collection.isDragging,
      decelerating: collection.isDecelerating,
      tracking: collection.isTracking)
  }
  #endif

  @objc private func returnToBottom() {
    interactionRevision += 1
    readingAnchor = nil
    following = true
    pinBottom(force: true)
    bottomButton.isHidden = true
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    // Disengage immediately so a concurrent stream cannot fight the finger.
    beginReading()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if scrollView.isDragging || scrollView.isDecelerating || scrollView.isTracking {
      // Also process gestures during a diffable update; don't re-engage mid-gesture.
      beginReading()
      let atTop = scrollView.contentOffset.y <= -scrollView.adjustedContentInset.top + 44
      if atTop && !reachedTop && !rows.isEmpty { onReachTop([:]) }
      reachedTop = atTop
    }
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { finishReadingGesture() }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { finishReadingGesture() }

  func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
    beginReading()
    return true
  }

  private func finishReadingGesture() {
    interactionRevision += 1
    following = MessageListMetrics.isNearBottom(offset: Double(collection.contentOffset.y), bottomOffset: Double(bottomOffset))
    readingAnchor = following ? nil : visibleAnchor()
    updateBottomButton()
    if following && !applying { pinBottom() }
  }

  /**
   空态：标题进 `text`、说明进 `secondaryText`（系统的两级），解码失败时只给一行标题。

   改前两段是拼在一段里的（`"\n\n"`）——**层级会变**：系统把标题画成更重的字号、
   说明画成次要色，这正是 HIG 的空态形态（`UIContentUnavailableConfiguration.empty()`）。
   */
  private func updateEmptyState() {
    emptyView.isHidden = !rows.isEmpty
    var configuration = UIContentUnavailableConfiguration.empty()
    if decodeFailed {
      configuration.text = MemohStrings.text("Messages could not be displayed.")
    } else {
      configuration.text = emptyTitle.isEmpty ? nil : emptyTitle
      configuration.secondaryText = emptyBody.isEmpty ? nil : emptyBody
    }
    emptyView.configuration = configuration
  }
}
