import ExpoModulesCore
import SwiftUI
import UIKit

/// 设置页的桥接状态。
///
/// 视图模型由 RN 算好下发（`SettingsContract`）；这里只存它、存主题模式，并把点击转成事件。
@MainActor
private final class SettingsStore: ObservableObject {
  private static let validLocales: Set<String> = ["en", "zh-Hans"]

  @Published var model: SettingsViewModel?
  @Published var mode = "system"

  var onOpenAgentSwitcher: () -> Void = {}
  var onOpenBotSettings: () -> Void = {}
  var onOpenAppearance: () -> Void = {}
  var onSelectLocale: (String) -> Void = { _ in }
  var onOpenNotifications: () -> Void = {}
  var onSignOut: () -> Void = {}

  var title: String { model?.title ?? "" }
  var signOutTitle: String { model?.account.signOutTitle ?? "" }
  var signOutMessage: String { model?.account.signOutMessage ?? "" }
  var cancelLabel: String { model?.account.cancelLabel ?? "" }
  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var formBackground: Color { MemohAppearanceMode.formBackground(mode) }

  func selectLocale(_ locale: String) {
    guard Self.validLocales.contains(locale) else { return }
    onSelectLocale(locale)
  }
}

/// 一行可点的设置项：标题 + 右侧值 + 系统 chevron。
///
/// 用 `Button` 而不是 `LabeledContent`：整行都要能点，行高由 `Form` 保证（≥44pt，HIG 的下限）。
private struct DisclosureRow: View {
  let title: String
  let value: String
  let identifier: String
  let action: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if dynamicTypeSize.isAccessibilitySize {
          VStack(alignment: .leading, spacing: 4) {
            Text(title)
            if !value.isEmpty {
              Text(value).foregroundStyle(.secondary)
            }
          }
          Spacer(minLength: 8)
        } else {
          Text(title)
          Spacer(minLength: 8)
          if !value.isEmpty {
            Text(value).foregroundStyle(.secondary)
          }
        }
        Image(systemName: "chevron.forward")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
  }
}

/// 只读的 label/value 行；辅助字号下改为纵排，避免角色或服务器地址被挤窄。
private struct ReadOnlyValueRow: View {
  let label: String
  let value: String

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 4) {
          Text(label)
          Text(value)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      } else {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(label)
          Spacer(minLength: 8)
          Text(value)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

/// 语言选项那一行：右侧勾选标记。语言名一律用**它自己的语言**（RN 已经这样给了）。
private struct SelectionRow: View {
  let label: String
  let selected: Bool
  let identifier: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Text(label)
        Spacer(minLength: 8)
        if selected {
          Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// 状态徽章（圆点 + 文案）。读屏标签由卡片整体给出，所以这里不进无障碍树。
private struct StatusPill: View {
  let label: String
  let color: String

  var body: some View {
    HStack(spacing: 4) {
      Circle().fill(Self.dotColor(color)).frame(width: 6, height: 6)
      Text(label).font(.caption).foregroundStyle(.secondary)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 2)
    .background(Color(uiColor: UIColor { MemohPalette.inset($0) }), in: Capsule())
    .accessibilityHidden(true)
  }

  /// 状态色是封闭集合：用 switch，不用链式三元（`AGENTS.md`）。
  private static func dotColor(_ name: String) -> Color {
    switch name {
    case "success": return Color(uiColor: UIColor { MemohPalette.success($0) })
    case "warning": return Color(uiColor: UIColor { MemohPalette.warning($0) })
    default: return Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) })
    }
  }
}

/// agent 卡片上的头像。
///
/// 画法与 RN `ui/BotAvatar.tsx` 三种情况一一对应，取值来自 RN 归一化后的计划：
/// 远程图 / 内置头像（SF Symbol + 品牌淡底）/ 吉祥物。**不会**为一个 `memoh:` 标识去发请求
/// （RN 已经把它翻成内置头像或吉祥物）。
private struct AgentAvatarView: View {
  let avatar: SettingsViewModel.Avatar

  @State private var remoteFailed = false
  @State private var retriedOnOpen = false
  @State private var attempt = 0

  private static let size: CGFloat = 38

  var body: some View {
    Group {
      switch avatar.kind {
      case .remote: remote
      case .builtin: builtin
      case .mark: mark
      }
    }
    .frame(width: Self.size, height: Self.size)
    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    .accessibilityHidden(true)
    .onChange(of: avatar.uri) {
      remoteFailed = false
      retriedOnOpen = false
      attempt = 0
    }
    .onChange(of: avatar.connectionOpen) { _, isOpen in
      guard isOpen, remoteFailed, !retriedOnOpen else { return }
      remoteFailed = false
      retriedOnOpen = true
      attempt += 1
    }
  }

  @ViewBuilder private var remote: some View {
    if let raw = avatar.uri, let url = URL(string: raw), !remoteFailed {
      AsyncImage(url: url) { phase in
        if let image = phase.image {
          image.resizable().scaledToFill()
        } else if phase.error != nil {
          Color.clear.onAppear { remoteFailed = true }
        } else {
          // 还在加载：中性底。先亮出吉祥物再换成真头像会看起来像“头像变来变去”。
          Color(uiColor: UIColor { MemohPalette.inset($0) })
        }
      }
      .id(attempt)
    } else {
      mark
    }
  }

  private var builtin: some View {
    ZStack {
      Color(uiColor: UIColor { MemohPalette.accentSoft($0) })
      Image(systemName: avatar.symbol ?? "sparkles")
        .font(.system(size: 21))
        .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
    }
  }

  @ViewBuilder private var mark: some View {
    if let image = MemohAssets.image(named: "brand-mark") {
      Image(uiImage: image).resizable().scaledToFill()
    } else {
      // 图片资源缺失时也不画空方块：退回一枚系统图形，至少它是个明确的东西。
      ZStack {
        Color(uiColor: UIColor { MemohPalette.inset($0) })
        Image(systemName: "sparkles")
          .font(.system(size: 21))
          .foregroundStyle(.secondary)
      }
    }
  }
}

/// 卡片内容：头像 + 名字 + 状态 + 副标题 + chevron。整张卡片是一个按钮（"换一个"）。
private struct AgentCardLabel: View {
  let agent: SettingsViewModel.Agent

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AgentAvatarView(avatar: agent.avatar)
      VStack(alignment: .leading, spacing: 2) {
        if dynamicTypeSize.isAccessibilitySize {
          Text(agent.name).font(.headline)
          if !agent.statusLabel.isEmpty {
            StatusPill(label: agent.statusLabel, color: agent.statusColor)
          }
          subtitle
        } else {
          HStack(spacing: 8) {
            Text(agent.name).font(.headline).lineLimit(1)
            if !agent.statusLabel.isEmpty {
              StatusPill(label: agent.statusLabel, color: agent.statusColor)
            }
          }
          subtitle.lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      Image(systemName: "chevron.forward")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }

  @ViewBuilder private var subtitle: some View {
    if !agent.subtitle.isEmpty {
      Text(agent.subtitle)
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }
}

/// 设置列表（系统 inset-grouped `Form`）。
///
/// 分组与顺序由 RN 的视图模型给定：Agent（我是谁 / 换一个）/ Appearance /
/// Language / Notifications（脚注说明边界）/ Account / About。
private struct SettingsFormView: View {
  @ObservedObject var store: SettingsStore
  @State private var confirmingSignOut = false

  var body: some View {
    NavigationStack {
      Form {
        if let model = store.model {
          agentSection(model.agent, botSettingsTitle: model.botSettingsTitle)
          appearanceSection(model.appearance)
          languageSection(model.language)
          notificationsSection(model.notifications)
          accountSection(model.account)
          aboutSection(model.about)
        }
      }
      .scrollContentBackground(.hidden)
      .background(store.formBackground)
      // 这一屏是底部 tab 的根，不是被 push 进来的页——所以**没有返回箭头**。
      // 大标题由系统导航栏画（滚动、Dynamic Type、超大辅助字号下的收缩都归系统管）；
      // RN 那版手动按 `fontScale` 缩字号是为了不让 `Settings` 从单词中间断开，原生大标题
      // 不会断词，所以那一套不再需要。
      .navigationTitle(store.title)
      .alert(store.signOutTitle, isPresented: $confirmingSignOut) {
        Button(store.cancelLabel, role: .cancel) {}
        Button(store.signOutTitle, role: .destructive) { store.onSignOut() }
      } message: {
        Text(store.signOutMessage)
      }
    }
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private func agentSection(
    _ agent: SettingsViewModel.Agent,
    botSettingsTitle: String?
  ) -> some View {
    Section {
      Button {
        store.onOpenAgentSwitcher()
      } label: {
        AgentCardLabel(agent: agent)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("agent-card")
      // 标签里必须带上名字：只念"切换 agent"的话，读屏用户不知道现在是谁。
      .accessibilityLabel(Text(agentLabel(agent)))
      .accessibilityHint(Text(agent.hint))

      // 没有 `manage` 的人不出现这一行：按下必然 403 的入口比不给更糟。
      if let botSettingsTitle {
        DisclosureRow(
          title: botSettingsTitle,
          value: "",
          identifier: "settings-bot-settings"
        ) {
          store.onOpenBotSettings()
        }
      }
    } header: {
      Text(agent.header)
    }
  }

  @ViewBuilder
  private func appearanceSection(_ appearance: SettingsViewModel.Appearance) -> some View {
    Section(appearance.header) {
      DisclosureRow(
        title: appearance.title,
        value: appearance.value,
        identifier: "settings-appearance"
      ) {
        store.onOpenAppearance()
      }
    }
  }

  @ViewBuilder
  private func languageSection(_ language: SettingsViewModel.Language) -> some View {
    Section(language.header) {
      ForEach(language.options, id: \.id) { option in
        SelectionRow(
          label: option.label,
          selected: option.selected,
          identifier: "settings-language-\(option.id)"
        ) {
          store.selectLocale(option.id)
        }
      }
    }
  }

  @ViewBuilder
  private func notificationsSection(_ notifications: SettingsViewModel.Notifications) -> some View {
    // 这一组没有组头：组头写 Notifications、行标题也写 Notifications 读起来像 bug，
    // 所以改用脚注说明它的边界（与 RN 版同一处理）。
    Section {
      DisclosureRow(
        title: notifications.title,
        value: "",
        identifier: "settings-notifications"
      ) {
        store.onOpenNotifications()
      }
    } footer: {
      Text(notifications.footer)
    }
  }

  @ViewBuilder
  private func accountSection(_ account: SettingsViewModel.Account) -> some View {
    Section {
      if !account.name.isEmpty {
        ReadOnlyValueRow(label: account.name, value: account.role)
          .accessibilityIdentifier("settings-account")
      }
      // 登出是破坏性动作：系统红色 + 一个原生确认框（确认后才发事件，RN 再调 signOut）。
      Button(account.signOutTitle, role: .destructive) {
        confirmingSignOut = true
      }
      .accessibilityIdentifier("settings-sign-out")
    } header: {
      Text(account.header)
    }
  }

  @ViewBuilder
  private func aboutSection(_ about: SettingsViewModel.About) -> some View {
    Section {
      if !about.versionValue.isEmpty {
        ReadOnlyValueRow(label: about.versionLabel, value: about.versionValue)
      }
      ReadOnlyValueRow(label: about.serverLabel, value: about.serverValue)
        .accessibilityIdentifier("settings-server")
    } header: {
      Text(about.header)
    }
  }

  private func agentLabel(_ agent: SettingsViewModel.Agent) -> String {
    agent.statusLabel.isEmpty ? agent.name : "\(agent.name), \(agent.statusLabel)"
  }
}

/// 设置页的 Expo 宿主。
///
/// 原生拥有全部可见 UI 与直接交互（列表、agent 卡片、登出确认框）；RN 只留路由、
/// 会话/主题状态与文案。点击一律回成小事件由 RN 决定去哪儿。
final class NativeSettingsView: ExpoView {
  let onOpenAgentSwitcher = EventDispatcher()
  let onOpenBotSettings = EventDispatcher()
  let onOpenAppearance = EventDispatcher()
  let onSelectLocale = EventDispatcher()
  let onOpenNotifications = EventDispatcher()
  let onSignOut = EventDispatcher()

  private let store: SettingsStore
  private let host: MemohSwiftUIHost<SettingsFormView>

  required init(appContext: AppContext? = nil) {
    let store = SettingsStore()
    self.store = store
    host = MemohSwiftUIHost(rootView: SettingsFormView(store: store))
    super.init(appContext: appContext)
    store.onOpenAgentSwitcher = { [weak self] in self?.onOpenAgentSwitcher([:]) }
    store.onOpenBotSettings = { [weak self] in self?.onOpenBotSettings([:]) }
    store.onOpenAppearance = { [weak self] in self?.onOpenAppearance([:]) }
    store.onSelectLocale = { [weak self] locale in self?.onSelectLocale(["locale": locale]) }
    store.onOpenNotifications = { [weak self] in self?.onOpenNotifications([:]) }
    store.onSignOut = { [weak self] in self?.onSignOut([:]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.layout(in: bounds)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    host.updateAttachment(on: self)
  }

  // Expo view props are delivered on the UI queue; the store is @MainActor.
  func setMode(_ value: String) {
    store.mode = MemohAppearanceMode.normalized(value)
    switch store.mode {
    case "light": host.setInterfaceStyle(.light)
    case "dark", "oled": host.setInterfaceStyle(.dark)
    default: host.setInterfaceStyle(.unspecified)
    }
  }

  /// 解析失败就不动界面：宁可停在上一份模型上，也不要画一个半截的列表。
  func setViewModelJSON(_ value: String) {
    guard let decoded = try? SettingsViewModel.decode(value) else { return }
    store.model = decoded
  }
}
