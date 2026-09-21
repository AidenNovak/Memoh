import SwiftUI
import UIKit

/**
 通用选择器 sheet 的桥接状态与内容。

 这一份与 `ChatSheets.swift` 里的审批/提问**共用同一套呈现机制**（`ChatSheetPresenter`：
 找最上层 VC、detents、抓手、幂等 present），差别只有两处，都是刻意的：

 | | 审批 / 提问 | 选择器 |
 | --- | --- | --- |
 | 滑掉 | 不可（`isModalInPresentation`）—— run 在等回应 | 可（`false`）—— "挑一个"是瞬时流程，用户想走就走 |
 | 滑掉之后 | 不用上报（滑不掉） | **必须**回 `{"type":"dismissed"}`，否则 RN 那边的 promise 永远悬着 |

 事件（原生 → RN，全部经 `ChatSheetPresenter.presentPicker(_:emit:)` 注入的出口）：

 | 时机 | 事件 |
 | --- | --- |
 | 点一行 | `{"type":"select","valueJson":"<不透明字符串>"}`，随后自动关掉 |
 | 底部输入框提交 | `{"type":"submit","text":"…"}`（**不自动关**，见 `submit()`） |
 | 底部输入框击键 | `{"type":"input","text":"…"}`（受控） |
 | 搜索框击键 | `{"type":"search","text":"…"}` |
 | 错误态点重试 | `{"type":"retry"}` |
 | 用户下滑关闭 | `{"type":"dismissed"}`（只回一次） |

 这里**不 import ExpoModulesCore**：事件出口由模块注册处注入，本文件只依赖
 Foundation/UIKit/SwiftUI + 同模块的 Support 件，便于单独类型检查。
 */

/// 选择器 sheet 的桥接状态。模型整份替换（RN 每次过滤/刷新都重发一份），只有事件出口与
/// 收尾动作可写。
@MainActor
final class PickerSheetStore: ObservableObject {
  @Published var model: PickerSheetModel
  var emit: ([String: Any]) -> Void

  /**
   这一份 sheet 是不是已经有结论了。

   收尾有两条路（用户滑掉走 `presentationControllerDidDismiss`，其余走 `onDisappear`），
   两条都会到 `reportDismissOnce()`。选中之后自动关掉时 `onDisappear` 同样会触发——那时
   再回一个 `dismissed` 就等于把"选了 A"又改口成"取消了"。所以用这一个标记挡第二次。
   */
  private var settled = false

  /// 收尾动作（选中之后自动关掉）。由 presenter 注入：内容层不认识 presenter，只认识这件事。
  private let finish: () -> Void

  init(model: PickerSheetModel, emit: @escaping ([String: Any]) -> Void, finish: @escaping () -> Void) {
    self.model = model
    self.emit = emit
    self.finish = finish
  }

  /// 点了一行：回值 → 关掉。`valueJson` 原样回传，原生不解析它。
  func select(_ row: PickerSheetModel.Row) {
    guard !settled else { return }
    // 「点了还要继续选」的行（显示更多 / 切换运行目标 / 有问题的 agent 行）：只上报，
    // **不结算也不关**。关不关、结算不结算由 RN 决定（它会更新模型后再下发一份，
    // 或在需要结束时调 `pickerDismiss`）——原生替它决定会让调用方的 await 永远悬着。
    if row.staysOpen {
      emit(["type": "select", "valueJson": row.valueJson])
      return
    }
    settled = true
    emit(["type": "select", "valueJson": row.valueJson])
    finish()
  }

  /**
   提交底部输入框。

   **不在这里收尾**：RenameSession 那条路提交之后要发 PATCH，保存中（转圈）与保存失败
   （错误提示）都还得画在这张 sheet 上（`ui/RenameSessionPage.tsx` 就是这样）。关不关由
   RN 用 `dismissPicker` 说了算，原生不替它决定。
   */
  func submit() {
    guard !settled else { return }
    emit(["type": "submit", "text": model.input?.value ?? ""])
  }

  /// 输入框击键：**受控**——值由 RN 持有，这里只回事件，等 RN 重发模型。
  func input(_ text: String) {
    guard !settled else { return }
    emit(["type": "input", "text": text])
  }

  /// 搜索框击键：RN 过滤后重发 sections（原生不做过滤）。
  func search(_ text: String) {
    guard !settled else { return }
    emit(["type": "search", "text": text])
  }

  /// 错误态点重试：能不能重试是 RN 的判据，原生只把这一下回上去。
  func retry() {
    guard !settled else { return }
    emit(["type": "retry"])
  }

  /// 用户下滑关掉：这是"取消"，只回一次。
  func reportDismissOnce() {
    guard !settled else { return }
    settled = true
    emit(["type": "dismissed"])
  }

  /// 由选中或 RN（`dismissPicker`）触发的关闭：这不是"用户滑掉了"，不再回 `dismissed`。
  func settle() {
    settled = true
  }
}

/// 选择器内容（纯展示）：画分组与行，把交互回成事件。
struct PickerSheetView: View {
  @ObservedObject var store: PickerSheetStore

  /**
   搜索框的当前文字。

   **本地状态，不是从模型来的**：契约里没有承载"当前搜索词"的字段（§2 只有
   `searchPlaceholder`），所以这个值无法由 RN 回灌。RN 那半边本来也是自己 `useState`
   持有搜索词、自己过滤（`filterSections`）后重发 sections——两边的分工没有变：这里只
   负责"用户敲了什么"这一件事，并把每次击键回成 `search` 事件。
   */
  @State private var query = ""

  /// 辅助字号下网格列数要收：5 列时每格只剩几十点，字一放大就挤成一团。
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var model: PickerSheetModel { store.model }

  private var hasSearch: Bool { !model.searchPlaceholder.isEmpty }

  private var gridColumns: [GridItem] {
    let count = dynamicTypeSize.isAccessibilitySize ? 3 : 5
    return Array(repeating: GridItem(.flexible(), spacing: 8), count: count)
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      content
      if let input = model.input {
        inputArea(input)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(SheetColor.groupedBackground)
    .accessibilityIdentifier("picker-sheet")
    // 收尾的另一条路：用户滑掉时 `presentationControllerDidDismiss`（见 ChatSheets.swift）
    // 也会到；谁先到都行，store 只上报一次。
    .onDisappear { store.reportDismissOnce() }
  }

  // MARK: - 顶部

  @ViewBuilder
  private var header: some View {
    if !model.title.isEmpty || hasSearch {
      VStack(alignment: .leading, spacing: 8) {
        if !model.title.isEmpty {
          Text(model.title).font(.title3).foregroundStyle(SheetColor.label)
        }
        if hasSearch {
          searchField
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// 搜索框。标识由 RN 给（模型选择器是 `model-search`，时区是 `timezone-search`……）；
  /// 空串等于不设标识（不是每个选择器都有搜索框）。
  private var searchField: some View {
    TextField(
      model.searchPlaceholder,
      text: $query,
      prompt: Text(model.searchPlaceholder).foregroundStyle(SheetColor.tertiary)
    )
    .font(.body)
    .foregroundStyle(SheetColor.label)
    .textInputAutocapitalization(.never)
    .autocorrectionDisabled()
    .onChange(of: query) { _, text in
      store.search(text)
    }
    .padding(.horizontal, 12)
    .frame(minHeight: 44)
    .background(SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
    .accessibilityIdentifier(model.searchTestID)
  }

  // MARK: - 内容

  @ViewBuilder
  private var content: some View {
    if model.status == "loading" {
      statusBlock {
        ProgressView()
        Text(model.loadingLabel).font(.subheadline).foregroundStyle(SheetColor.secondary)
      }
    } else if model.status == "error" {
      errorBlock
    } else if model.hasRows {
      list
    } else if !model.emptyLabel.isEmpty {
      statusBlock {
        Text(model.emptyLabel).font(.subheadline).foregroundStyle(SheetColor.secondary)
      }
    }
  }

  /// 加载 / 空态：居中一块，占住内容位置（不画成一行小字挂在顶上）。
  private func statusBlock<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(spacing: 8) {
      content()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  /// 整页错误（拉不到目录）：**发生了什么 + 为什么 + 能做什么**三行，占住内容位置。
  ///
  /// 形状照 `ChatBarModel` 的失败块（`NativeChatBarView.slashFailure`）：危险色标题、
  /// 次要色说明、品牌色重试键——这是本仓库里"一块失败长什么样"的既有画法。
  /// 能不能重试由 RN 判好（`retryLabel` 非空才画键，`features/errors/present.ts` 的
  /// `canRetry`）。
  private var errorBlock: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(model.errorTitle)
        .font(.footnote)
        .foregroundStyle(SheetColor.destructive)
        .fixedSize(horizontal: false, vertical: true)
      if !model.errorBody.isEmpty {
        Text(model.errorBody)
          .font(.caption)
          .foregroundStyle(SheetColor.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !model.retryLabel.isEmpty {
        Button {
          store.retry()
        } label: {
          Text(model.retryLabel)
            .font(.footnote)
            .foregroundStyle(SheetColor.accent)
            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(model.retryLabel))
        .accessibilityIdentifier("picker-retry")
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(SheetColor.card, in: RoundedRectangle(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12).strokeBorder(SheetColor.separator, lineWidth: SheetColor.hairline)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  private var list: some View {
    List {
      // 没有行的分组整块不画：头像选择器的自定义那一组在网格下面，RN 清空它时不该留一片空白。
      ForEach(model.sections.filter { !$0.rows.isEmpty }) { section in
        sectionView(section)
      }
    }
    .listStyle(.insetGrouped)
    // insetGrouped 自带的白底会把品牌色盖掉（与 `NativeSessionsView` 同一条处理）。
    .scrollContentBackground(.hidden)
    .background(SheetColor.groupedBackground)
  }

  @ViewBuilder
  private func sectionView(_ section: PickerSheetModel.Section) -> some View {
    if section.header.isEmpty && section.icon.isEmpty {
      Section {
        sectionRows(section)
      }
    } else {
      Section {
        sectionRows(section)
      } header: {
        sectionHeader(section)
      }
    }
  }

  @ViewBuilder
  private func sectionRows(_ section: PickerSheetModel.Section) -> some View {
    if section.isGrid {
      LazyVGrid(columns: gridColumns, spacing: 12) {
        ForEach(section.rows) { row in
          gridCell(row)
        }
      }
      .padding(.vertical, 4)
    } else {
      ForEach(section.rows) { row in
        rowView(row)
      }
    }
  }

  /// 分组标题：厂商标 + 小标题。标题走系统 `Section` header 的画法（小号、次要灰）。
  private func sectionHeader(_ section: PickerSheetModel.Section) -> some View {
    HStack(spacing: 6) {
      sectionIcon(section.icon)
      if !section.header.isEmpty {
        Text(section.header)
      }
    }
  }

  /// 厂商标：按名取包里的图；认不出的给一颗中性 glyph——**不留白**（同 `ui/ProviderIcon.tsx`
  /// 的纪律：自托管用户接任何家，图标表不可能穷举）。单色：与标题同色。
  @ViewBuilder
  private func sectionIcon(_ name: String) -> some View {
    if !name.isEmpty {
      if let asset = MemohAssets.image(named: name) {
        Image(uiImage: asset)
          .renderingMode(.template)
          .resizable()
          .scaledToFit()
          .frame(width: 16, height: 16)
          .foregroundStyle(SheetColor.secondary)
          .accessibilityHidden(true)
      } else {
        Image(systemName: "cube")
          .font(.system(size: 14))
          .foregroundStyle(SheetColor.secondary)
          .accessibilityHidden(true)
      }
    }
  }

  // MARK: - 行

  /// 列表行：可选的行首符号 + 主文案 + 副文案 + 右侧勾。
  private func rowView(_ row: PickerSheetModel.Row) -> some View {
    Button {
      store.select(row)
    } label: {
      HStack(spacing: 12) {
        if !row.symbol.isEmpty {
          Image(systemName: row.symbol)
            .font(.body)
            .foregroundStyle(SheetColor.secondary)
            .frame(width: 22)
            .accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: 1) {
          Text(row.label).font(.body).foregroundStyle(SheetColor.label).lineLimit(1)
          if !row.detail.isEmpty {
            Text(row.detail).font(.footnote).foregroundStyle(SheetColor.tertiary).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        if row.selected {
          Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(SheetColor.accent)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(PickerRowButtonStyle())
    .disabled(row.disabled)
    .opacity(row.disabled ? 0.4 : 1)
    // 读屏要能说出"现在选的是这一行"（否则听一遍整张列表也不知道当前值在哪一项）。
    .accessibilityAddTraits(row.selected ? [.isSelected] : [])
    .accessibilityIdentifier("picker-row-\(row.id)")
  }

  /// 网格格：方形符号块（品牌淡紫底 + 品牌紫符号），选中加一圈描边；下面一行名字。
  ///
  /// 选中态用**描边**而不是勾：这些格子本身是彩色图形，叠一个勾会脏（与
  /// `ui/AvatarPickerPage.tsx` 的 `AvatarTile` 同一条理由）。
  private func gridCell(_ row: PickerSheetModel.Row) -> some View {
    Button {
      store.select(row)
    } label: {
      VStack(spacing: 4) {
        ZStack {
          RoundedRectangle(cornerRadius: 14).fill(SheetColor.accentSoft)
          // 没有符号名时给一颗中性 glyph，不留白（同分组图标的纪律）。
          Image(systemName: row.symbol.isEmpty ? "cube" : row.symbol)
            .font(.system(size: 20))
            .foregroundStyle(SheetColor.accent)
        }
        .frame(width: 48, height: 48)
        .overlay {
          if row.selected {
            RoundedRectangle(cornerRadius: 14).strokeBorder(SheetColor.accent, lineWidth: 2)
          }
        }
        if !row.label.isEmpty {
          Text(row.label).font(.caption2).foregroundStyle(SheetColor.secondary).lineLimit(1)
        }
      }
      // 行高下限：图形 48 + 间距 + 名字（辅助字号下名字会被截断，但格子不会挤死）。
      .frame(minHeight: 56)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(row.disabled)
    .opacity(row.disabled ? 0.4 : 1)
    .accessibilityLabel(Text(row.label))
    .accessibilityAddTraits(row.selected ? [.isSelected] : [])
    .accessibilityIdentifier("picker-row-\(row.id)")
  }

  // MARK: - 底部输入区

  /// 单字段表单（会话重命名、头像自定义网址）：标签 + 受控输入框 + 主按钮。
  private func inputArea(_ input: PickerSheetModel.Input) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if !input.label.isEmpty {
        Text(input.label).font(.footnote).foregroundStyle(SheetColor.secondary)
      }

      // 受控：值来自模型（RN 持有），每个击键回一个 `input` 事件。
      TextField(
        input.label,
        text: Binding(
          get: { store.model.input?.value ?? "" },
          set: { store.input($0) }
        ),
        prompt: Text(input.placeholder).foregroundStyle(SheetColor.tertiary)
      )
      .font(.body)
      .foregroundStyle(SheetColor.label)
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .background(SheetColor.field, in: RoundedRectangle(cornerRadius: 12))
      .accessibilityIdentifier("picker-input")

      Button {
        store.submit()
      } label: {
        Text(input.submitLabel)
          .font(.headline)
          .foregroundStyle(SheetColor.onAccent)
          .frame(maxWidth: .infinity, minHeight: 48)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .background(SheetColor.accent, in: RoundedRectangle(cornerRadius: 12))
      .accessibilityIdentifier("picker-submit")
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// 行的按压反馈：按下时铺一层 `field` 底（RN 版就是 `pressed ? palette.field : transparent`）。
/// 不用 `.plain` 是因为它按下时什么都不画——一张半屏列表里没有反馈会让人以为没点到。
private struct PickerRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(configuration.isPressed ? SheetColor.field : Color.clear)
  }
}
