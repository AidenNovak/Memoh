import SwiftUI
import UIKit

/// 审批 / ask_user / 通用选择器三个 sheet 的呈现层（SwiftUI 内容 + UIKit 承载）。
///
/// 这三件事在 RN 侧本来是 presented 页（`ui/ApprovalPage.tsx` / `ui/UserInputPage.tsx` /
/// 7 个选择器页），现在改成模块级函数调起的原生 sheet。RN 保留全部状态与判据（什么时候
/// 该出现、点了之后发什么帧、答案长什么样），原生只画 + 把交互回成事件。
///
/// **审批与提问不可滑掉**（`isModalInPresentation`）：run 停在 `waiting_decision` 上，侧滑
/// 关掉它等于让 run 静默挂死，而用户以为自己回应过了——原 RN 文件头第 2 条硬要求。
/// **选择器可滑掉**（`presentPicker`）：它是"挑一个"的瞬时流程，用户想走就走；代价是下滑
/// 关闭必须回一个 `dismissed`（见 `PickerDismissDelegate`）。
///
/// 这里**不 import ExpoModulesCore**：事件出口由模块注册处（`MemohKitModule`）注入，
/// 这个文件只依赖 Foundation/UIKit/SwiftUI + 同模块的 Support 件，便于单独类型检查。
@MainActor
final class ChatSheetPresenter {
  static let shared = ChatSheetPresenter()

  /// 已经在桥上的 sheet（`nil` = 没在）。模型整份替换，所以只需要持有 store 与它的宿主。
  private var approvalStore: ApprovalSheetStore?
  private var approvalController: UIHostingController<ApprovalSheetView>?
  private var userInputStore: UserInputSheetStore?
  private var userInputController: UIHostingController<UserInputSheetView>?
  private var pickerStore: PickerSheetStore?
  private var pickerController: UIHostingController<PickerSheetView>?
  /// `sheet.delegate` 是 weak，所以这份 delegate 得由这里强持有（下滑关闭的上报口）。
  private var pickerDismissDelegate: PickerDismissDelegate?

  /**
   正在消失的 sheet。

   `dismiss` 的动画期间 `presentedViewController` 还指着它；此时若紧接着来下一份审批
   （拒绝之后 agent 再问一次是常事），`topViewController()` 会选中这一层，新 sheet 就挂在
   一个马上要消失的宿主上。所以记住它们，找宿主时停在它们的呈现者这一层。
   */
  private var departing: [UIViewController] = []

  // MARK: - 审批

  func presentApproval(_ json: String, emit: @escaping ([String: Any]) -> Void) {
    // 坏 JSON 不动界面：宁可停在上一份有效模型上，也不要把 sheet 闪成空白
    // （先例见 `Schedule/NativeScheduleView.swift` 的 `setListJSON`）。
    guard let model = try? ApprovalSheetModel.decode(json) else { return }

    if let store = approvalStore, approvalController != nil {
      // 幂等：sheet 已经在，只换模型让它重渲染（不重复 present）。
      store.emit = emit
      store.model = model
      return
    }

    guard let host = topViewController() else { return }
    let store = ApprovalSheetStore(model: model, emit: emit)
    let controller = UIHostingController(rootView: ApprovalSheetView(store: store))
    controller.view.backgroundColor = .clear
    configureSheet(controller)
    approvalStore = store
    approvalController = controller
    host.present(controller, animated: true)
  }

  func dismissApproval() {
    guard let controller = approvalController else { return }
    approvalController = nil
    approvalStore = nil
    dismissSheet(controller)
  }

  // MARK: - ask_user

  func presentUserInput(_ json: String, emit: @escaping ([String: Any]) -> Void) {
    guard let model = try? UserInputSheetModel.decode(json) else { return }

    if let store = userInputStore, userInputController != nil {
      store.emit = emit
      store.model = model
      return
    }

    guard let host = topViewController() else { return }
    let store = UserInputSheetStore(model: model, emit: emit)
    let controller = UIHostingController(rootView: UserInputSheetView(store: store))
    controller.view.backgroundColor = .clear
    configureSheet(controller)
    userInputStore = store
    userInputController = controller
    host.present(controller, animated: true)
  }

  func dismissUserInput() {
    guard let controller = userInputController else { return }
    userInputController = nil
    userInputStore = nil
    dismissSheet(controller)
  }

  // MARK: - 通用选择器

  /// 7 个选择器页共用的那张 sheet。**可滑掉**：与审批/提问相反，滑掉不是错误——它是"算了"。
  ///
  /// 事件出口与收尾动作都注入进 store：内容层不认识 presenter，只认识"回事件"与"关掉自己"。
  func presentPicker(_ json: String, emit: @escaping ([String: Any]) -> Void) {
    // 坏 JSON 不画界面（先例见 `presentApproval`）。但这里**必须给一个结论**：RN 那边正
    // await 着这张 sheet，既没有 sheet 也没有事件的话，那一行调用点会永远等下去
    // （点胶囊看起来像没反应）。回一个 `dismissed` 就是"没得选"——与 RN 侧"桥不在时按
    // cancelled 处理"是同一条约定（见 `lib/presentation/nativePicker.ts` 文件头）。
    guard let model = try? PickerSheetModel.decode(json) else {
      emit(["type": "dismissed"])
      return
    }

    if let store = pickerStore, pickerController != nil {
      // 幂等：sheet 已经在，只换模型（RN 每次搜索/刷新都重发一份），不重复 present。
      store.emit = emit
      store.model = model
      return
    }

    // 没有可挂的宿主（窗口还没就绪）：同上，给结论而不是让调用方干等。
    guard let host = topViewController() else {
      emit(["type": "dismissed"])
      return
    }
    let store = PickerSheetStore(model: model, emit: emit) { [weak self] in
      // 选中之后自动关：收尾与"回 dismissed"无关，所以走 dismissPicker（它会先 settle）。
      self?.dismissPicker()
    }
    let controller = UIHostingController(rootView: PickerSheetView(store: store))
    controller.view.backgroundColor = .clear
    configurePickerSheet(controller)
    pickerStore = store
    pickerController = controller
    host.present(controller, animated: true)
  }

  /// 只换模型（搜索过滤、加载完成、保存失败重画……）。sheet 不在就什么都不做——
  /// 迟到的更新不该把一张已经关掉的 sheet 又拉起来。
  func updatePicker(_ json: String) {
    guard let store = pickerStore, pickerController != nil else { return }
    guard let model = try? PickerSheetModel.decode(json) else { return }
    store.model = model
  }

  /// 由 RN 关掉（选中之后、或调用方不再需要这张 sheet）。
  ///
  /// 先 `settle()` 再关：这不是"用户滑掉了"，不该再回一个 `dismissed`——RN 那边这个
  /// promise 已经（或即将）由 `select` / 调用方自己了结。
  func dismissPicker() {
    guard let controller = pickerController else { return }
    pickerStore?.settle()
    pickerController = nil
    pickerStore = nil
    dismissSheet(controller)
  }

  // MARK: - 承载

  /// detent + 抓手 + 不可滑掉：内容高度不固定（工具入参可能很长），半屏够看清工具名与
  /// 按钮，长了往上一拖就是全屏。抓手只用来在 detent 之间拖动，不是"关掉"的暗示。
  private func configureSheet(_ controller: UIViewController) {
    guard let sheet = controller.sheetPresentationController else { return }
    sheet.detents = [.medium(), .large()]
    sheet.prefersGrabberVisible = true
    controller.isModalInPresentation = true
  }

  /// 选择器的承载：与审批同一套 detent 与抓手，两处不同——
  ///
  /// 1. **可滑掉**（`isModalInPresentation = false`）：它是"挑一个"的瞬时流程。
  /// 2. 挂一个 delegate：用户下滑关掉时拿 `presentationControllerDidDismiss` 回一个
  ///    `dismissed`（见 `PickerDismissDelegate`）。
  private func configurePickerSheet(_ controller: UIViewController) {
    guard let sheet = controller.sheetPresentationController else { return }
    sheet.detents = [.medium(), .large()]
    sheet.prefersGrabberVisible = true
    let delegate = PickerDismissDelegate { [weak self] in self?.pickerDidDismiss() }
    sheet.delegate = delegate
    pickerDismissDelegate = delegate
    controller.isModalInPresentation = false
  }

  /// 用户下滑关掉：上报一次（由 store 防重复），然后把这一份收干净。
  private func pickerDidDismiss() {
    guard pickerController != nil else { return }
    pickerStore?.reportDismissOnce()
    pickerController = nil
    pickerStore = nil
    pickerDismissDelegate = nil
  }

  private func dismissSheet(_ controller: UIViewController) {
    // 没在呈现（RN 连调两次，或 present 还没落地）就什么都不用做。
    guard controller.presentingViewController != nil else { return }
    departing.append(controller)
    controller.dismiss(animated: true)
  }

  /// 最上层的 view controller：key window → rootViewController → 沿 `presentedViewController`
  /// 走到底。正在消失的 sheet 不再往下走（见 `departing`）。
  private func topViewController() -> UIViewController? {
    departing.removeAll { $0.presentingViewController == nil }

    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    guard var controller = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController else {
      return nil
    }
    while let presented = controller.presentedViewController {
      if departing.contains(where: { $0 === presented }) { break }
      controller = presented
    }
    return controller
  }
}

/**
 用户下滑关掉选择器：这是"取消"，必须回一个 `dismissed`。

 不回的话 RN 那边这次 `presentNativePicker` 的 promise 永远不解决，调用方一直等在那儿
 ——界面看起来像点了没反应。审批/提问不可滑掉，所以它们不需要这一段。

 与 `onDisappear` 是**两条路**（交互关闭时两条都会到）：重复上报由 store 的 `settled`
 挡掉，谁先到谁算。

 单独一个 NSObject 子类，而不是让 `ChatSheetPresenter` 自己实现协议：那个类是审批/提问
 共用的承载，不值得为了这一件事把 NSObject 继承搅进它（`sheet.delegate` 是 weak，所以
 这里必须有人强持有）。
 */
@MainActor
final class PickerDismissDelegate: NSObject, UISheetPresentationControllerDelegate {
  private let onDismiss: () -> Void

  init(onDismiss: @escaping () -> Void) {
    self.onDismiss = onDismiss
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onDismiss()
  }
}

/// 审批 sheet 的桥接状态。只有事件出口需要可写（模型整份替换）。
@MainActor
private final class ApprovalSheetStore: ObservableObject {
  @Published var model: ApprovalSheetModel
  var emit: ([String: Any]) -> Void

  init(model: ApprovalSheetModel, emit: @escaping ([String: Any]) -> Void) {
    self.model = model
    self.emit = emit
  }
}

/// ask_user sheet 的桥接状态。
@MainActor
private final class UserInputSheetStore: ObservableObject {
  @Published var model: UserInputSheetModel
  var emit: ([String: Any]) -> Void

  init(model: UserInputSheetModel, emit: @escaping ([String: Any]) -> Void) {
    self.model = model
    self.emit = emit
  }
}

/// sheet 里用到的颜色。
///
/// sheet 没有主题模式下发（呈现层不认识 RN 的 `mode`，模块注册的函数只带 JSON），所以取色
/// 跟随系统外观：动态 `UIColor` 会跟着 sheet 自己的 appearance 走。
///
/// 内部可见：选择器那张 sheet（`NativePickerSheet.swift`）与审批/提问是同一个家族的
/// 承载，取色必须同一份——各抄一份色表迟早会漂成两种灰。
enum SheetColor {
  static var label: Color { Color(uiColor: UIColor { MemohPalette.label($0) }) }
  static var secondary: Color { Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }) }
  static var separator: Color { Color(uiColor: UIColor { MemohPalette.separator($0) }) }
  static var destructive: Color { Color(uiColor: UIColor { MemohPalette.destructive($0) }) }
  static var accent: Color { Color(uiColor: UIColor { MemohPalette.accent($0) }) }
  static var onAccent: Color { Color(uiColor: UIColor { MemohPalette.onAccent($0) }) }
  static var card: Color { Color(uiColor: UIColor { MemohPalette.card($0) }) }

  /// 品牌淡底：选择器的网格格子用它（RN `accentSoft`，同 `BotAvatar` 的方块底）。
  static var accentSoft: Color { Color(uiColor: UIColor { MemohPalette.accentSoft($0) }) }

  /// RN `field`：与 `MemohPalette.inset` 同值（浅色 `#F4F4F4` / 深色 `#242424`）。
  static var field: Color { Color(uiColor: UIColor { MemohPalette.inset($0) }) }

  /// RN `groupedBackground`：原生侧同一个槽位是 `MemohPalette.background`
  /// （`MemohAppearanceMode.formBackground` 也是这么映射的）。
  static var groupedBackground: Color { Color(uiColor: UIColor { MemohPalette.background($0) }) }

  /// RN `tertiaryLabel` / `placeholder`（比次要文字更淡的灰）。MemohPalette 没有这一档，
  /// 用系统的分层灰——同一个语义，且不在视图里自造色值。
  static var tertiary: Color { Color(uiColor: .tertiaryLabel) }

  /// 描边宽度，与 `Authentication/NativeLoginView.swift` 的 hairline 一致。
  static let hairline: CGFloat = 0.5
}

/// 审批内容（纯展示）：一份审批 + 回 `{optionId, reason}`。
private struct ApprovalSheetView: View {
  @ObservedObject var store: ApprovalSheetStore
  /// 正在填拒绝理由的那一项；`nil` = 还在选项列表上。理由**不过桥**，只是这一步的本地状态。
  @State private var rejectingId: String?
  @State private var reason = ""
  @FocusState private var reasonFocused: Bool
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var model: ApprovalSheetModel { store.model }

  /// 这一步还在不在：模型被换掉后那个 id 可能已经不存在了，那时回到选项列表。
  private var rejecting: ApprovalSheetModel.Option? {
    model.options.first { $0.id == rejectingId }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(model.title).font(.title3).foregroundStyle(SheetColor.label)
        Text(model.subtitle).font(.subheadline).foregroundStyle(SheetColor.secondary)
        toolBlock
        if let option = rejecting {
          rejectStep(option)
        } else {
          options
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityIdentifier("approval-sheet")
    // 同一份 sheet 换模型（审批被解决或被替换）时把本地那一步收回来：不能带着上一份
    // 审批的理由画下一份。
    .onChange(of: model) { _, _ in
      rejectingId = nil
      reason = ""
    }
  }

  /// 工具块：哪个工具、要做什么。用户在外面用手机点"允许"，必须能看清自己批准的是什么。
  /// 工具名与入参同处一块，不给"Tool"再开一行小标题——它只是把下面的内容又标了一遍。
  @ViewBuilder
  private var toolBlock: some View {
    if !model.toolName.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Text(model.toolName).font(.callout).foregroundStyle(SheetColor.label)
        if !model.toolInput.isEmpty {
          ScrollView(.vertical) {
            Text(model.toolInput)
              .font(.footnote.monospaced())
              .foregroundStyle(SheetColor.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(maxHeight: 160)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(SheetColor.groupedBackground, in: RoundedRectangle(cornerRadius: 12))
      .padding(.top, 8)
    }
  }

  @ViewBuilder
  private var options: some View {
    VStack(spacing: 8) {
      ForEach(model.options) { option in
        let style = toneStyle(option.tone)
        Button {
          choose(option)
        } label: {
          Text(option.label)
            .font(.headline)
            .foregroundStyle(style.foreground)
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(style.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
          if style.bordered {
            RoundedRectangle(cornerRadius: 12).strokeBorder(SheetColor.separator, lineWidth: SheetColor.hairline)
          }
        }
        .accessibilityIdentifier("approval-option-\(option.id)")
      }
    }
    .padding(.top, 12)
  }

  /// 第二步：写理由。取消回到选项列表。
  @ViewBuilder
  private func rejectStep(_ option: ApprovalSheetModel.Option) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.rejectReasonLabel).font(.subheadline).foregroundStyle(SheetColor.secondary)

      // 单行 + Done：理由通常就一句话，而多行输入在手机上会把"拒绝"那颗按钮顶到键盘后面；
      // Done 也让用户有一条明确的收起键盘的路（不必去点别处）。
      TextField(
        model.rejectReasonLabel,
        text: $reason,
        prompt: Text(model.rejectReasonPlaceholder).foregroundStyle(SheetColor.tertiary)
      )
      .font(.body)
      .foregroundStyle(SheetColor.label)
      .focused($reasonFocused)
      .submitLabel(.done)
      .onSubmit { reasonFocused = false }
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .background(SheetColor.groupedBackground, in: RoundedRectangle(cornerRadius: 12))
      .accessibilityIdentifier("approval-reject-reason")

      // 并排不只是照抄 RN：半屏 sheet 减去键盘只剩 ~130pt 可视，竖排时下面那颗会落到键盘
      // 底下。辅助字号下并排会挤死，那种尺寸退回纵排。
      if dynamicTypeSize.isAccessibilitySize {
        VStack(spacing: 8) {
          rejectCancelButton
          rejectConfirmButton(option)
        }
      } else {
        HStack(spacing: 8) {
          rejectCancelButton
          rejectConfirmButton(option)
        }
      }
    }
    .padding(.top, 12)
  }

  private var rejectCancelButton: some View {
    Button {
      rejectingId = nil
      reason = ""
    } label: {
      Text(model.cancelLabel)
        .font(.headline)
        .foregroundStyle(SheetColor.accent)
        .frame(maxWidth: .infinity, minHeight: 48)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("approval-reject-cancel")
  }

  private func rejectConfirmButton(_ option: ApprovalSheetModel.Option) -> some View {
    Button {
      // 理由随帧发给服务端，模型据此知道该换个做法；不写理由它只看到"被拒绝了"。
      store.emit(["optionId": option.id, "reason": reason])
    } label: {
      Text(model.rejectConfirmLabel)
        .font(.headline)
        .foregroundStyle(SheetColor.destructive)
        .frame(maxWidth: .infinity, minHeight: 48)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
    .accessibilityIdentifier("approval-reject-confirm")
  }

  /// 语气 → 三档样式。未知语气按中性画：不把它猜成"允许"。
  private func toneStyle(_ tone: String) -> (background: Color, foreground: Color, bordered: Bool) {
    switch tone {
    case "allow": return (SheetColor.accent, SheetColor.onAccent, false)
    case "reject": return (SheetColor.field, SheetColor.destructive, false)
    default: return (SheetColor.card, SheetColor.label, true)
    }
  }

  /// 拒绝是两步：先问一句理由（点了拒绝不是直接拒掉，而是先问一句）。其余语气直接回。
  private func choose(_ option: ApprovalSheetModel.Option) {
    if option.tone == "reject" {
      reason = ""
      rejectingId = option.id
      return
    }
    store.emit(["optionId": option.id, "reason": ""])
  }
}

/// 提问内容（纯展示）：画 agent 给的问题与草稿 + 回事件。
private struct UserInputSheetView: View {
  @ObservedObject var store: UserInputSheetStore

  private var model: UserInputSheetModel { store.model }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(model.title).font(.title3).foregroundStyle(SheetColor.label)
        Text(model.subtitle).font(.subheadline).foregroundStyle(SheetColor.secondary)

        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(model.questions.enumerated()), id: \.element.id) { index, question in
            questionBlock(question, isFirst: index == 0)
          }
        }

        VStack(spacing: 8) {
          footerField
          submitButton
          cancelButton
        }
        .padding(.top, 12)
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityIdentifier("user-input-sheet")
  }

  @ViewBuilder
  private func questionBlock(_ question: UserInputSheetModel.Question, isFirst: Bool) -> some View {
    let draft = model.draft(question.id)
    VStack(alignment: .leading, spacing: 0) {
      if !isFirst {
        Rectangle()
          .fill(SheetColor.separator)
          .frame(height: SheetColor.hairline)
          .padding(.top, 16)
          .padding(.bottom, 12)
      }

      Text(question.text).font(.callout).foregroundStyle(SheetColor.label)
      if question.required {
        Text(model.requiredLabel)
          .font(.caption2)
          .foregroundStyle(SheetColor.secondary)
          .padding(.top, 2)
      }

      if question.kind != "text", !question.options.isEmpty {
        VStack(spacing: 4) {
          ForEach(question.options) { option in
            UserInputOptionRow(
              label: option.label,
              description: option.description,
              selected: draft.optionIds.contains(option.id),
              identifier: "user-input-option-\(question.id)-\(option.id)"
            ) {
              store.emit(["type": "toggleOption", "questionId": question.id, "optionId": option.id])
            }
          }
          // "其他"是一个要显式选中的入口；单问题表单用底部输入框，不重复给这一行。
          if question.allowCustom, !model.footerInput {
            UserInputOptionRow(
              label: model.otherLabel,
              description: "",
              selected: draft.customSelected,
              identifier: "user-input-other-\(question.id)"
            ) {
              store.emit(["type": "toggleCustom", "questionId": question.id])
            }
          }
        }
        .padding(.top, 8)
      }

      if let binding = inlineBinding(question, draft: draft) {
        TextField(
          question.text,
          text: binding,
          prompt: Text(question.placeholder).foregroundStyle(SheetColor.tertiary)
        )
        .font(.body)
        .foregroundStyle(SheetColor.label)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .background(SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// 单问题表单的底部输入框：文本题在这里作答；允许自定义的单选在这里写"其他"——
  /// 不需要先点一下 Other。是不是单问题、该不该用底部框，都是 RN 判好的。
  @ViewBuilder
  private var footerField: some View {
    if model.footerInput, let question = model.questions.first {
      TextField(
        question.text,
        text: Binding(
          get: { model.draft(question.id).text },
          set: { store.emit(["type": "footerText", "text": $0]) }
        ),
        prompt: Text(model.footerPlaceholder).foregroundStyle(SheetColor.tertiary),
        axis: .vertical
      )
      .lineLimit(1...5)
      .font(.body)
      .foregroundStyle(SheetColor.label)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(minHeight: 44)
      .background(SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
    }
  }

  private var submitButton: some View {
    Button {
      store.emit(["type": "submit"])
    } label: {
      Text(model.submitLabel)
        .font(.headline)
        .foregroundStyle(model.canSubmit ? SheetColor.onAccent : SheetColor.tertiary)
        .frame(maxWidth: .infinity, minHeight: 48)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(model.canSubmit ? SheetColor.accent : SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
    // 能不能提交由 RN 判（`buildAnswers`）；原生只按它画可用态，不自己算答案。
    .disabled(!model.canSubmit)
    .accessibilityIdentifier("user-input-submit")
  }

  private var cancelButton: some View {
    Button {
      store.emit(["type": "cancel"])
    } label: {
      Text(model.cancelLabel)
        .font(.headline)
        .foregroundStyle(SheetColor.destructive)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
    .accessibilityIdentifier("user-input-cancel")
  }

  /// 多问题表单里每个问题自带的输入框：文本题始终给；选择题只有用户真的选了"其他"才给
  /// （选之前给输入框会让人以为可以既选项又写字，而单选下服务端只收一个）。单问题表单
  /// 交给底部输入框，这里不出输入框。
  private func inlineBinding(
    _ question: UserInputSheetModel.Question,
    draft: UserInputSheetModel.Draft
  ) -> Binding<String>? {
    if model.footerInput { return nil }
    if question.kind == "text" { return textBinding(question) }
    if question.allowCustom, draft.customSelected { return textBinding(question) }
    return nil
  }

  /// 题内输入框是**受控**的：值来自 RN 下发的草稿，每个击键回一个 `setText`。
  private func textBinding(_ question: UserInputSheetModel.Question) -> Binding<String> {
    Binding(
      get: { model.draft(question.id).text },
      set: { store.emit(["type": "setText", "questionId": question.id, "text": $0]) }
    )
  }
}

/// 一行选项。形状照系统表单：整行可点、选中态用品牌色描边而不是自绘对勾。
private struct UserInputOptionRow: View {
  let label: String
  let description: String
  let selected: Bool
  let identifier: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 2) {
        Text(label).font(.subheadline).foregroundStyle(SheetColor.label)
        if !description.isEmpty {
          Text(description).font(.caption2).foregroundStyle(SheetColor.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(
      selected ? SheetColor.field : SheetColor.groupedBackground,
      in: RoundedRectangle(cornerRadius: 12)
    )
    .overlay {
      RoundedRectangle(cornerRadius: 12)
        .strokeBorder(selected ? SheetColor.accent : SheetColor.separator, lineWidth: SheetColor.hairline)
    }
    // 多选是 checkbox、单选是 radio；两者的"选中"语义在无障碍树里都是 selected。
    .accessibilityAddTraits(selected ? [.isSelected] : [])
    .accessibilityIdentifier(identifier)
  }
}
