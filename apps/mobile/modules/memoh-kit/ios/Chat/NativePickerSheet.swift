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

 模块 9A3b 把这张 sheet 从"挑一个"扩成三种用法（**还是同一张 sheet、同一套 detents 与滑掉上报**，
 见 spec §1）：`list` / `grid`（挑一个，原样）、`info`（只读信息面板：会话信息、机器面板）、
 `form`（表单：cron 选择器）。后两种的形态说明在 `PickerSheetContract.swift` 的文件头；
 这里只记住一条：**它们仍然只会回上面这几种事件**，`select` 的 `valueJson` 对表单来说是
 "按了哪一颗键/哪一格"（RN 自己序列化好挂在那一颗上）。

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
    select(valueJson: row.valueJson, staysOpen: row.staysOpen)
  }

  /**
   按了表单里的**某一颗具体的按键/格子**（`+` / `−` / 某一天）。

   载荷由 RN 挂在那一颗上（`upValueJson` / `downValueJson` / `chips[].valueJson`），原生
   原样回传——**不替它算方向、也不改载荷里的字段**（见 `PickerSheetContract.swift` 里
   `downValueJson` 的注释）。`staysOpen` 的语义与 `select(_:)` 完全一样：表单里那些"点了
   还要接着改"的按键由 RN 判好，原生只按它办。
   */
  func select(valueJson: String, staysOpen: Bool) {
    guard !settled else { return }
    // 「点了还要继续选」的行（显示更多 / 切换运行目标 / 有问题的 agent 行）：只上报，
    // **不结算也不关**。关不关、结算不结算由 RN 决定（它会更新模型后再下发一份，
    // 或在需要结束时调 `pickerDismiss`）——原生替它决定会让调用方的 await 永远悬着。
    if staysOpen {
      emit(["type": "select", "valueJson": valueJson])
      return
    }
    settled = true
    emit(["type": "select", "valueJson": valueJson])
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

  /// 日期格的列。`.adaptive` 自己决定一行排几格：星期 7 格在手机上正好一行，
  /// 每月 31 格排成 5 行，辅助字号下自动少排几列（不用写死"手机一定是 7 列"）。
  private var chipColumns: [GridItem] {
    [GridItem(.adaptive(minimum: 44), spacing: 8)]
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
      //
      // 例外：**带脚注的分组要画**（`info` 面板靠脚注承载"为什么这一格是空的"——技能一个都
      // 没用过、后端说用量读不到）。判据是"RN 明确给了一段说明"，不是"原生觉得该留一块"。
      ForEach(model.sections.filter { !$0.rows.isEmpty || !$0.footer.isEmpty }) { section in
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
    Section {
      sectionRows(section)
    } header: {
      // 空标题与空脚注都不占位：`Section` 拿到一个空 Text 也会留出那一段间距。
      if !section.header.isEmpty || !section.icon.isEmpty {
        sectionHeader(section)
      }
    } footer: {
      if !section.footer.isEmpty {
        sectionFooter(section)
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
    } else if section.isInfo {
      // 只读面板：一行都不可点（没有任何选择语义，见 `PickerSheetContract.swift` 的文件头）。
      ForEach(section.rows) { row in
        infoRow(row)
      }
    } else if section.isForm {
      ForEach(section.rows) { row in
        formRow(row)
      }
    } else {
      ForEach(section.rows) { row in
        rowView(row)
      }
    }
  }

  /// 分组脚注：RN 已翻好的说明（"没有窗口所以不给百分比"、"读不到用量"…），小号次要灰。
  private func sectionFooter(_ section: PickerSheetModel.Section) -> some View {
    Text(section.footer)
      .font(.footnote)
      .foregroundStyle(SheetColor.tertiary)
      .fixedSize(horizontal: false, vertical: true)
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

  // MARK: - info 布局（只读面板）

  /// `info` 布局的一行。三种画法，**判据都在 RN 那边**：
  ///
  /// - `kind: progress` → 用量行（标签 + 百分比 + 一条条）；
  /// - `valueJson` 非空 → **动作行**（RN 明确给了载荷，说明这一行是要按的："立即压缩"、"看截图"）；
  /// - 其余 → 只读行（没有任何选择语义）。
  @ViewBuilder
  private func infoRow(_ row: PickerSheetModel.Row) -> some View {
    if row.isProgress {
      progressRow(row)
    } else if row.valueJson.isEmpty {
      readOnlyRow(row)
    } else {
      actionRow(row)
    }
  }

  /**
   动作行：只读面板里**唯一可点**的那种行（值那一格不是值，是一个动作）。

   画法与列表行同源（整行可点、按压有底色），只有字色不同：品牌色，因为它是入口而不是一项选择。
   结算与否照旧由 RN 说了算（这些行都是 `staysOpen`：动作的后果要画回这张 sheet 上）。
   */
  private func actionRow(_ row: PickerSheetModel.Row) -> some View {
    Button {
      store.select(row)
    } label: {
      HStack(spacing: 12) {
        Text(row.label).font(.body).foregroundStyle(SheetColor.accent).lineLimit(1)
        Spacer(minLength: 8)
        if !row.detail.isEmpty {
          Text(row.detail).font(.footnote).foregroundStyle(SheetColor.tertiary).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(PickerRowButtonStyle())
    .disabled(row.disabled)
    .opacity(row.disabled ? 0.4 : 1)
    .accessibilityLabel(Text(row.label))
    .accessibilityIdentifier("picker-row-\(row.id)")
  }

  /**
   只读行：`label`（主色）+ `value`（次级色，右对齐）。

   - `detail` 非空时画在 label 下面一行（脚注灰）——RN 拿它承载"这一格为什么是这样"
     那类说明（cron 的预览句、机器面板的补充）。
   - `mono` 为真时值走等宽并**允许长按选中复制**：表达式、镜像名、命名空间都是用户要
     拿去别处用的东西，画成不可选的等宽字等于让他手抄。
   - `tone` 非空时那一行的字换成语气色（RN 判好：无效表达式是危险色、桌面不可用是警告色）。
     没有 `value` 的行（只有一句结论）就把语气落在 label 上，否则颜色会无处可落。
   */
  private func readOnlyRow(_ row: PickerSheetModel.Row) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        if !row.label.isEmpty {
          Text(row.label)
            .font(.body)
            .foregroundStyle(labelColor(row))
            .fixedSize(horizontal: false, vertical: true)
        }
        if !row.detail.isEmpty {
          Text(row.detail)
            .font(.footnote)
            .foregroundStyle(SheetColor.tertiary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      if !row.value.isEmpty {
        Text(row.value)
          .font(row.mono ? .body.monospaced() : .body)
          .foregroundStyle(toneColor(row.tone))
          .multilineTextAlignment(.trailing)
          // 只有等宽的值允许选中：它是要被复制走的（表达式、镜像名、命名空间）。
          .modifier(SelectableIf(row.mono))
      }
    }
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .padding(.vertical, 4)
    // 读屏把这一行读成一句话（"消息数，42"），而不是两个互不相干的文本。
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("picker-row-\(row.id)")
  }

  /**
   用量行：标签 + 百分比文案（`detail`）+ 一条条。

   条的比例是 `value`（0…1 的字符串，RN 算好）；原生**不重算百分比**，也不把缺分母的
   情况补成 0%（"不编数"那条判据在 RN：没有窗口时它干脆不下发这一行，只报绝对值 + 脚注）。
   */
  private func progressRow(_ row: PickerSheetModel.Row) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(row.label).font(.subheadline).foregroundStyle(SheetColor.label)
        Spacer(minLength: 8)
        Text(row.detail).font(.subheadline).foregroundStyle(SheetColor.secondary)
      }
      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule().fill(SheetColor.field)
          Capsule()
            .fill(SheetColor.accent)
            .frame(width: proxy.size.width * progressFraction(row.value))
        }
      }
      .frame(height: 6)
    }
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .padding(.vertical, 4)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(row.label))
    .accessibilityValue(Text(row.detail))
    .accessibilityIdentifier("picker-row-\(row.id)")
  }

  /// 0…1 的字符串 → 比例。认不出的值按 0 画（条空着，而不是画到满——画满会被读成"用光了"）。
  private func progressFraction(_ raw: String) -> Double {
    guard let value = Double(raw) else { return 0 }
    return min(1, max(0, value))
  }

  // MARK: - form 布局（表单）

  /// `form` 布局的一行：按 `kind` 分派。认不出的形态按 `radio` 画（就是现在的列表行）。
  @ViewBuilder
  private func formRow(_ row: PickerSheetModel.Row) -> some View {
    if row.kind == "stepper" {
      stepperRow(row)
    } else if row.kind == "weekday" {
      weekdayRow(row)
    } else if row.kind == "text" {
      textRow(row)
    } else {
      rowView(row)
    }
  }

  /**
   步进行：`−` / 值 / `+`，三件套。

   三段的命中区都是 44pt（AGENTS.md 的硬要求，也是原 RN 页 `StepButton` 的值）。两颗键回的是
   **各自那份**载荷（`downValueJson` / `upValueJson`）——方向是 RN 给的，原生不算。
   */
  private func stepperRow(_ row: PickerSheetModel.Row) -> some View {
    HStack(spacing: 4) {
      Text(row.label).font(.body).foregroundStyle(SheetColor.label).lineLimit(1)
      Spacer(minLength: 8)
      stepButton("−", identifier: "picker-row-\(row.id)-down", disabled: row.disabled) {
        store.select(valueJson: row.downValueJson, staysOpen: row.staysOpen)
      }
      Text(row.value)
        .font(.body.monospaced())
        .foregroundStyle(SheetColor.label)
        .frame(minWidth: 44)
        .accessibilityIdentifier("picker-row-\(row.id)-value")
      stepButton("+", identifier: "picker-row-\(row.id)-up", disabled: row.disabled) {
        store.select(valueJson: row.upValueJson, staysOpen: row.staysOpen)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 44)
  }

  private func stepButton(
    _ glyph: String,
    identifier: String,
    disabled: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Text(glyph)
        .font(.title3)
        .foregroundStyle(SheetColor.accent)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    // 与 RN 版一致：读屏念的就是那颗符号本身。
    .accessibilityLabel(Text(glyph))
    .accessibilityIdentifier(identifier)
  }

  /**
   日期格行：一列可点的格子（星期 7 格、月份 12 格、每月几号 31 格都走这一份）。

   格子的文案与选中态都是 RN 给的（原生不知道"周一"叫什么，也不去拆 `"1,2,3"` 那种串）。
   列数交给 `.adaptive`：窄屏/辅助字号下自己会少排几列，不用写死一个"手机一定是 7 列"。
   */
  private func weekdayRow(_ row: PickerSheetModel.Row) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if !row.label.isEmpty || !row.detail.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          if !row.label.isEmpty {
            Text(row.label).font(.body).foregroundStyle(SheetColor.label)
          }
          Spacer(minLength: 8)
          if !row.detail.isEmpty {
            Text(row.detail).font(.footnote).foregroundStyle(SheetColor.tertiary).lineLimit(1)
          }
        }
      }
      LazyVGrid(columns: chipColumns, alignment: .leading, spacing: 8) {
        ForEach(row.chips) { chip in
          chipCell(row, chip: chip)
        }
      }
    }
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .padding(.vertical, 4)
  }

  /// 一格：选中时品牌色描边 + 品牌淡底，未选中是发丝线描边。选中态**不加勾**（格子小，
  /// 叠一个勾会把字挤掉；与头像网格同一条理由）。
  private func chipCell(
    _ row: PickerSheetModel.Row,
    chip: PickerSheetModel.Row.Chip
  ) -> some View {
    Button {
      store.select(valueJson: chip.valueJson, staysOpen: row.staysOpen)
    } label: {
      Text(chip.label)
        .font(.subheadline)
        .fontWeight(chip.selected ? .semibold : .regular)
        .foregroundStyle(chip.selected ? SheetColor.accent : SheetColor.label)
        .lineLimit(1)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(PickerChipButtonStyle(selected: chip.selected))
    .disabled(row.disabled)
    .opacity(row.disabled ? 0.4 : 1)
    .accessibilityLabel(Text(chip.label))
    .accessibilityAddTraits(chip.selected ? [.isSelected] : [])
    .accessibilityIdentifier("picker-row-\(row.id)-\(chip.id)")
  }

  /// 表单里的受控输入框（`kind: text`）：与底部输入区同一条约定——值由 RN 持有，
  /// 每个击键回一个 `input` 事件，等 RN 重发模型。
  ///
  /// 这里**不画自己的标签行**：`label` 是输入框的无障碍标签，`detail` 是占位符
  /// （RN 侧有需要就把说明放进分组脚注）。
  private func textRow(_ row: PickerSheetModel.Row) -> some View {
    TextField(
      row.label,
      text: Binding(
        get: { row.value },
        set: { store.input($0) }
      ),
      prompt: Text(row.detail).foregroundStyle(SheetColor.tertiary)
    )
    .font(row.mono ? .body.monospaced() : .body)
    .foregroundStyle(SheetColor.label)
    .textInputAutocapitalization(.never)
    .autocorrectionDisabled()
    .padding(.horizontal, 12)
    .frame(minHeight: 44)
    .accessibilityIdentifier("picker-row-\(row.id)")
  }

  /// 只读行 label 的颜色：只有"这一行本身就是一句结论、而 RN 给了语气"时才上色
  /// （机器面板的桌面结论）；其余情况 label 是主色——一行技能名、一行"消息数"不该被画成灰的。
  private func labelColor(_ row: PickerSheetModel.Row) -> Color {
    if row.value.isEmpty && !row.tone.isEmpty {
      return toneColor(row.tone)
    }
    return SheetColor.label
  }

  /// 语气 → 字色。空语气是次级灰（值的默认色）；未知语气也按次级灰画（不猜）。
  private func toneColor(_ tone: String) -> Color {
    switch tone {
    case "destructive": return SheetColor.destructive
    case "success": return PickerToneColor.success
    case "warning": return PickerToneColor.warning
    default: return SheetColor.secondary
    }
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

/// 只在需要时打开文本选中（`mono` 的那几行：表达式、镜像名、命名空间要能长按复制）。
///
/// 为什么是一个小 modifier 而不是就地写 `.textSelection(row.mono ? .enabled : .disabled)`：
/// 那个三元的两支是**不同的类型**（`EnabledTextSelectability` / `DisabledTextSelectability`），
/// 编不过——这类"两个不同的类型选一个"的地方在 SwiftUI 里只能分成两条分支写。
private struct SelectableIf: ViewModifier {
  private let enabled: Bool

  init(_ enabled: Bool) {
    self.enabled = enabled
  }

  @ViewBuilder
  func body(content: Content) -> some View {
    if enabled {
      content.textSelection(.enabled)
    } else {
      content
    }
  }
}

/// 日期格的按压反馈：与上面同一条规则（原 RN 版也是 `selected || pressed ? field : transparent`），
/// 只是把底色收进圆角里——格子有描边，铺一块方角底色会从边框里冒出来。
private struct PickerChipButtonStyle: ButtonStyle {
  let selected: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(
        selected || configuration.isPressed ? SheetColor.field : Color.clear,
        in: RoundedRectangle(cornerRadius: 10)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 10)
          .strokeBorder(
            selected ? SheetColor.accent : SheetColor.separator,
            lineWidth: SheetColor.hairline
          )
      }
  }
}

/// 只读行的两种语气色。
///
/// `SheetColor`（在 `ChatSheets.swift` 里）是三个 sheet 共用的色表，但它只列了审批/提问与
/// 选择器都要用的那几档；成功/警告这两档只有信息面板的语气行用得上，所以先留在这里。
/// 哪天别的 sheet 也要用，再挪进 `SheetColor`（现在挪等于替还没有的需求先扩一次公共面）。
private enum PickerToneColor {
  static var success: Color { Color(uiColor: UIColor { MemohPalette.success($0) }) }
  static var warning: Color { Color(uiColor: UIColor { MemohPalette.warning($0) }) }
}
