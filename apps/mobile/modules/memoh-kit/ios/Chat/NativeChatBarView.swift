import ExpoModulesCore
import SwiftUI
import UIKit

/// Chat 输入区那一叠条带（队列 / 待发 / 斜杠菜单 / 模型胶囊 / 输入行）的桥接状态。
///
/// 模型由 RN 算好下发（`ChatBarModel`）：这一份只存它、存主题模式，并把每一次击键与点击
/// 回成事件。输入框是**受控**的——草稿的权威副本在 RN，原生只把它画出来。
///
/// 颜色说明：设计书里写的 `field` 对应 `MemohPalette.inset`（与 RN `tokens.ts` 的
/// `field` 同值：暖白档 `#F4F4F4`、暗色档 `#242424`）——`MemohPalette` 里没有叫 field 的
/// 那一档，也不该为它新造一个色值。
@MainActor
private final class ChatBarStore: ObservableObject {
  @Published var model: ChatBarModel?
  @Published var mode = "system"

  var onField: (String) -> Void = { _ in }
  var onSend: () -> Void = {}
  var onStop: () -> Void = {}
  var onPill: () -> Void = {}
  var onQueueRemove: (String) -> Void = { _ in }
  var onQueueSteer: (String) -> Void = { _ in }
  var onPendingAction: (String) -> Void = { _ in }
  var onSlashPick: (String) -> Void = { _ in }
  var onSlashRetry: () -> Void = {}

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }

  /// 解析失败就不动界面：宁可停在上一份有效模型上，也不要把输入框闪成空的。
  func setModelJSON(_ value: String) {
    guard let decoded = try? ChatBarModel.decode(value) else { return }
    model = decoded
  }
}

/// 这一叠条带本体。
///
/// 自上而下五块：队列 → 待发 → 斜杠菜单 → 模型胶囊 → 输入行。每一块自己判"有没有"，
/// 空块整块不画——空容器会白占一行高度，而这一块是钉在输入框上方的，它越长，
/// 正在读的正文被顶掉得越多。
private struct ChatBarPage: View {
  @ObservedObject var store: ChatBarStore
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let model = store.model {
        queueBlock(model)
        pendingBlock(model)
        slashBlock(model)
        pillRow(model)
        inputBlock(model)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .preferredColorScheme(store.colorScheme)
  }

  // MARK: - 队列

  @ViewBuilder
  private func queueBlock(_ model: ChatBarModel) -> some View {
    if let queue = model.queue, !queue.items.isEmpty || !queue.error.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        if !queue.hiddenLabel.isEmpty {
          Text(queue.hiddenLabel)
            .font(.caption2)
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
        }
        ForEach(queue.items) { item in
          queueRow(item)
        }
        // 队列写失败必须说出来：用户以为排上了、实际没有，比报错更坏。
        if !queue.error.isEmpty {
          Text(queue.error)
            .font(.caption2)
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.destructive($0) }))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16)
    }
  }

  private func queueRow(_ item: ChatBarModel.QueueItem) -> some View {
    HStack(alignment: .center, spacing: 8) {
      // 辅助字号下"类别 + 正文 + 两个按钮"挤在一行会把正文压成一条缝：改成纵排
      // （与 `DisclosureRow` 解同一类问题的同一种做法）。
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 2) {
          queueKindLabel(item)
          queueText(item)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        queueKindLabel(item)
        queueText(item)
        Spacer(minLength: 8)
      }
      if item.canSteer {
        Button { store.onQueueSteer(item.id) } label: {
          Text(item.steerLabel)
            .font(.footnote)
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(item.steerLabel))
        .accessibilityIdentifier("chat-queue-steer-\(item.id)")
      }
      // 排队的场景是"agent 还在跑，我先补两句"，最常见的后续动作是**改主意**：
      // 没有删除就得等它跑完再说一句"别管刚才那句"，那更糟。
      Button { store.onQueueRemove(item.id) } label: {
        Text("✕")
          .font(.body)
          .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(item.removeLabel))
      .accessibilityIdentifier("chat-queue-remove-\(item.id)")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(minHeight: 44)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(
      Color(uiColor: UIColor { MemohPalette.inset($0) }),
      in: RoundedRectangle(cornerRadius: 12)
    )
  }

  /// 类别标签（"插队" / "接着发"）：现在就会被看到还是这轮跑完才轮到，是两件事。
  @ViewBuilder
  private func queueKindLabel(_ item: ChatBarModel.QueueItem) -> some View {
    if !item.kindLabel.isEmpty {
      Text(item.kindLabel)
        .font(.caption2)
        .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
        .fixedSize()
    }
  }

  private func queueText(_ item: ChatBarModel.QueueItem) -> some View {
    Text(item.text)
      .font(.footnote)
      .lineLimit(2)
      .fixedSize(horizontal: false, vertical: true)
  }

  // MARK: - 待发

  /// 刚发出去、服务端还没回显的那一句现在在哪儿（等网络 / 等确认 / 没发出去）。
  @ViewBuilder
  private func pendingBlock(_ model: ChatBarModel) -> some View {
    if let pending = model.pending {
      HStack(alignment: .center, spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text(pending.text)
            .font(.footnote)
            // 失败要说"没发出去"的红；等确认是中性灰——两档不能混。
            .foregroundStyle(pending.tone == "error"
              ? Color(uiColor: UIColor { MemohPalette.destructive($0) })
              : Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
            .fixedSize(horizontal: false, vertical: true)
          if !pending.reason.isEmpty {
            Text(pending.reason)
              .font(.caption)
              .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 8)
        // 没动作就不画按钮。`awaiting` 没有动作是有意的：那一帧可能已经进了服务端，
        // 再发一次就是重复一轮——所以判据在 RN，原生只按 action 有没有值画。
        if !pending.action.isEmpty {
          Button { store.onPendingAction(pending.action) } label: {
            Text(pending.actionLabel)
              .font(.footnote)
              .foregroundStyle(pending.tone == "error"
                ? Color(uiColor: UIColor { MemohPalette.destructive($0) })
                : Color(uiColor: UIColor { MemohPalette.accent($0) }))
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(Text(pending.actionLabel))
          // 两个动作的效果不同（重发 / 只接回管子），只念标签会让人以为它们是一回事。
          .accessibilityHint(Text(pending.actionHint))
          .accessibilityIdentifier("chat-pending-action")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(minHeight: 44)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        Color(uiColor: UIColor { MemohPalette.inset($0) }),
        in: RoundedRectangle(cornerRadius: 12)
      )
      .padding(.horizontal, 16)
    }
  }

  // MARK: - 斜杠菜单

  @ViewBuilder
  private func slashBlock(_ model: ChatBarModel) -> some View {
    if let slash = model.slash, !slash.items.isEmpty || !slash.failureTitle.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        if !slash.items.isEmpty {
          ScrollView {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(slash.items) { item in
                slashRow(item)
              }
            }
          }
          // 最多露 4 行，多的滚：这一块越长，正在读的正文被顶掉得越多。
          .frame(maxHeight: 220)
          if !slash.failureTitle.isEmpty { Divider() }
        }
        if !slash.failureTitle.isEmpty {
          slashFailure(slash)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        Color(uiColor: UIColor { MemohPalette.card($0) }),
        in: RoundedRectangle(cornerRadius: 12)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12)
          .strokeBorder(Color(uiColor: UIColor { MemohPalette.separator($0) }), lineWidth: 1)
      )
      .padding(.horizontal, 16)
    }
  }

  private func slashRow(_ item: ChatBarModel.SlashItem) -> some View {
    Button { store.onSlashPick(item.pickName) } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(item.label)
          .font(.subheadline)
          .lineLimit(1)
        if !item.description.isEmpty {
          Text(item.description)
            .font(.caption)
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .padding(.horizontal, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // 主文案 + 说明一起念：只念 `/xxx` 的话，同名前缀的技能分不出来。
    .accessibilityLabel(Text(item.description.isEmpty ? item.label : "\(item.label), \(item.description)"))
    .accessibilityIdentifier("chat-slash-\(item.pickName)")
  }

  /// 技能清单没拉到时的那一块：说清"没拉到 + 为什么 + 能做什么"。
  @ViewBuilder
  private func slashFailure(_ slash: ChatBarModel.Slash) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(slash.failureTitle)
        .font(.footnote)
        .foregroundStyle(Color(uiColor: UIColor { MemohPalette.destructive($0) }))
        .fixedSize(horizontal: false, vertical: true)
      if !slash.failureBody.isEmpty {
        Text(slash.failureBody)
          .font(.caption)
          .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
          .fixedSize(horizontal: false, vertical: true)
      }
      // 只有能重试时 RN 才给 label；凭据失效那种情况这里就是空的。
      if !slash.retryLabel.isEmpty {
        Button { store.onSlashRetry() } label: {
          Text(slash.retryLabel)
            .font(.footnote)
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(slash.retryLabel))
        .accessibilityIdentifier("chat-slash-retry")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  // MARK: - 模型胶囊

  /// 这一轮想用哪个模型。agent 提问期间输入行收起来，这颗胶囊留着。
  @ViewBuilder
  private func pillRow(_ model: ChatBarModel) -> some View {
    if !model.pillLabel.isEmpty {
      Button { store.onPill() } label: {
        Text(model.pillLabel)
          .font(.caption)
          .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
          .lineLimit(1)
          .padding(.horizontal, 12)
          .frame(minHeight: 32)
          .overlay(
            Capsule().strokeBorder(Color(uiColor: UIColor { MemohPalette.separator($0) }), lineWidth: 1)
          )
          .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      // 视觉是 32pt 胶囊，命中区补到 44（HIG 下限）：它很小，误触的代价是"选了不想选的模型"。
      .frame(minHeight: 44)
      .contentShape(Rectangle())
      .accessibilityLabel(Text(model.pillA11y))
      .accessibilityIdentifier("chat-model-pill")
      .padding(.horizontal, 16)
    }
  }

  // MARK: - 输入行

  @ViewBuilder
  private func inputBlock(_ model: ChatBarModel) -> some View {
    if model.inputVisible {
      VStack(alignment: .leading, spacing: 0) {
        // 分隔线通栏：它分的是"输入区"与上面那几块，不是某一块的内部。
        Divider()
        VStack(alignment: .leading, spacing: 8) {
          // 就地一行，不是错误卡片：这里离输入框只有一行，而且用户接着就能再按发送
          // ——它就是"下一步"，不需要再挂一个按钮。
          if !model.sendError.isEmpty {
            Text(model.sendError)
              .font(.caption)
              .foregroundStyle(Color(uiColor: UIColor { MemohPalette.destructive($0) }))
              .fixedSize(horizontal: false, vertical: true)
          }
          HStack(alignment: .bottom, spacing: 8) {
            inputField(model)
            sendButton(model)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
      }
    }
  }

  private func inputField(_ model: ChatBarModel) -> some View {
    TextField(
      // 受控：草稿的权威副本在 RN（与模块 6/7 的表单同一个模式）。
      text: Binding(get: { model.draft }, set: { store.onField($0) }),
      prompt: Text(model.placeholder),
      axis: .vertical,
      label: { EmptyView() }
    )
    .lineLimit(1...5)
    .font(.body)
    .padding(.horizontal, 12)
    // 上下对称的内边距：给单边额外 padding 会让多行时的首行偏移。
    .padding(.vertical, 8)
    // 34pt 起步（与按钮同高），长高了自然变成圆角矩形（半高 17 = 胶囊圆角）。
    .frame(minHeight: 34)
    .background(
      Color(uiColor: UIColor { MemohPalette.inset($0) }),
      in: RoundedRectangle(cornerRadius: 17)
    )
    .accessibilityIdentifier("chat-input")
  }

  /// 发送 / 停止键：形状不变、只换字形，所以中途不会闪。
  private func sendButton(_ model: ChatBarModel) -> some View {
    Button { send(model) } label: {
      Text(model.buttonGlyph)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(buttonForeground(model))
        .frame(width: 34, height: 34)
        .background(buttonBackground(model), in: Circle())
        // 全 App 最常按的一颗按钮：视觉是 34pt 正圆，命中区补到 44（HIG 下限）。
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!model.canSend)
    .accessibilityLabel(Text(model.buttonA11y))
    .accessibilityIdentifier("chat-send")
  }

  /// 这一下是发还是停：只由字形回答——RN 已用 `composerView` 判好，原生不重判一遍。
  private func send(_ model: ChatBarModel) {
    switch model.buttonGlyph {
    case "■": store.onStop()
    default: store.onSend()
    }
  }

  private func buttonBackground(_ model: ChatBarModel) -> Color {
    if model.canSend { return Color(uiColor: UIColor { MemohPalette.accent($0) }) }
    return Color(uiColor: UIColor { MemohPalette.inset($0) })
  }

  private func buttonForeground(_ model: ChatBarModel) -> Color {
    if model.canSend { return Color(uiColor: UIColor { MemohPalette.onAccent($0) }) }
    return Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) })
  }
}

/// Chat 输入区那一叠条带的 Expo 宿主。
///
/// 与 chrome 同族：不是整屏，是嵌在 RN 布局里的条带，高度随内容变（队列增删、输入框
/// 1→5 行、Dynamic Type），所以同样把理想高回授给 RN（`onHeight`，见模块 8 设计书 §1.1）。
/// 宿主也是自己手写的，理由与 `NativeChatChromeView` 相同：量高要拿到 hosting controller。
final class NativeChatBarView: ExpoView {
  let onField = EventDispatcher()
  let onSend = EventDispatcher()
  let onStop = EventDispatcher()
  let onPill = EventDispatcher()
  let onQueueRemove = EventDispatcher()
  let onQueueSteer = EventDispatcher()
  let onPendingAction = EventDispatcher()
  let onSlashPick = EventDispatcher()
  let onSlashRetry = EventDispatcher()
  let onHeight = EventDispatcher()

  private let store: ChatBarStore
  private let host: UIHostingController<ChatBarPage>
  /// 上次报出去的高。初值 -1 保证第一拍一定报：RN 的初值只是量级，由这里校正。
  private var lastHeight: CGFloat = -1

  required init(appContext: AppContext? = nil) {
    let store = ChatBarStore()
    self.store = store
    host = UIHostingController(rootView: ChatBarPage(store: store))
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    store.onField = { [weak self] draft in self?.onField(["draft": draft]) }
    store.onSend = { [weak self] in self?.onSend([:]) }
    store.onStop = { [weak self] in self?.onStop([:]) }
    store.onPill = { [weak self] in self?.onPill([:]) }
    store.onQueueRemove = { [weak self] id in self?.onQueueRemove(["id": id]) }
    store.onQueueSteer = { [weak self] id in self?.onQueueSteer(["id": id]) }
    store.onPendingAction = { [weak self] action in self?.onPendingAction(["action": action]) }
    store.onSlashPick = { [weak self] name in self?.onSlashPick(["name": name]) }
    store.onSlashRetry = { [weak self] in self?.onSlashRetry([:]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
    reportHeight()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, let parent = nearestViewController() else {
      detachHost()
      return
    }
    guard host.parent !== parent || host.view.superview !== self else { return }
    detachHost()
    parent.addChild(host)
    addSubview(host.view)
    host.didMove(toParent: parent)
    host.view.frame = bounds
  }

  // Expo view props are delivered on the UI queue; the store is @MainActor.
  func setMode(_ value: String) {
    store.mode = MemohAppearanceMode.normalized(value)
    switch store.mode {
    case "light": host.overrideUserInterfaceStyle = .light
    case "dark", "oled": host.overrideUserInterfaceStyle = .dark
    default: host.overrideUserInterfaceStyle = .unspecified
    }
  }

  func setModelJSON(_ value: String) {
    store.setModelJSON(value)
    // 模型换过之后 SwiftUI 才重排；等一拍再量，否则量到的还是上一份内容的高度。
    DispatchQueue.main.async { [weak self] in self?.reportHeight() }
  }

  /// 把这一块内容需要的高度报给 RN。
  ///
  /// 差不到 0.5pt 就不报：RN 那边收到事件会 setState，来回抖动会把整屏重排。
  /// 宽度还没出来（≤ 0）时跳过——量不出正确的多行高度。
  private func reportHeight() {
    guard bounds.width > 0 else { return }
    let size = host.sizeThatFits(in: CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    guard size.height.isFinite, abs(size.height - lastHeight) >= 0.5 else { return }
    lastHeight = size.height
    onHeight(["height": Double(size.height)])
  }

  private func detachHost() {
    guard host.parent != nil || host.view.superview != nil else { return }
    host.willMove(toParent: nil)
    host.view.removeFromSuperview()
    host.removeFromParent()
  }

  private func nearestViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return window?.rootViewController
  }
}
