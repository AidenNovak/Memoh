import ExpoModulesCore
import SwiftUI
import UIKit

/// bot 表单三屏（设置 / 新建 / 新建进度）的桥接状态。
///
/// 视图模型由 RN 算好下发（`BotFormModel`）：分组、行序、文案、可用性、危险确认全在 RN。
/// 这里只存模型、存主题模式，并把输入与点击回成事件。
@MainActor
private final class BotFormStore: ObservableObject {
  @Published var model: BotFormModel?
  @Published var mode = "system"

  var onField: (String, String) -> Void = { _, _ in }
  var onAction: (String) -> Void = { _ in }
  var onBack: () -> Void = {}
  var onRetry: () -> Void = {}

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var background: Color { MemohAppearanceMode.formBackground(mode) }

  /// 解析失败就不动界面：宁可停在上一份有效模型上，也不要把表单闪成空白。
  func setModelJSON(_ value: String) {
    guard let decoded = try? BotFormModel.decode(value) else { return }
    model = decoded
  }
}

/// 语气色：封闭集合用 switch，不叠三元（`AGENTS.md`）。
private func toneColor(_ tone: String) -> Color {
  switch tone {
  case "ok": return Color(uiColor: UIColor { MemohPalette.success($0) })
  case "warn": return Color(uiColor: UIColor { MemohPalette.warning($0) })
  case "bad": return Color(uiColor: UIColor { MemohPalette.destructive($0) })
  case "label": return Color(uiColor: UIColor { MemohPalette.label($0) })
  default: return Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) })
  }
}

private struct BotFormPage: View {
  @ObservedObject var store: BotFormStore
  /// 同时只挂一个 .alert（同层多个 alert 在部分系统版本上会互相顶掉）。
  private enum Dialog { case back, delete }
  @State private var dialog: Dialog?

  var body: some View {
    NavigationStack {
      content
        .scrollContentBackground(.hidden)
        .background(store.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarBack }
        .safeAreaInset(edge: .bottom) { saveBar }
        .alert(dialogTitle, isPresented: dialogPresented) {
          dialogButtons
        } message: {
          Text(dialogBody)
        }
    }
    .preferredColorScheme(store.colorScheme)
  }

  private var dialogPresented: Binding<Bool> {
    Binding(
      get: { dialog != nil },
      set: { if !$0 { dialog = nil } }
    )
  }

  private var activeConfirm: BotFormModel.Confirm? {
    switch dialog {
    case .back: return store.model?.backGuard
    case .delete: return store.model?.deleteConfirm
    case .none: return nil
    }
  }

  private var dialogTitle: String { activeConfirm?.title ?? "" }
  private var dialogBody: String { activeConfirm?.body ?? "" }

  @ViewBuilder
  private var dialogButtons: some View {
    if let confirm = activeConfirm {
      Button(confirm.cancelLabel, role: .cancel) {}
      if !confirm.saveLabel.isEmpty {
        Button(confirm.saveLabel) { store.onAction("back:save") }
      }
      Button(confirm.confirmLabel, role: .destructive) {
        switch dialog {
        case .back: store.onAction("back:discard")
        case .delete: store.onAction("delete")
        case .none: break
        }
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbarBack: some ToolbarContent {
    if store.model?.showBack ?? false {
      ToolbarItem(placement: .topBarLeading) {
        Button { backTap() } label: {
          Image(systemName: "chevron.backward")
        }
        .accessibilityLabel(Text(store.model?.title ?? ""))
        .accessibilityIdentifier("bot-form-back")
      }
    }
  }

  /// 有未保存改动就先问一句（文案与选项来自 RN）；没有就直接回。
  private func backTap() {
    if store.model?.backGuard != nil {
      dialog = .back
    } else {
      store.onBack()
    }
  }

  @ViewBuilder
  private var content: some View {
    if let model = store.model, model.status == "error" {
      Form { errorSection(model) }
    } else if let model = store.model, model.status == "ready" {
      Form {
        headerBlock(model)
        ForEach(model.sections) { section in
          formSection(section)
        }
      }
    } else {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  /// 整页错误（读不到）：错误块占内容位置，能不能重试由 RN 判好。
  @ViewBuilder
  private func errorSection(_ model: BotFormModel) -> some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        Text(model.errorTitle).font(.headline)
        if !model.errorBody.isEmpty {
          Text(model.errorBody).font(.footnote).foregroundStyle(.secondary)
        }
        if model.errorCanRetry {
          Button(model.retryLabel) { store.onRetry() }
            .frame(minHeight: 44)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 8)
    }
  }

  /// 页头：有头像就是设置页的"头像 + 标题 + URL 名"行；否则只有标题（新建/进度）。
  /// 不进卡片底色——RN 版它就是飘在表单上方的一行。
  @ViewBuilder
  private func headerBlock(_ model: BotFormModel) -> some View {
    if !model.title.isEmpty {
      Section {
        HStack(spacing: 12) {
          if model.spinner { ProgressView() }
          if let avatar = model.avatar {
            MemohAvatarView(avatar: avatar, size: 44)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(model.title).font(.title2).lineLimit(1)
            if !model.subtitle.isEmpty {
              Text(model.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
          }
          Spacer(minLength: 8)
        }
        .frame(minHeight: 44)
        .listRowBackground(Color.clear)
      }
    }
  }

  @ViewBuilder
  private func formSection(_ section: BotFormModel.Section) -> some View {
    Section {
      ForEach(section.rows) { row in
        rowView(row)
      }
    } header: {
      if !section.header.isEmpty {
        Text(section.header)
          .foregroundStyle(section.danger ? Color(uiColor: UIColor { MemohPalette.destructive($0) }) : .secondary)
      }
    } footer: {
      if !section.footer.isEmpty { Text(section.footer) }
    }
  }

  @ViewBuilder
  private func rowView(_ row: BotFormModel.Row) -> some View {
    switch row.kind {
    case "text": textRow(row)
    case "toggle": toggleRow(row)
    case "radio": radioRow(row)
    case "info": infoRow(row)
    case "button": buttonRow(row)
    case "glyph": glyphRow(row)
    default: navRow(row)
    }
  }

  /// 文本输入行。辅助字号下标签与输入框纵排（RN 用 55% 宽度上限解同一个问题）。
  private func textRow(_ row: BotFormModel.Row) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 12) {
        Text(row.label)
        Spacer(minLength: 8)
        TextField(
          row.placeholder,
          text: Binding(get: { row.value }, set: { store.onField(row.key, $0) })
        )
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: 220)
        .accessibilityIdentifier("\(row.id)-input")
        if row.busy { ProgressView() }
      }
      .frame(minHeight: 44)
      if !row.hint.isEmpty {
        Text(row.hint).font(.footnote).foregroundStyle(.secondary)
      }
    }
    .accessibilityIdentifier(row.id)
  }

  private func toggleRow(_ row: BotFormModel.Row) -> some View {
    Toggle(
      row.label,
      isOn: Binding(get: { row.on }, set: { store.onField(row.key, $0 ? "true" : "false") })
    )
    .frame(minHeight: 44)
    .accessibilityIdentifier(row.id)
  }

  /// 可点行（选择器入口 / 检查汇总 / 重新检查）：标题 + 右侧值 + chevron。
  private func navRow(_ row: BotFormModel.Row) -> some View {
    Button { store.onAction(row.action) } label: {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if !row.glyph.isEmpty {
          Text(row.glyph)
            .foregroundStyle(toneColor(row.tone))
            .accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(row.label)
            .foregroundStyle(row.destructive ? Color(uiColor: UIColor { MemohPalette.destructive($0) }) : Color(uiColor: UIColor { MemohPalette.label($0) }))
          if !row.hint.isEmpty {
            Text(row.hint).font(.footnote).foregroundStyle(.secondary)
          }
        }
        Spacer(minLength: 8)
        if !row.value.isEmpty {
          Text(row.value)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .lineLimit(2)
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
    .disabled(row.disabled)
    .accessibilityIdentifier(row.id)
  }

  /// 单选行（ACL 档位）：选中打勾，语义与模块 2 的语言行一致。
  private func radioRow(_ row: BotFormModel.Row) -> some View {
    Button { store.onField(row.key, row.value) } label: {
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text(row.label)
          if !row.hint.isEmpty {
            Text(row.hint).font(.footnote).foregroundStyle(.secondary)
          }
        }
        Spacer(minLength: 8)
        if row.selected {
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
    .accessibilityIdentifier(row.id)
    .accessibilityAddTraits(row.selected ? .isSelected : [])
  }

  /// 只读信息行（URL 名 / 技术细节原文）。等宽正文可选中（排障复制）。
  private func infoRow(_ row: BotFormModel.Row) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      if !row.label.isEmpty {
        Text(row.label)
      }
      if row.mono {
        Text(row.value)
          .font(.footnote.monospaced())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      } else {
        Text(row.value).foregroundStyle(.secondary)
      }
      if !row.hint.isEmpty {
        Text(row.hint).font(.footnote).foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(minHeight: 44)
    .accessibilityIdentifier(row.id)
  }

  /// 动作行（删除 / 提交 / 复制 / 重试 / 完成）。删除被原生拦下先弹确认框。
  private func buttonRow(_ row: BotFormModel.Row) -> some View {
    Button {
      if row.action == "delete", store.model?.deleteConfirm != nil {
        dialog = .delete
      } else {
        store.onAction(row.action)
      }
    } label: {
      Text(row.label)
        .foregroundStyle(row.destructive ? Color(uiColor: UIColor { MemohPalette.destructive($0) }) : Color(uiColor: UIColor { MemohPalette.accent($0) }))
        .frame(maxWidth: .infinity, minHeight: 44)
    }
    .disabled(row.disabled)
    .accessibilityIdentifier(row.id)
  }

  /// 状态符号行（检查明细 / 创建进度阶段）。符号固定 17pt：大字号下它不能长出
  /// 行槽（RN 版同一纪律，见 `BotSettingsScreen` 的 `CheckGlyph`）。
  private func glyphRow(_ row: BotFormModel.Row) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(row.glyph)
        .font(.system(size: 17))
        .foregroundStyle(toneColor(row.tone))
        .frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(row.label)
        if !row.hint.isEmpty {
          Text(row.hint).font(.footnote).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 8)
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(row.id)
  }

  /// 底部吸附保存条：只在 RN 说可见时画（有改动 / 刚存上）。safeAreaInset 会随键盘抬起。
  @ViewBuilder
  private var saveBar: some View {
    if let model = store.model, model.saveBarVisible {
      HStack(spacing: 12) {
        Text(model.saveBarLabel)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Spacer(minLength: 8)
        if !model.saveBarButton.isEmpty {
          Button { store.onAction("save") } label: {
            Text(model.saveBarButton)
              .font(.headline)
              .foregroundStyle(Color(uiColor: UIColor { MemohPalette.onAccent($0) }))
              .padding(.horizontal, 20)
              .frame(minHeight: 44)
              .background(
                Color(uiColor: UIColor { MemohPalette.accent($0) }),
                in: Capsule()
              )
          }
          .disabled(model.saveBarBusy)
          .opacity(model.saveBarBusy ? 0.5 : 1)
          .accessibilityIdentifier("bot-form-save")
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(Color(uiColor: UIColor { MemohPalette.background($0) }))
    }
  }
}

/// bot 表单三屏共用的 Expo 宿主。
final class NativeBotFormView: ExpoView {
  let onField = EventDispatcher()
  let onAction = EventDispatcher()
  let onBack = EventDispatcher()
  let onRetry = EventDispatcher()

  private let store: BotFormStore
  private let host: MemohSwiftUIHost<BotFormPage>

  required init(appContext: AppContext? = nil) {
    let store = BotFormStore()
    self.store = store
    host = MemohSwiftUIHost(rootView: BotFormPage(store: store))
    super.init(appContext: appContext)
    store.onField = { [weak self] key, value in
      self?.onField(["key": key, "value": value])
    }
    store.onAction = { [weak self] action in
      self?.onAction(["action": action])
    }
    store.onBack = { [weak self] in self?.onBack([:]) }
    store.onRetry = { [weak self] in self?.onRetry([:]) }
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

  func setModelJSON(_ value: String) {
    store.setModelJSON(value)
  }
}
