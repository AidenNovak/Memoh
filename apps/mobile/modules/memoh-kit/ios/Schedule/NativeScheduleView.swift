import ExpoModulesCore
import SwiftUI
import UIKit

struct NativeScheduleListModel: Decodable, Equatable {
  struct Row: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let subtitle: String
    let enabled: Bool
    let accessibilityLabel: String
  }

  let status: String
  let title: String
  let loadingLabel: String
  let emptyTitle: String
  let emptyBody: String
  let permissionTitle: String
  let permissionBody: String
  let errorTitle: String
  let errorBody: String
  let retryEnabled: Bool
  let retryLabel: String
  let newLabel: String
  let footer: String
  let timezone: String
  let rows: [Row]
  let toggleEnabled: Bool
  /// Hub 顶层件（大标题 / 视图切换 / agent 菜单 / 连接行 / 新建会话）。
  ///
  /// 可选：独立使用这一页时不下发，此时就是一张纯列表。可选字段在合成的 `init(from:)`
  /// 里就是 `decodeIfPresent`，不带 `hub` 的下发解码照旧成功。
  /// **编辑页不画**这些件——它没有这份模型，也不该有：编辑是"离开列表去做一件事"。
  let hub: HubChromeModel?

  static func decode(_ json: String) throws -> NativeScheduleListModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}

struct NativeScheduleEditorModel: Decodable, Equatable {
  let status: String
  let title: String
  let loadingLabel: String
  let permissionTitle: String
  let permissionBody: String
  let errorTitle: String
  let errorBody: String
  let validationError: String?
  let nameLabel: String
  let descriptionLabel: String
  let commandLabel: String
  let commandPlaceholder: String
  let patternLabel: String
  let enabledLabel: String
  let maxCallsLabel: String
  let maxCallsPlaceholder: String
  let frequencyLabel: String
  let runTargetLabel: String
  let runTargetValue: String
  let executionFooter: String
  let timezone: String
  let nextPreview: String
  let saveLabel: String
  let savingLabel: String
  let deleteLabel: String
  let deleteTitle: String
  let deleteBody: String
  let deleteRunningBody: String
  let deleteConfirmLabel: String
  let cancelLabel: String
  let name: String
  let description: String
  let command: String
  let pattern: String
  let enabled: Bool
  let maxCalls: String

  static func decode(_ json: String) throws -> NativeScheduleEditorModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}

@MainActor
private final class NativeScheduleStore: ObservableObject {
  @Published var listModel: NativeScheduleListModel?
  @Published var editorModel: NativeScheduleEditorModel?
  @Published var mode = "system"
  @Published var editor = false

  var onRefresh: () -> Void = {}
  var onRetry: () -> Void = {}
  var onNew: () -> Void = {}
  var onOpen: (String) -> Void = { _ in }
  var onToggle: (String, Bool) -> Void = { _, _ in }
  var onBack: () -> Void = {}
  var onFieldChange: (String, String) -> Void = { _, _ in }
  var onPatternPicker: () -> Void = {}
  var onEnabledChange: (Bool) -> Void = { _ in }
  var onRunTarget: () -> Void = {}
  var onSave: () -> Void = {}
  var onDelete: () -> Void = {}
  /// Hub 顶层件的四个动作。原生只转发：切视图/切 agent 要不要跳路由、连接怎么重试，
  /// 都是 RN 的判断。
  var onSelectView: (String) -> Void = { _ in }
  var onSelectBot: (String) -> Void = { _ in }
  var onNewSession: () -> Void = {}
  var onRetryConnection: () -> Void = {}

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var background: Color { MemohAppearanceMode.formBackground(mode) }

  func setListJSON(_ value: String) {
    guard let decoded = try? NativeScheduleListModel.decode(value) else { return }
    listModel = decoded
    editor = false
  }

  func setEditorJSON(_ value: String) {
    guard let decoded = try? NativeScheduleEditorModel.decode(value) else { return }
    editorModel = decoded
    editor = true
  }
}

private struct NativeSchedulePage: View {
  @ObservedObject var store: NativeScheduleStore

  var body: some View {
    NavigationStack {
      List {
        if let model = store.listModel {
          // 视图切换与连接行排在内容之前，且**不跟内容状态走**：列表在加载 / 报错 /
          // 无权限时，视图切换器仍是离开这一屏的唯一入口，藏起来等于把人关在里面。
          if let hub = model.hub {
            HubChromePicker(model: hub) { store.onSelectView($0) }
            HubChromeConnectionRow(model: hub, onRetry: store.onRetryConnection)
          }
          listContent(model)
        } else {
          ProgressView().frame(maxWidth: .infinity, minHeight: 140)
            .accessibilityLabel(Text("Loading"))
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(store.background)
      .navigationTitle(pageTitle)
      .toolbar {
        if let hub = store.listModel?.hub {
          ToolbarItem(placement: .topBarLeading) {
            HubChromeBotMenu(model: hub) { store.onSelectBot($0) }
          }
        }
        // 同一根 toolbar 上两颗 `＋`：左起是这一页自己的"新建定时任务"（`schedule-new`，
        // 原样保留），右边是 Hub 的"新建会话"（`hub-new-session`）。
        //
        // 用 ToolbarItemGroup 而不是两个独立的 ToolbarItem：组内按**声明顺序**从左到右排
        //（与 `NativeChatChromeView` 的 trailingItems 同一条约定），分开声明时两者的先后
        // 由系统决定，而"Hub 的 ＋ 在定时任务的 ＋ 右边"是这一屏的硬要求。
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button(action: store.onNew) {
            Image(systemName: "plus")
          }
          .accessibilityLabel(Text(store.listModel?.newLabel ?? "New"))
          .accessibilityIdentifier("schedule-new")
          if let hub = store.listModel?.hub {
            HubChromeNewSessionButton(model: hub, onNewSession: store.onNewSession)
          }
        }
      }
      .refreshable { store.onRefresh() }
    }
    .preferredColorScheme(store.colorScheme)
  }

  /// 大标题：Hub 壳里就是**当前视图名**（RN 下发的 `hub.title`，与 Files / Sessions 同源），
  /// 独立使用时退回这一页自己的标题。
  private var pageTitle: String {
    guard let model = store.listModel else { return "" }
    return model.hub?.title ?? model.title
  }

  @ViewBuilder
  private func listContent(_ model: NativeScheduleListModel) -> some View {
    switch model.status {
    case "permission":
      message(title: model.permissionTitle, body: model.permissionBody)
    case "loading", "idle":
      Section { ProgressView(model.loadingLabel).frame(maxWidth: .infinity, minHeight: 100) }
    case "error":
      message(title: model.errorTitle, body: model.errorBody) {
        if model.retryEnabled {
          Button(model.retryLabel, action: store.onRetry)
            .frame(minHeight: 44, alignment: .leading)
        } else {
          Text(model.retryLabel)
            .frame(minHeight: 44, alignment: .leading)
        }
      }
    case "empty":
      message(title: model.emptyTitle, body: model.emptyBody)
    default:
      Section {
        ForEach(model.rows) { row in
          HStack(spacing: 12) {
            Button { store.onOpen(row.id) } label: {
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 4) {
                Text(row.name).lineLimit(1)
                Text(row.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
              }
              Spacer(minLength: 8)
            }
            .frame(minHeight: 56)
            }
            .buttonStyle(.plain)
            Toggle("", isOn: Binding(
              get: { row.enabled },
              set: { store.onToggle(row.id, $0) }
            ))
            .labelsHidden()
            .disabled(!model.toggleEnabled)
            .frame(minWidth: 51, minHeight: 44)
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel(Text(row.accessibilityLabel))
          .accessibilityIdentifier("schedule-row-\(row.id)")
        }
      }
      if !model.timezone.isEmpty {
        Section { Text(model.timezone).font(.footnote).foregroundStyle(.secondary) }
      }
      Section { Text(model.footer).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity) }
    }
  }

  @ViewBuilder
  private func message<Content: View>(title: String, body: String, @ViewBuilder action: () -> Content = { EmptyView() }) -> some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        Text(title).font(.headline)
        if !body.isEmpty { Text(body).font(.footnote).foregroundStyle(.secondary) }
        action()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 8)
    }
  }
}

private struct NativeScheduleEditorPage: View {
  @ObservedObject var store: NativeScheduleStore
  @State private var showDelete = false

  var body: some View {
    NavigationStack {
      if let model = store.editorModel {
        Form {
          if model.status == "permission" {
            Section { Text(model.permissionTitle).font(.headline); Text(model.permissionBody).font(.footnote).foregroundStyle(.secondary) }
          } else if model.status == "error" {
            Section { Text(model.errorTitle).font(.headline); Text(model.errorBody).font(.footnote).foregroundStyle(.secondary) }
          } else if model.status == "loading" {
            Section {
              ProgressView(model.loadingLabel)
                .frame(maxWidth: .infinity, minHeight: 100)
            }
          } else {
            basics(model)
            frequency(model)
            execution(model)
            if let validation = model.validationError, !validation.isEmpty {
              Section { Text(validation).foregroundStyle(.red).accessibilityIdentifier("schedule-edit-error") }
            }
            Section {
              Button(model.savingLabel.isEmpty ? model.saveLabel : model.savingLabel, action: store.onSave)
                .frame(maxWidth: .infinity, minHeight: 44)
                .disabled(model.status == "saving")
            }
            if !model.deleteLabel.isEmpty {
              Section {
                Button(model.deleteLabel, role: .destructive) { showDelete = true }
                  .frame(maxWidth: .infinity, minHeight: 44)
              }
            }
          }
        }
        .navigationTitle(model.title)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button(action: store.onBack) { Image(systemName: "chevron.backward") }
              .accessibilityLabel(Text(model.cancelLabel))
          }
        }
        .confirmationDialog(model.deleteTitle, isPresented: $showDelete, titleVisibility: .visible) {
          Button(model.deleteConfirmLabel, role: .destructive, action: store.onDelete)
          Button(model.cancelLabel, role: .cancel) {}
        } message: {
          Text(model.deleteBody + (model.deleteRunningBody.isEmpty ? "" : "\n\n" + model.deleteRunningBody))
        }
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private func basics(_ model: NativeScheduleEditorModel) -> some View {
    Section {
      field(model.nameLabel, value: model.name, key: "name", axis: .horizontal)
      field(model.descriptionLabel, value: model.description, key: "description", axis: .vertical)
    } header: { Text(model.nameLabel) }

    Section {
      VStack(alignment: .leading, spacing: 6) {
        Text(model.commandLabel).font(.subheadline).foregroundStyle(.secondary)
        TextEditor(text: Binding(get: { model.command }, set: { store.onFieldChange("command", $0) }))
          .frame(minHeight: 80)
          .overlay(alignment: .topLeading) {
            if model.command.isEmpty { Text(model.commandPlaceholder).foregroundStyle(.tertiary).padding(.top, 8).allowsHitTesting(false) }
          }
          .accessibilityIdentifier("schedule-field-command")
      }
    } footer: { Text(model.executionFooter) }
  }

  @ViewBuilder
  private func frequency(_ model: NativeScheduleEditorModel) -> some View {
    Section {
      Button { store.onPatternPicker() } label: {
        HStack { Text(model.patternLabel); Spacer(); Text(model.pattern).font(.caption.monospaced()).foregroundStyle(.secondary); Image(systemName: "chevron.forward").foregroundStyle(.tertiary) }
          .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
      HStack {
        Text(model.enabledLabel)
        Spacer()
        Toggle(model.enabledLabel, isOn: Binding(get: { model.enabled }, set: store.onEnabledChange))
          .labelsHidden()
      }
      .frame(minHeight: 44)
      HStack {
        Text(model.maxCallsLabel)
        Spacer()
        TextField(model.maxCallsPlaceholder, text: Binding(get: { model.maxCalls }, set: { store.onFieldChange("maxCalls", $0) }))
          .multilineTextAlignment(.trailing)
          .keyboardType(.numberPad)
          .frame(minWidth: 120)
      }
      if !model.nextPreview.isEmpty { Text(model.nextPreview).font(.footnote).foregroundStyle(.secondary) }
      if !model.timezone.isEmpty { Text(model.timezone).font(.footnote).foregroundStyle(.secondary) }
    } header: { Text(model.frequencyLabel) }
  }

  @ViewBuilder
  private func execution(_ model: NativeScheduleEditorModel) -> some View {
    Section {
      Button { store.onRunTarget() } label: {
        HStack { Text(model.runTargetLabel); Spacer(); Text(model.runTargetValue).foregroundStyle(.secondary); Image(systemName: "chevron.forward").foregroundStyle(.tertiary) }
          .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
    } header: { Text(model.runTargetLabel) } footer: { Text(model.executionFooter) }
  }

  private func field(_ label: String, value: String, key: String, axis: Axis) -> some View {
    HStack(alignment: axis == .vertical ? .top : .center) {
      Text(label)
      Spacer(minLength: 12)
      TextField(label, text: Binding(get: { value }, set: { store.onFieldChange(key, $0) }), axis: axis)
        .multilineTextAlignment(axis == .vertical ? .leading : .trailing)
        .frame(minWidth: axis == .vertical ? nil : 150, minHeight: 44)
        .accessibilityIdentifier("schedule-field-\(key)")
    }
  }
}

final class NativeScheduleView: ExpoView {
  let onRefresh = EventDispatcher()
  let onRetry = EventDispatcher()
  let onNew = EventDispatcher()
  let onOpen = EventDispatcher()
  let onToggle = EventDispatcher()
  let onBack = EventDispatcher()
  let onFieldChange = EventDispatcher()
  let onPatternPicker = EventDispatcher()
  let onEnabledChange = EventDispatcher()
  let onRunTarget = EventDispatcher()
  let onSave = EventDispatcher()
  let onDelete = EventDispatcher()
  // Hub 顶层件的四个事件。载荷键名是桥契约：`view` / `botId`，空载荷的两个不带字段。
  let onViewChange = EventDispatcher()
  let onSelectBot = EventDispatcher()
  let onNewSession = EventDispatcher()
  let onRetryConnection = EventDispatcher()

  private let store: NativeScheduleStore
  private let host: UIHostingController<NativeSchedulePage>
  private let editorHost: UIHostingController<NativeScheduleEditorPage>

  required init(appContext: AppContext? = nil) {
    let store = NativeScheduleStore()
    self.store = store
    host = UIHostingController(rootView: NativeSchedulePage(store: store))
    editorHost = UIHostingController(rootView: NativeScheduleEditorPage(store: store))
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    editorHost.view.backgroundColor = .clear
    store.onRefresh = { [weak self] in self?.onRefresh([:]) }
    store.onRetry = { [weak self] in self?.onRetry([:]) }
    store.onNew = { [weak self] in self?.onNew([:]) }
    store.onOpen = { [weak self] id in self?.onOpen(["scheduleId": id]) }
    store.onToggle = { [weak self] id, enabled in self?.onToggle(["scheduleId": id, "enabled": enabled]) }
    store.onBack = { [weak self] in self?.onBack([:]) }
    store.onFieldChange = { [weak self] field, value in self?.onFieldChange(["field": field, "value": value]) }
    store.onPatternPicker = { [weak self] in self?.onPatternPicker([:]) }
    store.onEnabledChange = { [weak self] enabled in self?.onEnabledChange(["enabled": enabled]) }
    store.onRunTarget = { [weak self] in self?.onRunTarget([:]) }
    store.onSave = { [weak self] in self?.onSave([:]) }
    store.onDelete = { [weak self] in self?.onDelete([:]) }
    store.onSelectView = { [weak self] id in self?.onViewChange(["view": id]) }
    store.onSelectBot = { [weak self] id in self?.onSelectBot(["botId": id]) }
    store.onNewSession = { [weak self] in self?.onNewSession([:]) }
    store.onRetryConnection = { [weak self] in self?.onRetryConnection([:]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    activeHost().view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, let parent = nearestViewController() else { detachHosts(); return }
    let active = activeHost()
    guard active.parent !== parent || active.view.superview !== self else { return }
    detachHosts()
    parent.addChild(active)
    addSubview(active.view)
    active.didMove(toParent: parent)
    active.view.frame = bounds
  }

  func setMode(_ value: String) { store.mode = MemohAppearanceMode.normalized(value) }
  func setListJSON(_ value: String) { store.setListJSON(value) }
  func setEditorJSON(_ value: String) { store.setEditorJSON(value) }

  private func activeHost() -> UIViewController { store.editor ? editorHost : host }

  private func detachHosts() {
    for controller in [host, editorHost] {
      guard controller.parent != nil || controller.view.superview != nil else { continue }
      controller.willMove(toParent: nil)
      controller.view.removeFromSuperview()
      controller.removeFromParent()
    }
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
