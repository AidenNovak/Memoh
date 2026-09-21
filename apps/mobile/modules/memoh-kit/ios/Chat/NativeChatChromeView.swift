import ExpoModulesCore
import SwiftUI
import UIKit

/// Chat 顶栏（返回 / 标题 / 机器 / 信息）与 notices 横条的桥接状态。
///
/// 模型由 RN 算好下发（`ChatChromeModel`）：这一份只存它、存主题模式，并把点击回成事件。
@MainActor
private final class ChatChromeStore: ObservableObject {
  @Published var model: ChatChromeModel?
  @Published var mode = "system"
  /// 顶部安全区（由宿主从 `safeAreaInsets.top` 传进来）。
  ///
  /// 这一块嵌在 RN 的 flex 布局里、位于屏幕最上方，而 RN 那版 `ChatHeader` 也是自己
  /// `paddingTop: insets.top`——外层没替它让出状态栏，所以原生这一版同样自己让。
  @Published var topInset: CGFloat = 0

  var onBack: () -> Void = {}
  var onOpenInfo: () -> Void = {}
  var onOpenMachine: () -> Void = {}
  var onNoticeAction: (String) -> Void = { _ in }

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }

  /// 解析失败就不动界面：宁可停在上一份有效模型上，也不要把顶栏闪成空白。
  func setModelJSON(_ value: String) {
    guard let decoded = try? ChatChromeModel.decode(value) else { return }
    model = decoded
  }
}

/// 一条横条。
///
/// 可点的那几条（run 失败的重试、断线的重连）整行包成按钮——RN 版也是整行 `Pressable`，
/// 只点文字会让人以为行内空白不能按。不可点的行**不**包按钮：读屏不该在按钮列表里
/// 出现一个按不动的条目。
private struct NoticeRow: View {
  let notice: ChatChromeModel.Notice
  let action: () -> Void

  var body: some View {
    Group {
      if notice.action.isEmpty {
        row
      } else {
        Button(action: action) { row }
          .buttonStyle(.plain)
      }
    }
    // 整条合成一句话：读屏不该把"主行 / 说明 / 动作"分成三段念。
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Text(notice.a11y.isEmpty ? notice.text : notice.a11y))
    .accessibilityIdentifier("chat-notice-\(notice.id)")
  }

  private var row: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(notice.text)
          .font(.footnote)
          .foregroundStyle(mainColor)
          .fixedSize(horizontal: false, vertical: true)
        if !notice.detail.isEmpty {
          Text(notice.detail)
            .font(.caption)
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      if !notice.actionLabel.isEmpty {
        Text(notice.actionLabel)
          .font(.footnote)
          .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
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
    .contentShape(RoundedRectangle(cornerRadius: 12))
  }

  /// 语气色：封闭集合用 switch，不叠三元（`AGENTS.md`）。
  private var mainColor: Color {
    switch notice.tone {
    case "error": return Color(uiColor: UIColor { MemohPalette.destructive($0) })
    default: return Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) })
    }
  }
}

/// 顶栏本体。
///
/// **自绘一行，不用 `NavigationStack` + `.toolbar`**：这一块是嵌在 RN flex 布局里的
/// **条带**，高度要回授给 RN（见文件尾 `reportHeight`）。而 `NavigationStack` 是"填满"型
/// 容器——`sizeThatFits` 在无限高提议下会把提议值当理想高，量出来是个巨大的数，RN 拿到
/// 就把条带撑满整屏（消息区与输入区被挤掉，导航栏里的图标也被裁没）。
/// 2026-09-21 真机验收就是这么发现的（TestFlight build 8）。
///
/// 自绘之后高度是确定的：顶栏一行（≥44pt）+ notices + 顶部安全区。安全区由宿主
/// 从 `safeAreaInsets.top` 传进来（RN 那版 `ChatHeader` 也是自己 `paddingTop: insets.top`，
/// 外层没替它让）。
///
/// 标题仍然可点（点它看会话信息），且**不跟着 `showInfo` 走**——与 RN 版一致，
/// 那一项只管右上角那颗可见入口。
private struct ChatChromePage: View {
  @ObservedObject var store: ChatChromeStore

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      headerRow
      notices
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: UIColor { MemohPalette.card($0) }))
    .overlay(alignment: .bottom) {
      // 与内容区的分界：RN 版是一条 hairline（`ChatHeader` 的 borderBottom）。
      Rectangle()
        .fill(Color(uiColor: UIColor { MemohPalette.separator($0) }))
        .frame(height: 1 / UIScreen.main.scale)
    }
    .preferredColorScheme(store.colorScheme)
  }

  /// 顶栏一行：返回 / 标题（可点）/ 断档提示 / 机器 / 信息。
  ///
  /// 标题那一格 `maxWidth: .infinity` + 截断：RN 版标题是 `flex: 1`，长标题截断而不是
  /// 把右边的图标挤出去——两颗图标必须始终在屏幕上（它们在这一屏没有别的入口）。
  private var headerRow: some View {
    HStack(spacing: 8) {
      backItem
      titleItem
      Spacer(minLength: 8)
      trailingItems
    }
    .padding(.top, store.topInset)
    .padding(.horizontal, 16)
    .frame(minHeight: 44 + store.topInset)
  }

  @ViewBuilder
  private var notices: some View {
    if let model = store.model, !model.notices.isEmpty {
      VStack(spacing: 8) {
        ForEach(model.notices) { notice in
          NoticeRow(notice: notice) { store.onNoticeAction(notice.id) }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private var backItem: some View {
    if let model = store.model {
      Button(action: store.onBack) {
        Image(systemName: "chevron.backward")
      }
      .accessibilityLabel(Text(model.backLabel))
      .accessibilityIdentifier("chat-back")
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
  }

  /// 标题即入口：点它看会话信息（设计基线里"标题可点 = 会话信息"）。
  /// 这与 RN 版一致——它不跟着 `showInfo` 走，那一项只管右上角那颗可见入口。
  ///
  /// 占满剩余宽度并截断（`lineLimit(1)` + `maxWidth: .infinity`）：长标题截断而不是把
  /// 右边的图标挤出屏幕。
  @ViewBuilder
  private var titleItem: some View {
    if let model = store.model {
      Button(action: store.onOpenInfo) {
        VStack(alignment: .leading, spacing: 2) {
          Text(model.title)
            .font(.headline)
            .lineLimit(1)
          if !model.subtitle.isEmpty {
            Text(model.subtitle)
              .font(.caption)
              .foregroundStyle(Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }))
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(model.titleA11y))
      .accessibilityHint(Text(model.titleHint))
      .accessibilityIdentifier("chat-title")
    }
  }

  /// 断档提示 + 两个入口，秩序与 RN 版一致：标题、提示、机器、信息。
  @ViewBuilder
  private var trailingItems: some View {
    if let model = store.model {
      if !model.staleLabel.isEmpty {
        Text(model.staleLabel)
          .font(.caption)
          .foregroundStyle(Color(uiColor: UIColor { MemohPalette.warning($0) }))
      }
      if model.showMachine {
        Button(action: store.onOpenMachine) {
          Image(systemName: "display")
            .font(.system(size: 22))
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
        }
        .accessibilityLabel(Text(model.machineLabel))
        .accessibilityIdentifier("chat-machine")
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
      }
      if model.showInfo {
        Button(action: store.onOpenInfo) {
          Image(systemName: "chart.bar.xaxis")
            .font(.system(size: 22))
            .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
        }
        .accessibilityLabel(Text(model.infoLabel))
        .accessibilityIdentifier("chat-info")
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
      }
    }
  }
}

/// Chat 顶栏 + notices 的 Expo 宿主。
///
/// 与其它原生页不同，这一块**不是**整屏：它嵌在 RN 的 flex 布局里，高度随内容变
/// （notices 增删、Dynamic Type）。Yoga 不会按原生内容给高，所以这里显式把理想高回授给
/// RN（`onHeight`），由 RN 拿去设 style 的高度——见模块 8 设计书 §1.1。
///
/// 宿主是自己手写的（不走 `MemohSwiftUIHost`）：那个助手只负责挂载，量高需要拿到
/// hosting controller 本身，而它是 private 的——所以照 `NativeScheduleView` 那套
/// addChild/addSubview/didMove 自己持有一份。
final class NativeChatChromeView: ExpoView {
  let onBack = EventDispatcher()
  let onOpenInfo = EventDispatcher()
  let onOpenMachine = EventDispatcher()
  let onNoticeAction = EventDispatcher()
  let onHeight = EventDispatcher()

  private let store: ChatChromeStore
  private let host: UIHostingController<ChatChromePage>
  /// 上次报出去的高。初值 -1 保证第一拍一定报：RN 的初值只是量级，由这里校正。
  private var lastHeight: CGFloat = -1

  required init(appContext: AppContext? = nil) {
    let store = ChatChromeStore()
    self.store = store
    host = UIHostingController(rootView: ChatChromePage(store: store))
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    store.onBack = { [weak self] in self?.onBack([:]) }
    store.onOpenInfo = { [weak self] in self?.onOpenInfo([:]) }
    store.onOpenMachine = { [weak self] in self?.onOpenMachine([:]) }
    store.onNoticeAction = { [weak self] id in self?.onNoticeAction(["id": id]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
    syncTopInset()
    reportHeight()
  }

  /// 把 UIKit 的安全区交给 SwiftUI 那一层（顶栏自己让出状态栏，见 store 的注释）。
  private func syncTopInset() {
    let inset = safeAreaInsets.top
    if abs(store.topInset - inset) >= 0.5 {
      store.topInset = inset
    }
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
  ///
  /// ⚠️ **量出 0 是"测量失败"，不是"没有内容"**：2026-09-21 真机验收踩过——当时这一块
  /// 的根视图是 `NavigationStack`，`sizeThatFits` 对它返回 0（不是整屏高），RN 拿到就把
  /// 条带高度设成 0，整个顶栏（返回键、标题、两颗图标）被压没。自绘之后高度是确定的
  /// （实测 103pt @ inset 59），这里再兜一道下限：顶栏永远至少有"安全区 + 一行"。
  private func reportHeight() {
    guard bounds.width > 0 else { return }
    let size = host.sizeThatFits(in: CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    guard size.height.isFinite else { return }
    let height = max(size.height, safeAreaInsets.top + 44)
    guard abs(height - lastHeight) >= 0.5 else { return }
    lastHeight = height
    onHeight(["height": Double(height)])
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
