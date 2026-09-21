import ExpoModulesCore
import SwiftUI
import UIKit

/// 会话壳的 RN → SwiftUI 模型。RN 仍是 API、分页、i18n 和路由的权威；原生只画模型并回报用户动作。
struct SessionsViewModel: Decodable, Equatable {
  struct Bot: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let statusLabel: String
    let selected: Bool
    /// 头像计划（RN 归一化后下发，画法见 `Support/MemohAvatarView.swift`）。`nil` = 没有
    /// 头像（老模型没这个字段）——按改动前的画法退回系统图标，不会变成空白方块。
    let avatar: MemohAvatarPlan?

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      name = try c.decode(String.self, forKey: .name)
      statusLabel = try c.decode(String.self, forKey: .statusLabel)
      selected = try c.decode(Bool.self, forKey: .selected)
      // `try?`：头像是一行上的附加件，它自己的载荷坏了只该让这一行退回系统图标，
      // 不该让**整份会话模型**解不出来（那会连列表、连接状态一起停在上一次的画面上）。
      avatar = try? c.decodeIfPresent(MemohAvatarPlan.self, forKey: .avatar)
    }

    private enum CodingKeys: String, CodingKey { case id, name, statusLabel, selected, avatar }
  }

  struct HubView: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let symbol: String
    let selected: Bool
  }

  struct Connection: Decodable, Equatable {
    let label: String
    let pendingLabel: String
    let retryHint: String
  }

  struct Activity: Decodable, Equatable, Identifiable {
    let id: String
    let botId: String
    let title: String
    let detail: String
  }

  struct Session: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let updatedLabel: String
    let canFork: Bool
  }

  let title: String
  let newSessionLabel: String
  let newBotLabel: String
  let botMenuLabel: String
  let viewMenuLabel: String
  let searchPlaceholder: String
  let emptyTitle: String
  let emptyBody: String
  let errorTitle: String
  let retryLabel: String
  let loadingLabel: String
  let moreLabel: String
  let moreLoadingLabel: String
  let moreFailedLabel: String
  let windowLabel: String
  let pendingTitle: String
  let activeTitle: String
  let renameLabel: String
  let forkLabel: String
  let actionsHint: String
  let loading: Bool
  let errorMessage: String?
  let retryEnabled: Bool
  let moreState: String
  let connection: Connection?
  let bots: [Bot]
  let views: [HubView]
  let pendingApprovals: [Activity]
  let activeRuns: [Activity]
  let sessions: [Session]

  static func decode(_ json: String) throws -> SessionsViewModel {
    try JSONDecoder().decode(SessionsViewModel.self, from: Data(json.utf8))
  }
}

@MainActor
private final class SessionsStore: ObservableObject {
  @Published var model: SessionsViewModel?
  @Published var mode = "system"

  var onOpenSession: (String, String?) -> Void = { _, _ in }
  var onNewSession: () -> Void = {}
  var onRefresh: () -> Void = {}
  var onLoadMore: () -> Void = {}
  var onSelectBot: (String) -> Void = { _ in }
  var onSelectView: (String) -> Void = { _ in }
  var onSessionAction: (String, String) -> Void = { _, _ in }

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var background: Color { MemohAppearanceMode.formBackground(mode) }

  func setModelJSON(_ value: String) {
    // Keep the last valid model during a transient bridge update; private payloads are never logged.
    guard let decoded = try? SessionsViewModel.decode(value) else { return }
    model = decoded
  }
}

private struct SessionsPageView: View {
  @ObservedObject var store: SessionsStore
  @State private var query = ""

  private var model: SessionsViewModel? { store.model }

  private var filteredSessions: [SessionsViewModel.Session] {
    guard let sessions = model?.sessions else { return [] }
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return sessions }
    return sessions.filter {
      $0.title.localizedCaseInsensitiveContains(needle) ||
        $0.subtitle.localizedCaseInsensitiveContains(needle)
    }
  }

  var body: some View {
    NavigationStack {
      List {
        if let model {
          viewPicker(model)
          connectionSection(model)
          activitySection(title: model.pendingTitle, rows: model.pendingApprovals)
          activitySection(title: model.activeTitle, rows: model.activeRuns)
          contentSection(model)
        } else {
          ProgressView()
            .frame(maxWidth: .infinity, minHeight: 120)
            .accessibilityLabel(Text("Loading"))
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(store.background)
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: model?.searchPlaceholder ?? "")
      .navigationTitle(model?.title ?? "")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          botMenu
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(action: store.onNewSession) {
            Image(systemName: "square.and.pencil")
          }
          .accessibilityLabel(Text(model?.newSessionLabel ?? "New session"))
          .accessibilityIdentifier("sessions-new")
        }
      }
      .refreshable {
        store.onRefresh()
      }
    }
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private func viewPicker(_ model: SessionsViewModel) -> some View {
    if model.views.count > 1 {
      Section {
        Picker(model.viewMenuLabel, selection: Binding(
          get: { model.views.first(where: \.selected)?.id ?? model.views[0].id },
          set: { store.onSelectView($0) }
        )) {
          ForEach(model.views) { view in
            Label(view.label, systemImage: view.symbol).tag(view.id)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("sessions-view-picker")
      }
    }
  }

  @ViewBuilder
  private var botMenu: some View {
    if let model, !model.bots.isEmpty {
      Menu {
        ForEach(model.bots) { bot in
          Button {
            store.onSelectBot(bot.id)
          } label: {
            botMenuItem(bot)
          }
          .accessibilityLabel(Text(bot.name))
          .accessibilityHint(Text(bot.statusLabel))
        }
        Button(model.newBotLabel) { store.onSelectBot("__new__") }
      } label: {
        botMenuLabel(model)
      }
      .accessibilityLabel(Text(model.botMenuLabel))
      .accessibilityIdentifier("sessions-bot-menu")
    }
  }

  /**
   菜单 label（toolbar 上那一颗）：当前选中 agent 的头像。

   尺寸 26 是**工具栏图标位**的尺寸（改动前那颗 `person.crop.circle` 也是这么大）；
   `avatar` 为 nil（老模型）或一个都没选中时退回系统图标——就是改动前的画法。
   */
  @ViewBuilder
  private func botMenuLabel(_ model: SessionsViewModel) -> some View {
    if let selected = model.bots.first(where: \.selected), let avatar = selected.avatar {
      MemohAvatarView(avatar: avatar, size: 26)
    } else {
      Image(systemName: "person.crop.circle")
    }
  }

  /**
   菜单里的一行 agent：头像 + 名字，选中时名字后面跟一颗勾。

   为什么用自定义 label 而不是 `Label(_:systemImage:)`：那颗符号位现在是头像的。勾**没有换**
   （还是 `checkmark`），只是从符号位挪到名字后面——原 RN `BotSwitchPage` 与桌面端 switcher
   的每一行也是"头像 + 名字 + 右侧勾"。`avatar` 为 nil 时行首退回 `person`（改动前的兜底符号），
   勾的位置不变：同一条菜单里每一行的形状因此是一致的。

   与 `Hub/HubChrome.swift` 的 `HubChromeBotMenu` **逐行同款**（同一屏的三个视图 chrome 必须
   长得一样），改这里记得同步那一份。
   */
  private func botMenuItem(_ bot: SessionsViewModel.Bot) -> some View {
    HStack(spacing: 8) {
      botMenuAvatar(bot.avatar)
      Text(bot.name)
      if bot.selected {
        Image(systemName: "checkmark")
          .accessibilityHidden(true)
      }
    }
  }

  /// 菜单行首：有头像计划画真头像（24pt，菜单行的行高比工具栏矮一档），否则退回系统图标。
  @ViewBuilder
  private func botMenuAvatar(_ avatar: MemohAvatarPlan?) -> some View {
    if let avatar {
      MemohAvatarView(avatar: avatar, size: 24)
    } else {
      Image(systemName: "person")
        .accessibilityHidden(true)
    }
  }

  @ViewBuilder
  private func connectionSection(_ model: SessionsViewModel) -> some View {
    if let connection = model.connection {
      Section {
        Button {
          store.onRefresh()
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
              Text(connection.label)
              if !connection.pendingLabel.isEmpty {
                Text(connection.pendingLabel).font(.footnote).foregroundStyle(.secondary)
              }
            }
          }
          .frame(minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text(connection.retryHint))
        .accessibilityIdentifier("sessions-connection")
      }
    }
  }

  @ViewBuilder
  private func activitySection(title: String, rows: [SessionsViewModel.Activity]) -> some View {
    if !rows.isEmpty {
      Section {
        ForEach(rows) { row in
          Button {
            store.onOpenSession(row.id, row.botId)
          } label: {
            HStack(spacing: 8) {
              Circle().fill(.green).frame(width: 7, height: 7)
              VStack(alignment: .leading, spacing: 2) {
                Text(row.title).lineLimit(1)
                if !row.detail.isEmpty { Text(row.detail).font(.footnote).foregroundStyle(.secondary) }
              }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          }
          .buttonStyle(.plain)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("sessions-activity-\(row.id)")
        }
      } header: {
        if !title.isEmpty { Text(title) }
      }
    }
  }

  @ViewBuilder
  private func contentSection(_ model: SessionsViewModel) -> some View {
    if model.loading && model.sessions.isEmpty {
      Section {
        ProgressView(model.loadingLabel)
          .frame(maxWidth: .infinity, minHeight: 100)
      }
    } else if let error = model.errorMessage, model.sessions.isEmpty {
      Section {
        VStack(alignment: .leading, spacing: 8) {
          Text(model.errorTitle).font(.headline)
          Text(error).font(.footnote).foregroundStyle(.secondary)
          if model.retryEnabled {
            Button(model.retryLabel) { store.onRefresh() }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
      }
    } else if filteredSessions.isEmpty {
      Section {
        VStack(spacing: 8) {
          Image(systemName: "bubble.left.and.bubble.right")
            .font(.title2)
            .foregroundStyle(.secondary)
          Text(model.emptyTitle).font(.headline)
          Text(model.emptyBody)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 120)
        .accessibilityElement(children: .combine)
      }
    } else {
      Section {
        ForEach(filteredSessions) { session in
          Button {
            store.onOpenSession(session.id, nil)
          } label: {
            SessionRow(session: session)
          }
          .buttonStyle(.plain)
          .contextMenu {
            Button(model.renameLabel) { store.onSessionAction(session.id, "rename") }
            if session.canFork {
              Button(model.forkLabel) { store.onSessionAction(session.id, "fork") }
            }
          }
          .accessibilityHint(Text(model.actionsHint))
          .accessibilityIdentifier("sessions-row-\(session.id)")
          .task {
            if session.id == filteredSessions.last?.id && query.isEmpty { store.onLoadMore() }
          }
        }
      }
      footer(model)
    }
  }

  @ViewBuilder
  private func footer(_ model: SessionsViewModel) -> some View {
    switch model.moreState {
    case "loading":
      Section { ProgressView(model.moreLoadingLabel).frame(maxWidth: .infinity) }
    case "more", "error":
      Section {
        Button(model.moreState == "error" ? model.moreFailedLabel : model.moreLabel) {
          store.onLoadMore()
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityIdentifier("sessions-load-more")
        Text(model.windowLabel).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
      }
    default:
      EmptyView()
    }
  }
}

private struct SessionRow: View {
  let session: SessionsViewModel.Session

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 3) {
        Text(session.title).lineLimit(1)
        if !session.subtitle.isEmpty {
          Text(session.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      if !session.updatedLabel.isEmpty {
        Text(session.updatedLabel).font(.footnote).foregroundStyle(.secondary)
      }
      Image(systemName: "chevron.forward")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }
    .frame(minHeight: 52)
    .contentShape(Rectangle())
  }
}

/// Expo 宿主：RN 传模型，SwiftUI 持有列表、搜索、菜单、刷新和加载更多等直接交互。
final class NativeSessionsView: ExpoView {
  let onOpenSession = EventDispatcher()
  let onNewSession = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onLoadMore = EventDispatcher()
  let onSelectBot = EventDispatcher()
  let onSelectView = EventDispatcher()
  let onSessionAction = EventDispatcher()

  private let store: SessionsStore
  private let host: UIHostingController<SessionsPageView>

  required init(appContext: AppContext? = nil) {
    let store = SessionsStore()
    self.store = store
    host = UIHostingController(rootView: SessionsPageView(store: store))
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    store.onOpenSession = { [weak self] id, botId in
      var payload: [String: Any] = ["sessionId": id]
      if let botId { payload["botId"] = botId }
      self?.onOpenSession(payload)
    }
    store.onNewSession = { [weak self] in self?.onNewSession([:]) }
    store.onRefresh = { [weak self] in self?.onRefresh([:]) }
    store.onLoadMore = { [weak self] in self?.onLoadMore([:]) }
    store.onSelectBot = { [weak self] id in self?.onSelectBot(["botId": id]) }
    store.onSelectView = { [weak self] id in self?.onSelectView(["view": id]) }
    store.onSessionAction = { [weak self] id, action in
      self?.onSessionAction(["sessionId": id, "action": action])
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
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

  func setMode(_ value: String) {
    store.mode = MemohAppearanceMode.normalized(value)
  }

  func setViewModelJSON(_ value: String) {
    store.setModelJSON(value)
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
